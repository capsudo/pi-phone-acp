import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import * as acp from '@agentclientprotocol/sdk'
import type { PhoneBackend, PhoneSession } from './phone.js'

interface ActivePrompt {
  requestId: string
  cancellation?: Promise<void>
}

interface AttachedSession {
  prompt?: ActivePrompt
}

/** One ACP connection. All durable session state belongs to the backend. */
export function createAdapter(phone: PhoneBackend): acp.AgentApp {
  const sessions = new Map<string, AttachedSession>()
  const lifetime = new AbortController()
  const app = acp.agent({ name: 'pi-phone-acp' })

  const session = (id: string) => {
    const attached = sessions.get(id)
    if (!attached) throw acp.RequestError.sessionNotFound(id)
    return attached
  }

  const attach = (native: PhoneSession) => {
    if (!native.id) throw new Error('Invalid native session')
    sessions.set(native.id, {})
  }

  const withSafeError = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action()
    } catch (error) {
      if (error instanceof acp.RequestError) throw error
      // Network and backend errors can contain credential-bearing URLs or headers.
      // Never expose their message, cause, stack or response body over ACP.
      throw new acp.RequestError(-32000, 'Phone operation failed. Reconnect to the same phone conversation to check its state. No automatic resubmission was attempted.')
    }
  }

  const validateWorkspace = (params: acp.NewSessionRequest | acp.LoadSessionRequest) => {
    if (!isAbsolute(params.cwd)) {
      throw acp.RequestError.invalidParams(undefined, 'cwd must be an absolute path')
    }
    if (params.mcpServers.length !== 0) {
      throw acp.RequestError.invalidParams(undefined, 'Client MCP servers are not supported. Configure tools on the phone instead.')
    }
    if (params.additionalDirectories?.length) {
      throw acp.RequestError.invalidParams(undefined, 'Additional client directories cannot be mounted on the phone.')
    }
  }

  app.onConnect(connection => {
    connection.signal.addEventListener('abort', () => lifetime.abort(), { once: true })
  })

  app.onRequest(acp.methods.agent.initialize, ({ params }) => {
    if (params.protocolVersion < acp.PROTOCOL_VERSION) {
      throw acp.RequestError.unsupportedProtocolVersion(params.protocolVersion, [acp.PROTOCOL_VERSION])
    }
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: 'pi-phone-acp', version: '0.1.0' },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
      },
      authMethods: [],
    }
  })

  app.onRequest(acp.methods.agent.session.new, ({ params, signal }) => withSafeError(async () => {
    validateWorkspace(params)
    // The client's cwd is not a phone path and must never be used as one.
    const native = await phone.create(AbortSignal.any([signal, lifetime.signal]))
    attach(native)
    return { sessionId: native.id }
  }))

  app.onRequest(acp.methods.agent.session.load, ({ params, signal, client }) => withSafeError(async () => {
    validateWorkspace(params)
    if (sessions.get(params.sessionId)?.prompt) {
      throw acp.RequestError.invalidRequest(undefined, 'A prompt is already active for this conversation')
    }
    const native = await phone.load(params.sessionId, AbortSignal.any([signal, lifetime.signal]))
    if (native.id !== params.sessionId) throw new Error('Native session mismatch')
    for (const message of native.history) {
      await client.notify(acp.methods.client.session.update, {
        sessionId: native.id,
        update: {
          sessionUpdate: message.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
          content: { type: 'text', text: message.text },
        },
      })
    }
    attach(native)
    return {}
  }))

  app.onRequest(acp.methods.agent.session.prompt, ({ params, signal, client }) => withSafeError(async () => {
    const attached = session(params.sessionId)
    if (attached.prompt) {
      throw acp.RequestError.invalidRequest(undefined, 'A prompt is already active for this conversation')
    }
    if (params.prompt.some(block => block.type !== 'text')) {
      throw acp.RequestError.invalidParams(undefined, 'Only text prompts are supported')
    }
    const text = params.prompt.map(block => block.type === 'text' ? block.text : '').join('\n')
    if (!text.trim()) throw acp.RequestError.invalidParams(undefined, 'Prompt text must not be empty')

    const active: ActivePrompt = { requestId: randomUUID() }
    attached.prompt = active
    const detached = AbortSignal.any([signal, lifetime.signal])
    try {
      for await (const event of phone.run(params.sessionId, text, active.requestId, detached)) {
        detached.throwIfAborted()
        if (event.type === 'end') {
          await active.cancellation
          return { stopReason: event.reason }
        }
        await client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: event.type === 'thought' ? 'agent_thought_chunk' : 'agent_message_chunk',
            content: { type: 'text', text: event.text },
          },
        })
      }
      // Closing an observer is not proof that the phone's turn completed.
      throw new Error('Phone stream ended without a terminal result')
    } finally {
      delete attached.prompt
    }
  }))

  app.onNotification(acp.methods.agent.session.cancel, ({ params }) => {
    const active = sessions.get(params.sessionId)?.prompt
    if (!active || active.cancellation) return
    active.cancellation = phone.cancel(params.sessionId, active.requestId)
    // Notifications have no response. The prompt awaits cancellation before it
    // reports completion, and this handler prevents an unhandled rejection.
    void active.cancellation.catch(() => {})
  })

  return app
}
