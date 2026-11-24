import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import * as acp from '@agentclientprotocol/sdk/unstable'
import { createAdapter } from '../src/adapter.js'
import { PhoneUnavailable, verifyPhone } from '../src/availability.js'
import { HttpPhoneBackend } from '../src/backend.js'
import { PhoneHttp } from '../src/http.js'
import { PhoneFixture } from './fixture.js'
import { riskyApproval } from './approval-fixture.js'

const availability = { timeoutMs: 300, intervalMs: 30, retryDelayMs: 30 }
const workspace = { cwd: '/t3/project', mcpServers: [] }
const initialize = (connection: acp.ClientConnection) => connection.agent.request(acp.methods.agent.initialize, { protocolVersion: 1 })
const backend = (fixture: PhoneFixture) => new HttpPhoneBackend(new PhoneHttp(fixture.url, fixture.token), '~/work', 1)
async function until(condition: () => boolean) {
  const deadline = Date.now() + 3000
  while (!condition()) { assert.ok(Date.now() < deadline, 'Condition did not settle'); await delay(5) }
}
function connect(fixture: PhoneFixture) {
  const failures: PhoneUnavailable[] = []
  const updates: acp.SessionNotification[] = []
  const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params) })
  const app = createAdapter(backend(fixture), { availability }).onConnect(agentConnection => {
    agentConnection.signal.addEventListener('abort', () => {
      if (agentConnection.signal.reason instanceof PhoneUnavailable) failures.push(agentConnection.signal.reason)
    }, { once: true })
  })
  const connection = client.connect(app)
  return { connection, failures, updates }
}

for (const [label, fault, reason] of [
  ['authentication', (fixture: PhoneFixture) => { fixture.meStatus = 401 }, 'authentication'],
  ['authorization', (fixture: PhoneFixture) => { fixture.meStatus = 403 }, 'authentication'],
  ['missing API', (fixture: PhoneFixture) => { fixture.meStatus = 404 }, 'incompatible'],
  ['incompatible shape', (fixture: PhoneFixture) => { fixture.meBody = { password: 'DO_NOT_LEAK' } }, 'incompatible'],
  ['HTML sign-in', (fixture: PhoneFixture) => { fixture.meText = '<html>DO_NOT_LEAK</html>' }, 'incompatible'],
  ['server failure', (fixture: PhoneFixture) => { fixture.meStatus = 503 }, 'unreachable'],
  ['lost connection', (fixture: PhoneFixture) => { fixture.meDrop = true }, 'unreachable'],
  ['timeout', (fixture: PhoneFixture) => { fixture.meHang = true }, 'unreachable'],
  ['stalled response body', (fixture: PhoneFixture) => { fixture.meHangBody = true }, 'unreachable'],
] as const) test(`startup ${label} rejects ACP initialization and closes without phone work`, { timeout: 5000 }, async () => {
  const fixture = await new PhoneFixture().start()
  fault(fixture)
  const { connection, failures } = connect(fixture)
  try {
    await assert.rejects(initialize(connection))
    await connection.closed
    assert.equal(failures.length, 1)
    assert.equal(failures[0]!.reason, reason)
    assert.doesNotMatch(failures[0]!.message, /DO_NOT_LEAK|127\.0\.0\.1|test-only-device-session/)
    assert.equal(fixture.meRequests, 1, 'Startup must be bounded and must not retry')
    assert.equal(fixture.conversations.size, 0)
    assert.equal(fixture.submissions.length, 0)
    assert.equal(fixture.aborts, 0)
    await until(() => fixture.meActive === 0)
  } finally { connection.close(); await fixture.close() }
})

for (const fault of ['auth', 'contract', 'timeout', 'network', 'server', 'rate-limit'] as const) test(`later ${fault} failure closes idle ACP with deliberate retry policy`, { timeout: 5000 }, async () => {
  const fixture = await new PhoneFixture().start()
  const { connection, failures } = connect(fixture)
  try {
    await initialize(connection)
    if (fault === 'auth') fixture.meStatus = 403
    if (fault === 'contract') fixture.meBody = { invalid: true }
    if (fault === 'timeout') fixture.meHang = true
    if (fault === 'network') fixture.meDrop = true
    if (fault === 'server') fixture.meStatus = 503
    if (fault === 'rate-limit') fixture.meStatus = 429
    await connection.closed
    assert.equal(failures.length, 1)
    const transient = ['timeout', 'network', 'server', 'rate-limit'].includes(fault)
    assert.equal(fixture.meRequests, transient ? 3 : 2)
    assert.equal(failures[0]!.reason, fault === 'auth' ? 'authentication' : fault === 'contract' ? 'incompatible' : 'unreachable')
    await until(() => fixture.meActive === 0)
    const calls = fixture.meRequests
    await delay(120)
    assert.equal(fixture.meRequests, calls, 'Closed connections must stop monitoring')
    assert.equal(fixture.conversations.size, 0)
    assert.equal(fixture.aborts, 0)
  } finally { connection.close(); await fixture.close() }
})

test('one transient failure recovers without closing or overlapping health requests', { timeout: 5000 }, async () => {
  const fixture = await new PhoneFixture().start()
  const { connection, failures } = connect(fixture)
  try {
    await initialize(connection)
    fixture.meHang = true
    await until(() => fixture.meRequests === 2)
    await delay(45)
    assert.equal(fixture.meRequests, 2)
    assert.equal(fixture.meActive, 1)
    // The in-flight request still times out, but its confirmation will succeed.
    fixture.meHang = false
    await until(() => fixture.meRequests >= 4)
    assert.equal(connection.signal.aborted, false)
    assert.deepEqual(failures, [])
    assert.equal(fixture.submissions.length, 0)
    connection.close()
    await connection.closed
    await until(() => fixture.meActive === 0)
    const calls = fixture.meRequests
    await delay(120)
    assert.equal(fixture.meRequests, calls)
  } finally { connection.close(); await fixture.close() }
})

test('conversation errors do not prove phone loss, and idle monitoring continues', { timeout: 5000 }, async () => {
  const fixture = await new PhoneFixture().start()
  const { connection, failures } = connect(fixture)
  try {
    await initialize(connection)
    await assert.rejects(connection.agent.request(acp.methods.agent.session.load, { ...workspace, sessionId: '999' }))
    fixture.rejectPollStatus = 400
    const { sessionId } = await connection.agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, workspace)
    await assert.rejects(connection.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'not submitted' }] }))
    await until(() => fixture.meRequests >= 3)
    assert.equal(connection.signal.aborted, false)
    assert.deepEqual(failures, [])
    assert.equal(fixture.submissions.length, 0)
    assert.equal(fixture.aborts, 0)
  } finally { connection.close(); await fixture.close() }
})

for (const phase of ['startup', 'monitor'] as const) test(`intentional shutdown during ${phase} check aborts it without reporting phone loss`, { timeout: 5000 }, async () => {
  const fixture = await new PhoneFixture().start()
  if (phase === 'startup') fixture.meHang = true
  const { connection, failures } = connect(fixture)
  try {
    if (phase === 'monitor') { await initialize(connection); fixture.meHang = true }
    await until(() => fixture.meActive === 1)
    connection.close()
    await connection.closed
    await until(() => fixture.meActive === 0)
    await delay(150)
    assert.deepEqual(failures, [])
    assert.equal(fixture.meRequests, phase === 'startup' ? 1 : 2)
    assert.equal(fixture.aborts, 0)
  } finally { connection.close(); await fixture.close() }
})

test('cancelled reachability read is not reclassified as a phone failure', async () => {
  const fixture = await new PhoneFixture().start()
  fixture.meHang = true
  const controller = new AbortController()
  try {
    const check = verifyPhone(backend(fixture), controller.signal, 1000)
    const rejected = assert.rejects(check, error => !(error instanceof PhoneUnavailable))
    await until(() => fixture.meActive === 1)
    controller.abort()
    await rejected
    await until(() => fixture.meActive === 0)
    assert.equal(fixture.meRequests, 1)
  } finally { await fixture.close() }
})

test('phone loss during a turn detaches ACP, preserves work/history, and recovery only observes', { timeout: 5000 }, async () => {
  const fixture = await new PhoneFixture().start()
  const first = connect(fixture)
  let second: ReturnType<typeof connect> | undefined
  try {
    await initialize(first.connection)
    const { sessionId } = await first.connection.agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, workspace)
    const prompt = first.connection.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'keep working after loss' }] })
    const rejected = assert.rejects(prompt)
    await fixture.submitted.promise
    fixture.meDrop = true
    fixture.rejectPollStatus = 503
    await first.connection.closed
    await rejected
    assert.equal(first.failures.length, 1)
    assert.equal(fixture.conversations.get(Number(sessionId))!.busy, true)
    assert.equal(fixture.aborts, 0)
    assert.equal(fixture.submissions.length, 1)
    fixture.meDrop = false
    fixture.rejectPollStatus = 0
    second = connect(fixture)
    await initialize(second.connection)
    await second.connection.agent.request(acp.methods.agent.session.load, { ...workspace, sessionId })
    assert.equal(fixture.submissions.length, 1, 'Loading ongoing work must not submit a replacement task')
    fixture.finish(Number(sessionId), 'finished on the phone')
    await until(() => second!.updates.some(item => item.update.sessionUpdate === 'agent_message_chunk' && item.update.content.type === 'text' && item.update.content.text === 'finished on the phone'))
    assert.ok(second.updates.some(item => item.update.sessionUpdate === 'user_message_chunk' && item.update.content.type === 'text' && item.update.content.text === 'keep working after loss'))
    assert.equal(fixture.submissions.length, 1)
    assert.equal(fixture.aborts, 0)
    assert.equal(fixture.answers.length, 0)
    assert.equal(fixture.privateAnswers.length, 0)
  } finally { first.connection.close(); second?.connection.close(); await fixture.close() }
})

test('explicit prompt cancellation remains separate from a pending health check', { timeout: 5000 }, async () => {
  const fixture = await new PhoneFixture().start()
  const { connection, failures } = connect(fixture)
  try {
    await initialize(connection)
    const { sessionId } = await connection.agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, workspace)
    const prompt = connection.agent.request<acp.PromptResponse>(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'explicitly cancel this task' }] })
    await fixture.submitted.promise
    fixture.meHang = true
    await until(() => fixture.meRequests === 2 && fixture.meActive === 1)
    await connection.agent.notify(acp.methods.agent.session.cancel, { sessionId })
    assert.equal((await prompt).stopReason, 'cancelled')
    fixture.meHang = false
    await until(() => fixture.meRequests >= 4)
    assert.equal(connection.signal.aborted, false)
    assert.deepEqual(failures, [])
    assert.equal(fixture.aborts, 1, 'Only the explicit user cancellation may stop phone work')
    assert.equal(fixture.submissions.length, 1)
  } finally { connection.close(); await fixture.close() }
})

test('initialization and operations cannot succeed before the startup read completes', { timeout: 5000 }, async () => {
  const fixture = await new PhoneFixture().start()
  fixture.meHang = true
  const { connection, failures } = connect(fixture)
  let initialized = false
  try {
    const init = initialize(connection).then(result => { initialized = true; return result })
    const initRejected = assert.rejects(init)
    const created = connection.agent.request(acp.methods.agent.session.new, workspace)
    const createRejected = assert.rejects(created)
    await until(() => fixture.meActive === 1)
    await delay(30)
    assert.equal(initialized, false)
    assert.equal(fixture.conversations.size, 0)
    assert.equal(fixture.meRequests, 1, 'Initialization and operations share the startup read')
    connection.close()
    await Promise.all([initRejected, createRejected])
    await until(() => fixture.meActive === 0)
    assert.deepEqual(failures, [])
  } finally { connection.close(); await fixture.close() }
})

test('health loss withdraws a local approval dialog without answering or stopping phone work', { timeout: 5000 }, async () => {
  const fixture = await new PhoneFixture().start()
  const asked = Promise.withResolvers<void>()
  const dialogClosed = Promise.withResolvers<void>()
  const client = acp.client().onRequest(acp.methods.client.session.requestPermission, async ({ signal }) => {
    asked.resolve()
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    dialogClosed.resolve()
    return { outcome: { outcome: 'cancelled' } }
  })
  const connection = client.connect(createAdapter(backend(fixture), { availability }))
  try {
    await initialize(connection)
    const { sessionId } = await connection.agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, workspace)
    const prompt = connection.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'wait for approval' }] })
    const rejected = assert.rejects(prompt)
    await fixture.submitted.promise
    fixture.conversations.get(Number(sessionId))!.approvals = [riskyApproval]
    fixture.publish(Number(sessionId))
    await asked.promise
    fixture.meStatus = 401
    await connection.closed
    await rejected
    await dialogClosed.promise
    assert.equal(fixture.aborts, 0)
    assert.equal(fixture.submissions.length, 1)
    assert.deepEqual(fixture.answers, [])
    assert.deepEqual(fixture.privateAnswers, [])
    assert.equal(fixture.conversations.get(Number(sessionId))!.busy, true)
    assert.deepEqual(fixture.conversations.get(Number(sessionId))!.approvals, [riskyApproval])
  } finally { connection.close(); await fixture.close() }
})
