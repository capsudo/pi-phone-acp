import { createServer } from 'node:http'
import type { ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Entry, View } from '../src/contract.js'

interface Conversation {
  id: number
  cwd: string
  entries: Entry[]
  busy: boolean
  approvals: NonNullable<View['approvals']>
  contextFrom: number
}
interface Poller {
  id: string
  conversation: number
  seq: number
  events: { seq: number, event: string, data: unknown }[]
  waiting?: ServerResponse
  timer?: NodeJS.Timeout
}

/** Source-shaped build-508 fixture, not a claim of testing the actual APK. */
export class PhoneFixture {
  readonly token = 'test-only-device-session'
  readonly conversations = new Map<number, Conversation>()
  readonly submitted = Promise.withResolvers<{ id: number, text: string, requestId: string }>()
  readonly submissions: { id: number, text: string, requestId: string }[] = []
  readonly answers: { id: string, allow: boolean }[] = []
  readonly privateAnswers: { path: string, body: Record<string, unknown> }[] = []
  readonly acks: { session: string, ack: number }[] = []
  readonly pollers = new Map<string, Poller>()
  aborts = 0
  closes = 0
  pollCount = 0
  failNextPoll = false
  loseSubmitResponse = false
  rejectPollStatus = 0
  private nextEntry = 1
  private nextPoller = 1
  readonly server = createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== `Bearer ${this.token}`) return this.json(response, { error: 'Sign in first' }, 401)
      if (request.method !== 'GET' && request.headers['x-pocket'] !== '1') return this.json(response, {}, 403)
      const url = new URL(request.url!, 'http://localhost')
      let body: Record<string, unknown> = {}
      if (request.method === 'POST') {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>
      }
      if (url.pathname === '/api/me') return this.json(response, { user: { id: 'owner', role: 'owner' }, server: { home: '/phone/home', defaultCwd: '/phone/home/work' } })
      if (url.pathname === '/api/sessions' && request.method === 'POST') {
        const native = this.create(String(body.cwd))
        return this.json(response, { id: native.id })
      }
      if (url.pathname === '/api/poll') {
        const existing = this.pollers.get(url.searchParams.get('session') ?? '')
        if (url.searchParams.get('close') === '1') {
          this.closes++
          if (existing) { this.answer(existing); this.pollers.delete(existing.id) }
          return this.json(response, { ok: true })
        }
        this.pollCount++
        if (this.rejectPollStatus) return this.json(response, {}, this.rejectPollStatus)
        let poller = existing
        if (!poller) {
          const conversation = this.conversations.get(Number(url.searchParams.get('c')))
          poller = { id: `poll-${this.nextPoller++}`, conversation: conversation?.id ?? 0, seq: 0, events: [] }
          this.pollers.set(poller.id, poller)
          poller.events.push({ seq: ++poller.seq, event: 'hello', data: {} })
          poller.events.push({ seq: ++poller.seq, event: conversation ? 'view' : 'missing', data: conversation ? this.view(conversation.id) : {} })
        } else {
          const ack = Number(url.searchParams.get('ack') ?? 0)
          this.acks.push({ session: poller.id, ack })
          poller.events = poller.events.filter(event => event.seq > ack)
        }
        if (this.failNextPoll) { this.failNextPoll = false; response.destroy(); return }
        poller.waiting = response
        const current = poller
        response.once('close', () => {
          if (current.waiting === response) { clearTimeout(current.timer); delete current.waiting }
        })
        if (poller.events.length) return this.answer(poller)
        poller.timer = setTimeout(() => this.answer(current), 100)
        return
      }
      const parts = url.pathname.split('/')
      if (['browser', 'computer', 'secrets'].includes(parts[2]!) && ['asks', 'requests'].includes(parts[3]!)) {
        const id = decodeURIComponent(parts.slice(4).join('/'))
        const conversation = [...this.conversations.values()].find(item => item.approvals.some(approval => approval.id === id))
        if (!conversation) return this.json(response, { ok: false }, 404)
        this.privateAnswers.push({ path: url.pathname, body })
        conversation.approvals = conversation.approvals.filter(approval => approval.id !== id)
        this.finish(conversation.id, 'Private request completed; no values returned.')
        return this.json(response, { ok: true })
      }
      if (parts[2] === 'approvals') {
        this.answers.push({ id: decodeURIComponent(parts.slice(3).join('/')), allow: body.allow === true })
        for (const conversation of this.conversations.values()) {
          conversation.approvals = conversation.approvals.filter(approval => approval.id !== this.answers.at(-1)!.id)
          this.publish(conversation.id)
        }
        return this.json(response, { ok: true })
      }
      const conversation = this.conversations.get(Number(parts[3]))
      if (!conversation) return this.json(response, {}, 404)
      if (parts[4] === 'history') {
        return this.json(response, conversation.entries.filter(entry => entry.id < Number(url.searchParams.get('before'))).slice(-400))
      }
      if (parts[4] === 'submit') {
        const submission = { id: conversation.id, text: String(body.text), requestId: String(body.requestId) }
        this.submissions.push(submission)
        this.append(conversation.id, { kind: 'user', text: submission.text, images: 0 })
        conversation.busy = true
        this.publish(conversation.id)
        this.submitted.resolve(submission)
        if (this.loseSubmitResponse) { response.destroy(); return }
        return this.json(response, { submissionId: 1000 + this.submissions.length, requestId: `own:owner:${submission.requestId}` })
      }
      if (parts[4] === 'abort') {
        this.aborts++
        this.finish(conversation.id, '', 'aborted')
        return this.json(response, { ok: true })
      }
      return this.json(response, {}, 404)
    } catch { if (!response.destroyed) this.json(response, {}, 500) }
  })
  url!: URL

  async start() {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve))
    this.url = new URL(`http://127.0.0.1:${(this.server.address() as AddressInfo).port}`)
    return this
  }
  async close() {
    for (const poller of this.pollers.values()) { clearTimeout(poller.timer); poller.waiting?.destroy() }
    this.server.closeAllConnections()
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()))
  }
  create(cwd = '/phone/home/work') {
    const native = { id: this.conversations.size + 1, cwd, entries: [], busy: false, approvals: [], contextFrom: 0 }
    this.conversations.set(native.id, native)
    return native
  }
  append(id: number, entry: Omit<Entry, 'id'>) {
    const result = { ...entry, id: this.nextEntry++ } as Entry
    this.conversations.get(id)!.entries.push(result)
    return result
  }
  finish(id: number, text = 'phone result', stopReason = 'stop') {
    this.append(id, { kind: 'assistant', blocks: [{ type: 'text', text }], stopReason })
    this.conversations.get(id)!.busy = false
    this.publish(id)
  }
  view(id: number): View {
    const conversation = this.conversations.get(id)!
    const entries = conversation.entries.filter(entry => entry.id >= conversation.contextFrom)
    return {
      full: true, conversation: { id, cwd: conversation.cwd }, entries: [...entries], order: entries.map(entry => entry.id),
      live: { busy: conversation.busy }, inbox: [], approvals: [...conversation.approvals],
    }
  }
  publish(id: number, view = this.view(id)) {
    for (const poller of this.pollers.values()) {
      if (poller.conversation !== id) continue
      // A real wire serializes a snapshot now, not a reference to future state.
      poller.events.push({ seq: ++poller.seq, event: 'view', data: structuredClone(view) })
      if (poller.waiting) this.answer(poller)
    }
  }
  expirePollers() {
    for (const poller of this.pollers.values()) { poller.events = []; this.answer(poller) }
    this.pollers.clear()
  }
  private answer(poller: Poller) {
    clearTimeout(poller.timer)
    if (!poller.waiting) return
    this.json(poller.waiting, { session: poller.id, events: poller.events })
    delete poller.waiting
  }
  private json(response: ServerResponse, data: unknown, status = 200) {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(data))
  }
}
