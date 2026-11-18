import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as acp from '@agentclientprotocol/sdk'
import { createAdapter } from '../src/adapter.js'
import type { PhoneBackend, PhoneEvent, PhoneSession } from '../src/phone.js'

class FakePhone implements PhoneBackend {
  readonly stored = new Map<string, PhoneSession>()
  readonly submissions: { id: string, text: string, requestId: string }[] = []
  readonly cancellations: { id: string, requestId: string }[] = []
  readonly started = Promise.withResolvers<void>()
  private events: PhoneEvent[] = []
  private wake = Promise.withResolvers<void>()
  detached = false
  working = false
  fail?: Error

  async create(): Promise<PhoneSession> {
    if (this.fail) throw this.fail
    const native = { id: `phone-${this.stored.size + 1}`, history: [] }
    this.stored.set(native.id, native)
    return native
  }

  async load(id: string): Promise<PhoneSession> {
    const native = this.stored.get(id)
    if (!native) throw new Error('Phone conversation not found')
    return native
  }

  emit(event: PhoneEvent) {
    this.events.push(event)
    this.wake.resolve()
  }

  async *run(id: string, text: string, requestId: string, signal: AbortSignal) {
    this.submissions.push({ id, text, requestId })
    this.working = true
    this.started.resolve()
    const detach = () => this.wake.resolve()
    signal.addEventListener('abort', detach, { once: true })
    try {
      while (!signal.aborted) {
        const event = this.events.shift()
        if (!event) {
          await this.wake.promise
          this.wake = Promise.withResolvers<void>()
          continue
        }
        yield event
        if (event.type === 'end') return
      }
      signal.throwIfAborted()
    } finally {
      this.detached = true
      signal.removeEventListener('abort', detach)
    }
  }

  async cancel(id: string, requestId: string) {
    this.cancellations.push({ id, requestId })
    this.working = false
    this.emit({ type: 'end', reason: 'cancelled' })
  }

  finish() {
    this.working = false
    this.emit({ type: 'end', reason: 'end_turn' })
  }
}

const workspace = { cwd: '/t3/project', mcpServers: [] }
const promptFor = (sessionId: string, text = 'hello') => ({ sessionId, prompt: [{ type: 'text' as const, text }] })

function connect(phone = new FakePhone()) {
  const updates: acp.SessionNotification[] = []
  const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => {
    updates.push(params)
  })
  const connection = client.connect(createAdapter(phone))
  return { phone, updates, connection, agent: connection.agent }
}

async function initialize(agent: acp.ClientContext) {
  return agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION })
}

test('negotiates ACP v1 when a client prefers v2, with honest capabilities', async () => {
  const { connection, agent } = connect()
  try {
    const result = await agent.request(acp.methods.agent.initialize, { protocolVersion: 2 })
    assert.equal(result.protocolVersion, 1)
    assert.equal(result.agentInfo?.name, 'pi-phone-acp')
    assert.equal(result.agentCapabilities?.loadSession, true)
    assert.deepEqual(result.authMethods, [])
    assert.equal(result.agentCapabilities?.promptCapabilities?.image, false)
    assert.equal(result.agentCapabilities?.mcpCapabilities, undefined)
  } finally { connection.close() }
})

test('rejects an unsupported protocol version', async () => {
  const { connection, agent } = connect()
  try {
    await assert.rejects(agent.request(acp.methods.agent.initialize, { protocolVersion: 0 }), { code: -32022 })
  } finally { connection.close() }
})

test('uses phone conversation IDs rather than transient adapter IDs', async () => {
  const { phone, connection, agent } = connect()
  try {
    await initialize(agent)
    assert.deepEqual(await agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, workspace), { sessionId: 'phone-1' })
    assert.equal(phone.stored.size, 1)
  } finally { connection.close() }
})

test('rejects client tools and workspace mounts rather than executing them', async () => {
  const { phone, connection, agent } = connect()
  try {
    await initialize(agent)
    await assert.rejects(agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, { ...workspace, cwd: 'relative' }), { code: -32602 })
    await assert.rejects(agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, {
      ...workspace, mcpServers: [{ name: 'host-tools', command: '/bin/sh', args: ['untrusted'], env: [] }],
    }), { code: -32602 })
    await assert.rejects(agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, {
      ...workspace, additionalDirectories: ['/host/files'],
    }), { code: -32602 })
    assert.equal(phone.stored.size, 0)
  } finally { connection.close() }
})

test('a fresh adapter loads history from the phone without local session storage', async () => {
  const phone = new FakePhone()
  const first = connect(phone)
  await initialize(first.agent)
  const { sessionId } = await first.agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, workspace)
  first.connection.close()
  phone.stored.set(sessionId, { id: sessionId, history: [
    { role: 'user', text: 'original prompt' },
    { role: 'assistant', text: 'phone result' },
  ] })
  const second = connect(phone)
  try {
    await initialize(second.agent)
    await second.agent.request(acp.methods.agent.session.load, { ...workspace, sessionId })
    assert.deepEqual(second.updates.map(entry => entry.update.sessionUpdate), ['user_message_chunk', 'agent_message_chunk'])
    assert.deepEqual(second.updates.map(entry => 'content' in entry.update ? entry.update.content : null), [
      { type: 'text', text: 'original prompt' },
      { type: 'text', text: 'phone result' },
    ])
    assert.equal(phone.submissions.length, 0)
  } finally { second.connection.close() }
})

test('streams text and thoughts and completes only on a phone terminal event', async () => {
  const { phone, connection, agent, updates } = connect()
  try {
    await initialize(agent)
    const { sessionId } = await agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, workspace)
    const result = agent.request(acp.methods.agent.session.prompt, promptFor(sessionId))
    await phone.started.promise
    phone.emit({ type: 'thought', text: 'thinking' })
    phone.emit({ type: 'text', text: 'answer' })
    phone.finish()
    assert.deepEqual(await result, { stopReason: 'end_turn' })
    assert.deepEqual(updates.map(entry => entry.update.sessionUpdate), ['agent_thought_chunk', 'agent_message_chunk'])
    assert.equal(phone.submissions.length, 1)
    assert.match(phone.submissions[0]!.requestId, /^[\da-f-]{36}$/)
  } finally { connection.close() }
})

test('rejects unsupported prompt content and empty text before submission', async () => {
  const { phone, connection, agent } = connect()
  try {
    await initialize(agent)
    const { sessionId } = await agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, workspace)
    await assert.rejects(agent.request(acp.methods.agent.session.prompt, promptFor(sessionId, ' ')), { code: -32602 })
    await assert.rejects(agent.request(acp.methods.agent.session.prompt, {
      sessionId, prompt: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }],
    }), { code: -32602 })
    assert.equal(phone.submissions.length, 0)
  } finally { connection.close() }
})

test('rejects unknown sessions and concurrent prompts without replaying submissions', async () => {
  const { phone, connection, agent } = connect()
  try {
    await initialize(agent)
    await assert.rejects(agent.request(acp.methods.agent.session.prompt, promptFor('unknown')), { code: -32002 })
    const { sessionId } = await agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, workspace)
    const result = agent.request(acp.methods.agent.session.prompt, promptFor(sessionId))
    await phone.started.promise
    await assert.rejects(agent.request(acp.methods.agent.session.prompt, promptFor(sessionId, 'second')), { code: -32600 })
    await assert.rejects(agent.request(acp.methods.agent.session.load, { ...workspace, sessionId }), { code: -32600 })
    phone.finish()
    await result
    assert.equal(phone.submissions.length, 1)
  } finally { connection.close() }
})

test('ACP disconnection only detaches observation and does not cancel phone work', async () => {
  const { phone, connection, agent } = connect()
  await initialize(agent)
  const { sessionId } = await agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, workspace)
  const result = agent.request(acp.methods.agent.session.prompt, promptFor(sessionId))
  const rejected = assert.rejects(result)
  await phone.started.promise
  connection.close()
  await rejected
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(phone.detached, true)
  assert.equal(phone.working, true)
  assert.equal(phone.cancellations.length, 0)
  phone.finish()
  assert.equal(phone.working, false)
})

test('explicit ACP cancellation is forwarded once and confirmed by the phone', async () => {
  const { phone, connection, agent } = connect()
  try {
    await initialize(agent)
    const { sessionId } = await agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, workspace)
    const result = agent.request(acp.methods.agent.session.prompt, promptFor(sessionId))
    await phone.started.promise
    await agent.notify(acp.methods.agent.session.cancel, { sessionId })
    await agent.notify(acp.methods.agent.session.cancel, { sessionId })
    assert.deepEqual(await result, { stopReason: 'cancelled' })
    assert.equal(phone.cancellations.length, 1)
    assert.deepEqual(phone.cancellations[0], { id: sessionId, requestId: phone.submissions[0]!.requestId })
    await agent.notify(acp.methods.agent.session.cancel, { sessionId })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(phone.cancellations.length, 1)
  } finally { connection.close() }
})

test('redacts backend errors instead of exposing credentials over ACP', async () => {
  const { phone, connection, agent } = connect()
  try {
    await initialize(agent)
    phone.fail = new Error('http://example.invalid/?token=DO_NOT_LEAK Cookie: private')
    await assert.rejects(agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, workspace), error => {
      assert.ok(error instanceof Error)
      assert.doesNotMatch(JSON.stringify(error) + error.message, /DO_NOT_LEAK|Cookie|private|example/)
      assert.match(error.message, /Phone operation failed/)
      return true
    })
  } finally { connection.close() }
})

test('a truncated phone event stream is not reported as successful completion', async () => {
  class TruncatedPhone extends FakePhone {
    override async *run() { yield { type: 'text' as const, text: 'partial' } }
  }
  const { connection, agent } = connect(new TruncatedPhone())
  try {
    await initialize(agent)
    const { sessionId } = await agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, workspace)
    await assert.rejects(agent.request(acp.methods.agent.session.prompt, promptFor(sessionId)), { code: -32000 })
  } finally { connection.close() }
})
