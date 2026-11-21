import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as acp from '@agentclientprotocol/sdk/unstable'
import { createAdapter } from '../src/adapter.js'
import type { PhoneBackend, PhoneEvent, PhoneSession } from '../src/phone.js'
import { viewSchema } from '../src/contract.js'
import { Projection } from '../src/projection.js'
import { approvalView, riskyApproval, riskyForm } from './approval-fixture.js'

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
    assert.deepEqual(result.agentCapabilities?.mcpCapabilities, { acp: true })
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

test('rejects client workspace mounts rather than treating them as phone paths', async () => {
  const { phone, connection, agent } = connect()
  try {
    await initialize(agent)
    await assert.rejects(agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, { ...workspace, cwd: 'relative' }), { code: -32602 })
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

test('does not trust a backend RequestError with credential-bearing details', async () => {
  const { phone, connection, agent } = connect()
  try {
    await initialize(agent)
    phone.fail = new acp.RequestError(-32000, 'DO_NOT_LEAK', { token: 'DO_NOT_LEAK' })
    await assert.rejects(agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, workspace), error => {
      assert.ok(error instanceof Error)
      assert.doesNotMatch(JSON.stringify(error) + error.message, /DO_NOT_LEAK/)
      return true
    })
  } finally { connection.close() }
})

test('bridges a simple phone approval once, without inventing permanent approval options', async () => {
  class ApprovalPhone extends FakePhone {
    readonly answers: { id: string, allow: boolean }[] = []
    override async *run() {
      yield { type: 'approval' as const, id: 'a/1', callId: 'tool-1', tool: 'bash', subject: 'command', reason: 'phone policy', interactive: false }
      yield { type: 'approval' as const, id: 'a/1', callId: 'tool-1', tool: 'bash', subject: 'command', reason: 'phone policy', interactive: false }
      await new Promise(resolve => setImmediate(resolve))
      yield { type: 'end' as const, reason: 'end_turn' as const }
    }
    async answerApproval(id: string, allow: boolean) { this.answers.push({ id, allow }) }
  }
  const phone = new ApprovalPhone()
  let requests = 0
  const peer = acp.client().onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
    requests++
    assert.deepEqual(params.options.map(option => option.kind), ['allow_once', 'reject_once'])
    return { outcome: { outcome: 'selected' as const, optionId: 'deny' } }
  })
  const connection = peer.connect(createAdapter(phone))
  try {
    await initialize(connection.agent)
    const { sessionId } = await connection.agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, workspace)
    await connection.agent.request(acp.methods.agent.session.prompt, promptFor(sessionId))
    assert.equal(requests, 1)
    assert.deepEqual(phone.answers, [{ id: 'a/1', allow: false }])
  } finally { connection.close() }
})

for (const allow of [false, true]) {
  test(`round-trips a native risky card through projection and ACP with ${allow ? 'allow' : 'deny'}`, async () => {
    class RiskyPhone extends FakePhone {
      readonly answers: { id: string, allow: boolean }[] = []
      readonly answered = Promise.withResolvers<void>()
      override async *run() {
        const projection = new Projection()
        const view = viewSchema.parse(approvalView())
        yield* projection.consume(view)
        yield* projection.consume(view)
        await this.answered.promise
        yield { type: 'end' as const, reason: 'end_turn' as const }
      }
      async answerApproval(id: string, approved: boolean) {
        this.answers.push({ id, allow: approved })
        this.answered.resolve()
      }
    }
    const phone = new RiskyPhone()
    let requests = 0
    const peer = acp.client().onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      requests++
      assert.equal(params.toolCall.toolCallId, riskyApproval.callId)
      assert.equal(params.toolCall.title, 'browser_click: Delete')
      assert.deepEqual(params.options.map(option => option.kind), ['allow_once', 'reject_once'])
      assert.ok(JSON.stringify(params.toolCall.content).includes(riskyForm.where))
      assert.ok(JSON.stringify(params.toolCall.content).includes('Trigger: delete (name)'))
      return { outcome: { outcome: 'selected' as const, optionId: allow ? 'allow' : 'deny' } }
    })
    const connection = peer.connect(createAdapter(phone))
    try {
      await initialize(connection.agent)
      const { sessionId } = await connection.agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, workspace)
      await connection.agent.request(acp.methods.agent.session.prompt, promptFor(sessionId))
      assert.equal(requests, 1)
      assert.deepEqual(phone.answers, [{ id: riskyApproval.id, allow }])
    } finally { connection.close() }
  })
}

test('does not expose or approve native input forms through the permission dialog', async () => {
  class InputPhone extends FakePhone {
    override async *run() {
      yield* new Projection().consume(viewSchema.parse(approvalView({ type: 'secret', value: 'DO_NOT_LEAK' })))
      yield { type: 'end' as const, reason: 'end_turn' as const }
    }
    async answerApproval() { assert.fail('Input forms require a supported input protocol') }
  }
  const updates: acp.SessionNotification[] = []
  const peer = acp.client()
    .onRequest(acp.methods.client.session.requestPermission, () => { assert.fail('Do not coerce input into allow/deny') })
    .onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params) })
  const connection = peer.connect(createAdapter(new InputPhone()))
  try {
    await initialize(connection.agent)
    const { sessionId } = await connection.agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, workspace)
    await connection.agent.request(acp.methods.agent.session.prompt, promptFor(sessionId))
    assert.doesNotMatch(JSON.stringify(updates), /DO_NOT_LEAK/)
    assert.ok(JSON.stringify(updates).includes('Complete it in pi-phone'))
  } finally { connection.close() }
})

test('leaves secret/interview approvals on the phone instead of treating them as allow/deny', async () => {
  class InteractivePhone extends FakePhone {
    override async *run() {
      yield { type: 'approval' as const, id: 'secret', callId: 'tool', tool: 'secret_request', subject: 'hidden', reason: 'phone UI', interactive: true }
      yield { type: 'end' as const, reason: 'end_turn' as const }
    }
    async answerApproval() { assert.fail('Interactive forms must not be approved') }
  }
  const { connection, agent, updates } = connect(new InteractivePhone())
  try {
    await initialize(agent)
    const { sessionId } = await agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, workspace)
    await agent.request(acp.methods.agent.session.prompt, promptFor(sessionId))
    assert.ok(updates.some(item => item.update.sessionUpdate === 'agent_message_chunk' && item.update.content.type === 'text' && item.update.content.text.includes('Complete it in pi-phone')))
  } finally { connection.close() }
})

test('does not answer a pending phone approval when ACP disconnects', async () => {
  class PendingApprovalPhone extends FakePhone {
    override async *run(_id: string, _text: string, _request: string, signal: AbortSignal) {
      yield { type: 'approval' as const, id: 'pending', callId: 'tool', tool: 'bash', subject: 'command', reason: 'phone policy', interactive: false }
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      signal.throwIfAborted()
    }
    async answerApproval() { assert.fail('Disconnect must not allow or deny') }
  }
  const asked = Promise.withResolvers<void>()
  const peer = acp.client().onRequest(acp.methods.client.session.requestPermission, async ({ signal }) => {
    asked.resolve()
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    return { outcome: { outcome: 'cancelled' as const } }
  })
  const connection = peer.connect(createAdapter(new PendingApprovalPhone()))
  await initialize(connection.agent)
  const { sessionId } = await connection.agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, workspace)
  const prompt = connection.agent.request(acp.methods.agent.session.prompt, promptFor(sessionId))
  const rejected = assert.rejects(prompt)
  await asked.promise
  connection.close()
  await rejected
  await new Promise(resolve => setImmediate(resolve))
})


test('accepts T3-style MCP injection with an explicit warning and never executes or forwards host tools', async () => {
  const { phone, connection, agent, updates } = connect()
  try {
    await initialize(agent)
    const result = await agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, {
      ...workspace, mcpServers: [{ name: 't3', command: '/host/command-must-not-run', args: [], env: [{ name: 'TOKEN', value: 'DO_NOT_LEAK' }] }],
    })
    assert.equal(result.sessionId, 'phone-1')
    assert.equal(phone.stored.size, 1)
    assert.equal(phone.submissions.length, 0)
    assert.ok(JSON.stringify(updates).includes('Client MCP servers are not connected'))
    assert.doesNotMatch(JSON.stringify(updates), /DO_NOT_LEAK|command-must-not-run/)
  } finally { connection.close() }
})

test('explicit prompt cancellation releases its local approval dialog without answering it', async () => {
  class ApprovingPhone extends FakePhone {
    override async *run(id: string, text: string, requestId: string, signal: AbortSignal) {
      yield { type: 'approval' as const, id: 'pending', callId: 'tool', tool: 'bash', subject: 'command', reason: 'phone policy', interactive: false }
      yield* super.run(id, text, requestId, signal)
    }
    async answerApproval() { assert.fail('Cancelling the prompt must not answer its approval') }
  }
  const phone = new ApprovingPhone()
  const asked = Promise.withResolvers<void>()
  const dialogClosed = Promise.withResolvers<void>()
  const peer = acp.client().onRequest(acp.methods.client.session.requestPermission, async ({ signal }) => {
    asked.resolve()
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    dialogClosed.resolve()
    return { outcome: { outcome: 'cancelled' as const } }
  })
  const connection = peer.connect(createAdapter(phone))
  try {
    await initialize(connection.agent)
    const { sessionId } = await connection.agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, workspace)
    const prompt = connection.agent.request(acp.methods.agent.session.prompt, promptFor(sessionId))
    await asked.promise
    await phone.started.promise
    await connection.agent.notify(acp.methods.agent.session.cancel, { sessionId })
    assert.deepEqual(await prompt, { stopReason: 'cancelled' })
    await dialogClosed.promise
    assert.equal(phone.cancellations.length, 1)
  } finally { connection.close() }
})
