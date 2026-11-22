import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { createdSchema, helloSchema, historySchema, pollSchema, submittedSchema, viewSchema } from './contract.js'
import type { Entry, View } from './contract.js'
import { PhoneHttp, PhoneHttpError } from './http.js'
import type { PhoneBackend, PhoneEvent, PhoneSession, PrivateApproval, SecretAskApproval } from './phone.js'
import { privateValues, supportedPrivateForm } from './private-forms.js'
import { Projection } from './projection.js'
import { askValues, supportedSecretAsk, type ResponseItem } from './forms.js'

const okSchema = z.object({ ok: z.literal(true) })
const nativeId = (id: string) => {
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error('Invalid phone conversation ID')
  return id
}

interface Pending {
  accepted: Promise<void>
  submitted: boolean
  cancelRequested: boolean
  cancelAcknowledged: boolean
}

/** Build-508 HTTP/long-poll implementation. No phone process is owned here. */
export class HttpPhoneBackend implements PhoneBackend {
  private readonly projections = new Map<string, Projection>()
  private readonly pending = new Map<string, Pending>()
  private readonly uncertain = new Set<string>()

  constructor(private readonly http: PhoneHttp, private readonly cwd: string, private readonly retryDelayMs = 250) {}

  async doctor(signal: AbortSignal) {
    const hello = await this.http.json('/api/me', helloSchema, signal)
    return { role: hello.user.role, compatibleShape: true, runtimeVersionVerified: false }
  }

  async create(signal: AbortSignal): Promise<PhoneSession> {
    // This endpoint has no idempotency key. Never retry a failed creation.
    const result = await this.http.json('/api/sessions', createdSchema, signal, { cwd: this.cwd, title: 'pi-phone-acp' })
    return { id: String(result.id), history: [] }
  }

  async load(id: string, signal: AbortSignal): Promise<PhoneSession> {
    const stream = this.views(nativeId(id), signal)
    try {
      const { value: view } = await stream.next()
      if (!view) throw new Error('Phone supplied no initial view')
      const history = await this.historyBefore(id, view, 0, signal)
      const projection = new Projection()
      this.projections.set(id, projection)
      const replay = projection.consume(view, history)
      this.uncertain.delete(id)
      return { id, history: [], replay }
    } finally { await stream.return(undefined) }
  }

  async *observe(id: string, signal: AbortSignal): AsyncGenerator<PhoneEvent, void> {
    const projection = this.projection(id)
    for await (const view of this.views(nativeId(id), signal)) {
      const history = view.full ? await this.historyBefore(id, view, projection.lastEntry, signal) : []
      yield* projection.consume(view, history)
    }
  }

  async *run(id: string, text: string, requestId: string, signal: AbortSignal): AsyncGenerator<PhoneEvent, void> {
    nativeId(id)
    if (this.uncertain.has(id)) throw new Error('Reload the phone conversation before sending another prompt after an uncertain outcome')
    let attempted = false
    let finished = false
    const key = `${id}:${requestId}`
    const accepted = Promise.withResolvers<void>()
    const pending: Pending = { accepted: accepted.promise, submitted: false, cancelRequested: false, cancelAcknowledged: false }
    // A cancel can arrive before the initial read or POST response.
    this.pending.set(key, pending)
    const stream = this.views(id, signal)
    try {
      const { value: baseline } = await stream.next()
      if (!baseline || baseline.live.busy || baseline.inbox?.length || baseline.approvals?.length) {
        throw new Error('Phone conversation is already working or waiting for approval. Observe it without sending a new prompt.')
      }
      const before = Math.max(0, ...baseline.entries.map(entry => entry.id))
      const projection = this.projection(id)
      // The baseline can include work committed since the last load.
      yield* projection.consume(baseline)
      signal.throwIfAborted()
      if (pending.cancelRequested) {
        accepted.resolve()
        finished = true
        yield { type: 'end', reason: 'cancelled' }
        return
      }
      // No retries, including a lost response. The phone may already have accepted it.
      attempted = true
      const submitted = await this.http.json(`/api/c/${id}/submit`, submittedSchema, signal, { text, requestId })
      pending.submitted = true
      accepted.resolve()
      const users = new Set<number>()
      let lastAssistant: Entry | undefined
      let lastUser = 0
      for (;;) {
        const { value: view } = await stream.next()
        if (!view) throw new Error('Phone observation ended')
        const history = view.full ? await this.historyBefore(id, view, before, signal) : []
        for (const entry of [...history, ...view.entries]) {
          if (entry.id <= before) continue
          if (entry.kind === 'user' && !entry.from) { users.add(entry.id); lastUser = Math.max(lastUser, entry.id) }
          if (entry.kind === 'assistant' && (!lastAssistant || entry.id > lastAssistant.id)) lastAssistant = entry
        }
        // The HTTP projection has no requestId -> transcript-entry mapping.
        // Refuse ambiguous outcomes rather than claiming another client's answer.
        if (users.size > 1) throw new Error('Concurrent phone writer detected. Reconnect to inspect the conversation.')
        for (const event of projection.consume(view, history)) {
          if (event.type !== 'user') yield event
        }
        const queued = view.inbox?.some(item => item.id === submitted.submissionId)
        if (!view.live.busy && !queued && !(view.inbox?.length) && !(view.approvals?.length)) {
          if (lastAssistant && lastAssistant.id > lastUser && users.size === 1) {
            if (lastAssistant.error || lastAssistant.stopReason === 'error') throw new Error('Phone agent failed')
            if (lastAssistant.stopReason === 'aborted') { finished = true; yield { type: 'end', reason: 'cancelled' }; return }
            if (lastAssistant.stopReason === 'stop' || lastAssistant.stopReason === 'length') {
              finished = true
              yield { type: 'end', reason: lastAssistant.stopReason === 'length' ? 'max_tokens' : 'end_turn' }
              return
            }
          }
          // abort() is asynchronous. An idle view after its acknowledged stop
          // confirms the conversation has stopped, not the POST response alone.
          if (pending.cancelAcknowledged && users.size <= 1) {
            finished = true
            yield { type: 'end', reason: 'cancelled' }
            return
          }
        }
      }
    } finally {
      if (attempted && !finished) this.uncertain.add(id)
      accepted.resolve()
      this.pending.delete(key)
      await stream.return(undefined)
    }
  }

  async cancel(id: string, requestId: string): Promise<void> {
    const pending = this.pending.get(`${nativeId(id)}:${requestId}`)
    if (!pending || pending.cancelRequested) return
    pending.cancelRequested = true
    await pending.accepted
    if (pending.submitted) {
      // Build-508 Stop is conversation-wide and withdraws queued messages too.
      // Only an explicit session/cancel may invoke it.
      await this.http.json(`/api/c/${id}/abort`, okSchema, AbortSignal.timeout(10_000), {})
      pending.cancelAcknowledged = true
    }
  }

  async answerApproval(id: string, allow: boolean, signal: AbortSignal): Promise<void> {
    await this.http.json(`/api/approvals/${encodeURIComponent(id)}`, okSchema, signal, { allow })
  }

  async answerAsk(id: string, values: Record<string, string>, signal: AbortSignal): Promise<void> {
    // Unlike /approvals, /asks validates and returns the named values to the asker.
    await this.http.json(`/api/asks/${encodeURIComponent(id)}`, okSchema, signal, { values })
  }

  async secretAskCurrent(id: string, approval: SecretAskApproval, signal: AbortSignal): Promise<boolean> {
    const expected = supportedSecretAsk(approval.form)
    if (!expected) return false
    const hello = await this.http.json('/api/me', helloSchema, signal)
    if (hello.user.role !== 'owner' || hello.user.team) return false
    const stream = this.views(nativeId(id), signal)
    try {
      const { value: view } = await stream.next()
      const current = view?.approvals?.find(item => item.id === approval.id)
      if (!current || current.conversationId !== Number(id) || current.tool !== approval.tool || (current.callId ?? current.id) !== approval.callId) return false
      const form = supportedSecretAsk(current.form)
      return form !== undefined && JSON.stringify(form) === JSON.stringify(expected)
    } finally { await stream.return(undefined) }
  }

  async answerSecretAsk(id: string, approval: SecretAskApproval, values: Record<string, string>, signal: AbortSignal): Promise<void> {
    const form = supportedSecretAsk(approval.form)
    if (!form) throw new Error('Unsupported secret extension form')
    const checked = askValues(form, values)
    if (!await this.secretAskCurrent(id, approval, signal)) throw new Error('Secret extension request changed')
    signal.throwIfAborted()
    // The extension receives the exact named strings. An uncertain POST is never retried.
    await this.answerAsk(approval.id, checked, signal)
  }

  async declineSecretAsk(id: string, approval: SecretAskApproval, signal: AbortSignal): Promise<void> {
    if (!await this.secretAskCurrent(id, approval, signal)) throw new Error('Secret extension request changed')
    signal.throwIfAborted()
    await this.answerApproval(approval.id, false, signal)
  }

  async privateFormCurrent(id: string, approval: PrivateApproval, signal: AbortSignal): Promise<boolean> {
    const hello = await this.http.json('/api/me', helloSchema, signal)
    if (hello.user.role !== 'owner' || hello.user.team) return false
    const stream = this.views(nativeId(id), signal)
    try {
      const { value: view } = await stream.next()
      const current = view?.approvals?.find(item => item.id === approval.id)
      if (!current || current.tool !== approval.tool || (current.callId ?? current.id) !== approval.callId) return false
      const form = supportedPrivateForm(current.form, current.tool)
      return form !== undefined && JSON.stringify(form) === JSON.stringify(approval.privateForm)
    } finally { await stream.return(undefined) }
  }

  async declinePrivate(id: string, approval: PrivateApproval, signal: AbortSignal): Promise<void> {
    if (!await this.privateFormCurrent(id, approval, signal)) throw new Error('Private phone request changed')
    signal.throwIfAborted()
    // Explicit card Decline rejects only this request, never the conversation.
    // A lost acknowledgement is uncertain; attempt the decision once only.
    await this.answerApproval(approval.id, false, signal)
  }

  async answerPrivate(id: string, approval: PrivateApproval, values: Record<string, string>, signal: AbortSignal): Promise<void> {
    const checked = privateValues(approval.privateForm, values)
    // Re-read the native request immediately before its one attempted POST.
    // Upstream has no compare-and-swap; concurrent phone edits are not supported.
    if (!await this.privateFormCurrent(id, approval, signal)) throw new Error('Private phone request changed')
    signal.throwIfAborted()
    const key = encodeURIComponent(approval.id)
    const form = approval.privateForm
    const path = form.type === 'secret' ? `/api/secrets/requests/${key}`
      : form.type === 'browser' ? `/api/browser/asks/${key}` : `/api/computer/asks/${key}`
    const body = form.type === 'secret' ? { value: checked.value } : { values: checked, remember: false, useSaved: false }
    // A lost response may mean values were filled or saved. Never resend it.
    await this.http.json(path, okSchema, signal, body)
  }

  async getInterview(id: string, callId: string, signal: AbortSignal): Promise<unknown> {
    return this.http.json(`/api/c/${nativeId(id)}/interviews/${encodeURIComponent(callId)}`, z.unknown(), signal)
  }

  async answerInterview(id: string, callId: string, answer: { action: 'submit' | 'cancel', draft?: ResponseItem[] }, signal: AbortSignal): Promise<void> {
    // The route returns the saved interview, NOT {ok:true}. Never retry a lost POST.
    await this.http.json(`/api/c/${nativeId(id)}/interviews/${encodeURIComponent(callId)}`,
      z.object({ status: z.literal(answer.action === 'submit' ? 'completed' : 'cancelled') }), signal, answer)
  }

  private async historyBefore(id: string, view: View, after: number, signal: AbortSignal): Promise<Entry[]> {
    const history: Entry[] = []
    let before = Math.min(...view.entries.map(entry => entry.id), Number.MAX_SAFE_INTEGER)
    while (before > after + 1) {
      const page = await this.http.json(`/api/c/${id}/history?before=${before}`, historySchema, signal)
      if (page.length === 0) break
      const next = Math.min(...page.map(entry => entry.id))
      if (next >= before) throw new Error('Phone history cursor did not advance')
      history.unshift(...page.filter(entry => entry.id > after))
      before = next
    }
    return history
  }

  private projection(id: string) {
    let projection = this.projections.get(id)
    if (!projection) { projection = new Projection(); this.projections.set(id, projection) }
    return projection
  }

  private async *views(id: string, signal: AbortSignal): AsyncGenerator<View, void> {
    let session = ''
    let ack = 0
    let failures = 0
    let previous: View | undefined
    try {
      while (!signal.aborted) {
        const query = new URLSearchParams({ c: id, p: '1' })
        if (session) { query.set('session', session); query.set('ack', String(ack)) }
        let result: z.infer<typeof pollSchema>
        try {
          result = await this.http.json(`/api/poll?${query}`, pollSchema, signal)
          failures = 0
        } catch (error) {
          signal.throwIfAborted()
          if (error instanceof z.ZodError || (error instanceof PhoneHttpError && error.status < 500) || ++failures > 5) throw error
          await delay(Math.min(this.retryDelayMs * 2 ** (failures - 1), 5000), undefined, { signal })
          continue
        }
        if (session !== result.session) {
          session = result.session
          ack = 0
          previous = undefined
        }
        for (const event of result.events) {
          if (event.seq <= ack) continue
          if (event.event === 'missing') throw new Error('Phone conversation is missing or access was removed')
          if (event.event === 'view') {
            const parsed = viewSchema.parse(event.data)
            if (String(parsed.conversation.id) !== id) throw new Error('Phone view belongs to another conversation')
            if (!previous && !parsed.full) throw new Error('Phone supplied a partial view before its snapshot')
            previous = { ...(parsed.full ? {} : previous), ...parsed }
            if (!previous.inbox || !previous.approvals) throw new Error('Phone omitted queue or approval state')
            yield previous
          }
          // Ack only after the consumer applies the event. Lost answers repeat.
          ack = event.seq
        }
      }
      signal.throwIfAborted()
    } finally {
      if (session) {
        // Closing a browser poller detaches it, not its conversation or work.
        const query = new URLSearchParams({ session, close: '1' })
        await this.http.json(`/api/poll?${query}`, okSchema, AbortSignal.timeout(2000)).catch(() => {})
      }
    }
  }
}
