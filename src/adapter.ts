import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { PhoneUnavailable, verifyPhone, watchPhone, type AvailabilityOptions } from './availability.js'
import * as acp from '@agentclientprotocol/sdk/unstable'
import type { PhoneBackend, PhoneEvent, PhoneSession } from './phone.js'
import { forwardOrdinarySensitive } from './ordinary-input.js'
import { forwardInteractive } from './interactive.js'
import { PhoneOnlyInterview, supportedSecretAsk } from './forms.js'
import { defaultSecretFiles, forwardPrivate, forwardSecretAsk } from './private-input.js'
import type { SecretFiles } from './secret-files.js'

class LocalError extends acp.RequestError {}
const local = (error: acp.RequestError) => new LocalError(error.code, error.message, error.data)
const failureMessage = 'Phone operation failed. Reconnect to the same phone conversation to check its state. No automatic resubmission was attempted.'

interface ActivePrompt {
  requestId: string
  started: boolean
  cancelRequested: boolean
  observer: AbortController
  cancellation?: Promise<void>
  waitingForForms?: boolean
}
interface AttachedSession {
  controller: AbortController
  prompt?: ActivePrompt
  watcher?: { controller: AbortController, done: Promise<void> }
  tools: Set<string>
  approvals: Set<string>
  dialogs: Map<string, AbortController>
  interactiveDialogs: Set<string>
  formQueue: Promise<void>
  privateMcp: boolean
}

/** One ACP connection. All durable session state belongs to the phone. */
export function createAdapter(phone: PhoneBackend, options: {
  secretFiles?: SecretFiles
  secretTimeoutMs?: number
  availability?: AvailabilityOptions
} = {}): acp.AgentApp {
  const secretFiles = options.secretFiles ?? defaultSecretFiles()
  const privateServer = (server: acp.McpServer) => 'type' in server && server.type === 'acp' && server.name === 't3-code' && server.serverId === 't3-code'
  const sessions = new Map<string, AttachedSession>()
  const loading = new Set<string>()
  const lifetime = new AbortController()
  const app = acp.agent({ name: 'pi-phone-acp' })
  let formSupported = false
  let noticeSupported = false
  let ready: Promise<void>

  const safe = async <T>(action: () => Promise<T>): Promise<T> => {
    try { await ready; lifetime.signal.throwIfAborted(); return await action() } catch (error) {
      if (error instanceof LocalError) throw error
      // Backend exceptions, even RequestError instances, may contain secrets.
      throw new acp.RequestError(-32000, failureMessage)
    }
  }
  const session = (id: string) => {
    const attached = sessions.get(id)
    if (!attached) throw local(acp.RequestError.sessionNotFound(id))
    if (loading.has(id)) throw local(acp.RequestError.invalidRequest(undefined, 'Conversation is loading'))
    return attached
  }
  const attach = (native: PhoneSession): AttachedSession => {
    if (!native.id) throw new Error('Invalid native session')
    const attached: AttachedSession = { controller: new AbortController(), tools: new Set(), approvals: new Set(), dialogs: new Map(), interactiveDialogs: new Set(), formQueue: Promise.resolve(), privateMcp: false }
    sessions.set(native.id, attached)
    return attached
  }
  const validateWorkspace = (params: acp.NewSessionRequest | acp.LoadSessionRequest) => {
    if (!isAbsolute(params.cwd)) throw local(acp.RequestError.invalidParams(undefined, 'cwd must be an absolute path'))
    if (params.additionalDirectories?.length) throw local(acp.RequestError.invalidParams(undefined, 'Additional client directories cannot be mounted on the phone.'))
    if (params.systemPrompt) throw local(acp.RequestError.invalidParams(undefined, 'Client system prompts are not supported. Configure instructions on the phone.'))
  }
  const send = async (id: string, update: acp.SessionUpdate, client: acp.AgentContext) => {
    await client.notify(acp.methods.client.session.update, { sessionId: id, update })
  }
  const notice = (id: string, text: string, client: acp.AgentContext, title?: string) => {
    const message = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text
    return send(id, noticeSupported ? {
      sessionUpdate: 'notice', severity: 'info', title: title ?? message,
      ...(title === undefined ? {} : { description: message }),
    } : {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\n${text}\n` },
    }, client)
  }

  const event = async (id: string, attached: AttachedSession, item: PhoneEvent, client: acp.AgentContext, signal: AbortSignal) => {
    if (item.type === 'end') return
    if (item.type === 'approval_withdrawn') {
      attached.dialogs.get(item.id)?.abort()
      attached.dialogs.delete(item.id)
      return
    }
    if (item.type === 'tool') {
      const known = attached.tools.has(item.id)
      attached.tools.add(item.id)
      const fields = {
        toolCallId: item.id, title: item.name, name: item.name, status: item.status,
        ...(item.input === undefined ? {} : { rawInput: item.input }),
        ...(item.output === undefined ? {} : { content: [{ type: 'content' as const, content: { type: 'text' as const, text: item.output } }] }),
      }
      await send(id, known ? { sessionUpdate: 'tool_call_update', ...fields } : { sessionUpdate: 'tool_call', ...fields }, client)
    } else if (item.type === 'approval') {
      if (attached.prompt?.cancelRequested || attached.approvals.has(item.id)) return
      attached.approvals.add(item.id)
      if (item.interactive) {
        const secretAsk = supportedSecretAsk(item.form)
        const privateInput = item.privateForm !== undefined || secretAsk !== undefined
        const supported = item.privateForm ? (attached.privateMcp || formSupported) && !!phone.privateFormCurrent && !!phone.answerPrivate && !!phone.declinePrivate
          : secretAsk ? (attached.privateMcp || formSupported) && !!phone.secretAskCurrent && !!phone.answerSecretAsk && !!phone.declineSecretAsk : formSupported
        if (!supported || (!item.form && !privateInput) || !attached.prompt?.started) {
          const reason = privateInput && !supported ? 'This client lacks a supported input method, or the checked phone consumer is unavailable.'
            : !privateInput && !formSupported ? 'This client did not advertise form support.'
              : !attached.prompt?.started ? 'T3 needs an active prompt turn to show forms; reconnect replay is observation only.'
                : 'This form is sensitive, unknown or malformed, or requires saved phone sign-in choices.'
          await notice(id, `[Phone is waiting for an interactive approval. Complete it in pi-phone. ${reason} Nothing was approved automatically.]`, client, 'Complete this request in pi-phone')
          return
        }
        const dialog = new AbortController()
        attached.dialogs.set(item.id, dialog)
        const questionSignal = AbortSignal.any([signal, dialog.signal])
        attached.interactiveDialogs.add(item.id)
        // Serialize interviews without blocking phone observation/withdrawals.
        attached.formQueue = attached.formQueue.then(async () => {
          try {
            if (questionSignal.aborted) return
            const result = privateInput && !attached.privateMcp
              ? await forwardOrdinarySensitive(phone, id, item, client, questionSignal, { formSupported, privateMcp: attached.privateMcp })
              : item.privateForm
                ? await forwardPrivate(phone, id, { ...item, privateForm: item.privateForm }, client, questionSignal, secretFiles, options.secretTimeoutMs)
                : secretAsk ? await forwardSecretAsk(phone, id, { ...item, form: secretAsk }, client, questionSignal, secretFiles, options.secretTimeoutMs)
                  : await forwardInteractive(phone, id, item, client, questionSignal, { privateMcp: attached.privateMcp, formSupported, secretFiles, secretTimeoutMs: options.secretTimeoutMs })
            if (result === 'phone' && !questionSignal.aborted) await notice(id, '[Interactive question remains on the phone. Complete it in pi-phone. No answer was sent automatically.]', client, 'Complete this question in pi-phone')
          } catch (error) {
            // Even validation exceptions can include answer/credential contents.
            const reason = error instanceof PhoneOnlyInterview ? error.message : 'Could not forward or validate this interactive question; no automatic retry was attempted.'
            const action = error instanceof PhoneOnlyInterview && error.reason === 'private'
              ? 'Complete it in pi-phone. No answer was sent automatically.'
              : 'Complete it in pi-phone. Unsupported content, saved drafts or changed questions are not replaced.'
            const title = error instanceof PhoneOnlyInterview
              ? 'Complete this interview in pi-phone'
              : 'Check this question in pi-phone'
            if (!questionSignal.aborted) await notice(id, `[${reason} ${action}]`, client, title).catch(() => {})
          } finally { attached.dialogs.delete(item.id); attached.interactiveDialogs.delete(item.id) }
        })
        return
      }
      if (!phone.answerApproval) {
        await notice(id, '[Complete this approval in pi-phone.]', client)
        return
      }
      const dialog = new AbortController()
      attached.dialogs.set(item.id, dialog)
      const approvalSignal = AbortSignal.any([signal, dialog.signal])
      // Do not block observation on a UI answer. Disconnecting cancels only the
      // local question and never sends an allow/deny to the phone.
      void (async () => {
        const answer = await client.request(acp.methods.client.session.requestPermission, {
          sessionId: id,
          toolCall: { toolCallId: item.callId, title: `${item.tool}: ${item.subject}`, kind: 'other', content: [{ type: 'content', content: { type: 'text', text: item.reason } }] },
          options: [
            { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'deny', name: 'Deny once', kind: 'reject_once' },
          ],
        }, { cancellationSignal: approvalSignal, stopWaitingOnCancel: true })
        if (approvalSignal.aborted || answer.outcome.outcome !== 'selected') return
        const choice = answer.outcome.optionId
        if (choice !== 'allow' && choice !== 'deny') return
        await phone.answerApproval!(item.id, choice === 'allow', approvalSignal)
      })().catch(async () => {
        if (!approvalSignal.aborted) await notice(id, '[Could not resolve phone approval. Check it in pi-phone.]', client).catch(() => {})
      }).finally(() => attached.dialogs.delete(item.id))
    } else if (item.type === 'notice') {
      await notice(id, item.text, client)
    } else {
      await send(id, {
        sessionUpdate: item.type === 'user' ? 'user_message_chunk' : item.type === 'thought' ? 'agent_thought_chunk' : 'agent_message_chunk',
        content: { type: 'text', text: item.text },
      }, client)
    }
  }

  const stopWatch = async (attached: AttachedSession) => {
    attached.watcher?.controller.abort()
    await attached.watcher?.done
    delete attached.watcher
  }
  const startWatch = (id: string, attached: AttachedSession, client: acp.AgentContext) => {
    if (!phone.observe || lifetime.signal.aborted || attached.watcher) return
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, attached.controller.signal, lifetime.signal])
    const done = (async () => {
      try {
        for await (const item of phone.observe!(id, signal)) {
          signal.throwIfAborted()
          await event(id, attached, item, client, signal)
        }
      } catch {
        if (!signal.aborted) {
          for (const dialog of attached.dialogs.values()) dialog.abort()
          await notice(id, '[Phone observation disconnected. Reload this same conversation to reconnect. Work on the phone was not cancelled.]', client).catch(() => {})
        }
      }
    })()
    attached.watcher = { controller, done }
  }

  app.onConnect(connection => {
    connection.signal.addEventListener('abort', () => lifetime.abort(), { once: true })
    // Initialization and all operations wait for this one startup read. The
    // monitor is connection-scoped, not tied to a conversation or prompt.
    ready = verifyPhone(phone, lifetime.signal, options.availability?.timeoutMs)
    void ready.then(() => watchPhone(phone, lifetime.signal, options.availability)).catch(error => {
      if (lifetime.signal.aborted) return
      const failure = error instanceof PhoneUnavailable ? error : new PhoneUnavailable('unreachable')
      connection.close(failure)
    })
  })
  app.onRequest(acp.methods.agent.initialize, async ({ params }) => {
    if (params.protocolVersion < acp.PROTOCOL_VERSION) throw acp.RequestError.unsupportedProtocolVersion(params.protocolVersion, [acp.PROTOCOL_VERSION])
    try { await ready; lifetime.signal.throwIfAborted() } catch {
      throw new acp.RequestError(-32000, 'Phone API could not be verified. Check adapter diagnostics and phone access.')
    }
    formSupported = params.clientCapabilities?.elicitation?.form != null
    noticeSupported = params.clientCapabilities?.session?.notices != null
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: 'pi-phone-acp', version: '0.1.0' },
      agentCapabilities: { loadSession: true, mcpCapabilities: { acp: true }, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
      authMethods: [],
    }
  })
  app.onRequest(acp.methods.agent.session.new, ({ params, signal, client }) => safe(async () => {
    validateWorkspace(params)
    const native = await phone.create(AbortSignal.any([signal, lifetime.signal]))
    if (sessions.has(native.id)) throw new Error('Phone reused a session ID')
    const attached = attach(native)
    attached.privateMcp = params.mcpServers.some(privateServer)
    if (params.mcpServers.some(server => !privateServer(server))) await notice(native.id, '[Client MCP servers are not connected. Configure tools on the phone. Client-host commands and credentials are not forwarded to Android.]', client)
    startWatch(native.id, attached, client)
    return { sessionId: native.id }
  }))
  app.onRequest(acp.methods.agent.session.load, ({ params, signal, client }) => safe(async () => {
    validateWorkspace(params)
    if (loading.has(params.sessionId) || sessions.get(params.sessionId)?.prompt) throw local(acp.RequestError.invalidRequest(undefined, 'A phone operation is already active for this conversation'))
    loading.add(params.sessionId)
    try {
      const old = sessions.get(params.sessionId)
      if (old) { old.controller.abort(); await stopWatch(old) }
      const detached = AbortSignal.any([signal, lifetime.signal])
      const native = await phone.load(params.sessionId, detached)
      if (native.id !== params.sessionId) throw new Error('Native session mismatch')
      const attached = attach(native)
      attached.privateMcp = params.mcpServers.some(privateServer)
      const replay: readonly PhoneEvent[] = native.replay ?? native.history.map(message => ({ type: message.role === 'user' ? 'user' : 'text', text: message.text }))
      for (const item of replay) await event(native.id, attached, item, client, AbortSignal.any([attached.controller.signal, lifetime.signal]))
      if (params.mcpServers.some(server => !privateServer(server))) await notice(native.id, '[Client MCP servers are not connected. Configure tools on the phone. Client-host commands and credentials are not forwarded to Android.]', client)
      startWatch(native.id, attached, client)
      return {}
    } finally { loading.delete(params.sessionId) }
  }))
  app.onRequest(acp.methods.agent.session.prompt, ({ params, signal, client }) => safe(async () => {
    const attached = session(params.sessionId)
    if (attached.prompt) throw local(acp.RequestError.invalidRequest(undefined, 'A prompt is already active for this conversation'))
    if (params.prompt.some(block => block.type !== 'text')) throw local(acp.RequestError.invalidParams(undefined, 'Only text prompts are supported'))
    const text = params.prompt.map(block => block.type === 'text' ? block.text : '').join('\n')
    if (!text.trim()) throw local(acp.RequestError.invalidParams(undefined, 'Prompt text must not be empty'))
    const active: ActivePrompt = { requestId: randomUUID(), started: false, cancelRequested: false, observer: new AbortController() }
    attached.prompt = active
    const detached = AbortSignal.any([signal, attached.controller.signal, lifetime.signal, active.observer.signal])
    try {
      await stopWatch(attached)
      detached.throwIfAborted()
      if (active.cancelRequested) return { stopReason: 'cancelled' }
      active.started = true
      let terminal: Extract<PhoneEvent, { type: 'end' }> | undefined
      for await (const item of phone.run(params.sessionId, text, active.requestId, detached)) {
        detached.throwIfAborted()
        if (item.type === 'end') { terminal = item; break }
        await event(params.sessionId, attached, item, client, detached)
      }
      if (!terminal) throw new Error('Phone stream ended without a terminal result')
      await active.cancellation
      // Async phone interviews may outlive the phone's model turn. Keep T3's
      // turn open for its UI while observing withdrawals; never restart phone work.
      if (attached.interactiveDialogs.size && terminal.reason !== 'cancelled' && !active.cancelRequested) {
        active.waitingForForms = true
        startWatch(params.sessionId, attached, client)
        while (attached.interactiveDialogs.size && !detached.aborted) await attached.formQueue
      }
      return { stopReason: active.cancelRequested ? 'cancelled' : terminal.reason }
    } finally {
      const keepObserving = !detached.aborted
      active.observer.abort()
      delete attached.prompt
      if (keepObserving) startWatch(params.sessionId, attached, client)
    }
  }))
  app.onNotification(acp.methods.agent.session.cancel, ({ params }) => {
    if (lifetime.signal.aborted) return
    const attached = sessions.get(params.sessionId)
    const active = attached?.prompt
    if (!attached || !active || active.cancelRequested) return
    active.cancelRequested = true
    for (const dialog of attached.dialogs.values()) dialog.abort()
    if (active.waitingForForms) { active.observer.abort(); return }
    if (!active.started) return
    active.cancellation = phone.cancel(params.sessionId, active.requestId)
    void active.cancellation.catch(() => active.observer.abort())
  })
  return app
}
