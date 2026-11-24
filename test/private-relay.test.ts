import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as acp from '@agentclientprotocol/sdk/unstable'
import { createAdapter } from '../src/adapter.js'
import { Projection } from '../src/projection.js'
import { forwardOrdinarySensitive } from '../src/ordinary-input.js'
import { forwardSecretAsk } from '../src/private-input.js'
import { SecretFiles } from '../src/secret-files.js'
import type { PhoneBackend, PhoneEvent, PrivateApproval, SecretAskApproval } from '../src/phone.js'
import { browserCode, browserLogin, computerLogin, privateApproval, privateView, storeSecret } from './private-fixture.js'
import { HttpPhoneBackend } from '../src/backend.js'
import { PhoneHttp } from '../src/http.js'
import { PhoneFixture } from './fixture.js'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)) }
  assert.fail('Fixture did not settle')
}
class PrivatePhone implements PhoneBackend {
  async doctor() { return { role: 'owner', compatibleShape: true, runtimeVersionVerified: false } }

  readonly ended = Promise.withResolvers<void>()
  readonly wake = Promise.withResolvers<void>()
  readonly posted = Promise.withResolvers<void>()
  readonly extra: PhoneEvent[] = []
  readonly answers: Record<string, string>[] = []
  readonly declines: string[] = []
  failDecline = false
  stops = 0
  checks = 0
  changed = false
  failAnswer = false
  asyncMode = false
  replay = false
  constructor(readonly approval: Extract<PhoneEvent, { type: 'approval' }> = privateApproval()) {}
  async create() { return { id: '1', history: [] } }
  async load() { return { id: '1', history: [], replay: [this.approval] } }
  async *run(_id: string, _text: string, _request: string, signal: AbortSignal): AsyncGenerator<PhoneEvent> {
    yield this.approval
    if (!this.asyncMode) await Promise.race([this.ended.promise, new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))])
    signal.throwIfAborted()
    yield { type: 'end', reason: 'end_turn' }
  }
  async *observe(_id: string, signal: AbortSignal): AsyncGenerator<PhoneEvent> {
    while (!signal.aborted) {
      yield* this.extra.splice(0)
      await Promise.race([this.wake.promise, new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))])
      if (!this.extra.length) break
    }
  }
  async cancel() { this.stops++; this.ended.resolve() }
  async answerApproval() { assert.fail('Private decisions must use the identity-checked private handler') }
  async declinePrivate(id: string, approval: PrivateApproval, signal: AbortSignal) {
    if (!await this.privateFormCurrent(id, approval, signal)) throw new Error('DO_NOT_LEAK changed request')
    signal.throwIfAborted()
    this.declines.push(approval.id)
    if (this.failDecline) throw new Error('DO_NOT_LEAK uncertain decline')
    this.ended.resolve()
  }
  async privateFormCurrent(_id: string, _approval: PrivateApproval, signal: AbortSignal) { signal.throwIfAborted(); this.checks++; return !this.changed }
  async answerPrivate(id: string, approval: PrivateApproval, values: Record<string, string>, signal: AbortSignal) {
    if (!await this.privateFormCurrent(id, approval, signal)) throw new Error('DO_NOT_LEAK changed request')
    signal.throwIfAborted()
    this.answers.push({ ...values }); this.posted.resolve()
    if (this.failAnswer) throw new Error('DO_NOT_LEAK uncertain POST')
    this.ended.resolve()
  }
  async secretAskCurrent(_id: string, _approval: SecretAskApproval, signal: AbortSignal) { signal.throwIfAborted(); this.checks++; return !this.changed }
  async answerSecretAsk(id: string, approval: SecretAskApproval, values: Record<string, string>, signal: AbortSignal) {
    if (!await this.secretAskCurrent(id, approval, signal)) throw new Error('DO_NOT_LEAK changed extension request')
    signal.throwIfAborted()
    this.answers.push({ ...values }); this.posted.resolve()
    if (this.failAnswer) throw new Error('DO_NOT_LEAK uncertain extension POST')
    this.ended.resolve()
  }
  async declineSecretAsk(id: string, approval: SecretAskApproval, signal: AbortSignal) {
    if (!await this.secretAskCurrent(id, approval, signal)) throw new Error('DO_NOT_LEAK changed extension request')
    signal.throwIfAborted()
    this.declines.push(approval.id)
    if (this.failDecline) throw new Error('DO_NOT_LEAK uncertain extension decline')
    this.ended.resolve()
  }
  withdraw() { this.changed = true; this.extra.push({ type: 'approval_withdrawn', id: this.approval.id }); this.wake.resolve() }
}
type OrdinaryRequest = Extract<acp.CreateElicitationRequest, { requestedSchema: unknown }> & { requestedSchema: { properties: Record<string, acp.ElicitationPropertySchema> } }
interface HarnessOptions {
  ordinaryRespond?: (params: OrdinaryRequest, signal: AbortSignal) => unknown | Promise<unknown>
  formSupport?: boolean
  server?: boolean
  backend?: PhoneBackend
  secretFilesDir?: string
  connect?: () => Promise<unknown>
  initializeVersion?: string
  respond?: (index: number, save: (value: string) => Promise<unknown>) => Promise<unknown> | unknown
}
async function harness(phone = new PrivatePhone(), options: HarnessOptions = {}) {
  const base = await mkdtemp(join(tmpdir(), 'private-relay-'))
  const directory = join(base, 'files')
  await mkdir(directory, { mode: 0o700 })
  const files: string[] = []
  const requests: { method: string, params: Record<string, unknown> }[] = []
  const updates: acp.SessionNotification[] = []
  const formRequests: OrdinaryRequest[] = []
  let cards = 0
  let ordinaryRequests = 0
  let disconnects = 0
  let initialized = false
  const save = async (value: string) => {
    const file = join(directory, randomBytes(16).toString('hex'))
    await writeFile(file, value, { mode: 0o600, flag: 'wx' }); files.push(file)
    const result = { status: 'saved', file }
    return { isError: false, structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }
  }
  const client = acp.client()
    .onRequest(acp.methods.client.elicitation.create, async ({ params, signal }) => {
      assert.equal(params.mode, 'form')
      const form = params as OrdinaryRequest
      assert.ok(form.requestedSchema.properties)
      formRequests.push(form)
      if (!options.ordinaryRespond) { ordinaryRequests++; assert.fail('Unexpected ordinary elicitation') }
      return await options.ordinaryRespond(form, signal) as acp.CreateElicitationResponse
    })
    .onRequest(acp.methods.client.session.requestPermission, () => { ordinaryRequests++; assert.fail('Secrets must never enter permission UI') })
    // Installed T3's legacy connectionId-based carrier is different from the
    // SDK's current serverId/requestId carrier; handle its raw wire here.
    .onRequest('*', async ({ method, params }) => {
      const p = params as Record<string, unknown>
      requests.push({ method, params: p })
      if (method === 'mcp/connect') { assert.deepEqual(p, { serverId: 't3-code' }); return options.connect ? await options.connect() : { connectionId: 'private-connection' } }
      if (method === 'mcp/disconnect') { disconnects++; assert.deepEqual(p, { connectionId: 'private-connection' }); return {} }
      assert.equal(method, 'mcp/message'); assert.equal(p.connectionId, 'private-connection')
      if (p.method === 'initialize') {
        assert.deepEqual(p.params, { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pi-phone-acp', version: '0.1.0' } })
        return { protocolVersion: options.initializeVersion ?? '2025-06-18', capabilities: {}, serverInfo: { name: 'T3 Code', version: '0.1.8' } }
      }
      assert.ok(initialized)
      assert.equal(p.method, 'tools/call')
      const inner = p.params as { name: string, arguments: Record<string, unknown> }
      assert.equal(inner.name, 'request_secret'); assert.equal(inner.arguments.delivery, 'file')
      assert.equal(Object.hasOwn(inner.arguments, 'value'), false)
      assert.equal(Object.hasOwn(p, 'sessionId'), false)
      return await (options.respond ? options.respond(cards++, save) : save('001234'))
    })
    .onNotification('*', ({ method, params }) => {
      if (method === 'mcp/message') {
        assert.deepEqual(params, { connectionId: 'private-connection', method: 'notifications/initialized' }); initialized = true
      }
    })
    .onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params) })
  const connection = client.connect(createAdapter(options.backend ?? phone, { secretFiles: new SecretFiles(options.secretFilesDir ?? directory), secretTimeoutMs: 1000 }))
  const agent = connection.agent
  await agent.request(acp.methods.agent.initialize, { protocolVersion: 2, ...(options.formSupport ? { clientCapabilities: { elicitation: { form: {} } } } : {}) }) // No ordinary form capability needed.
  const workspace = { cwd: '/t3/project', mcpServers: options.server === false ? [] : [{ type: 'acp' as const, name: 't3-code', serverId: 't3-code' }] }
  await agent.request(acp.methods.agent.session.new, workspace)
  const result = agent.request(acp.methods.agent.session.prompt, { sessionId: '1', prompt: [{ type: 'text', text: 'Fixture private request' }] })
  void result.catch(() => {})
  return { phone, agent, connection, result, requests, formRequests, updates, files, directory, workspace, save,
    disconnects: () => disconnects,
    close: async () => { connection.close(); await rm(base, { recursive: true, force: true }); assert.equal(ordinaryRequests, 0, 'Private collection must not open ordinary forms or permission UI') } }
}
async function fallback(h: Awaited<ReturnType<typeof harness>>) {
  await until(() => h.updates.some(update => JSON.stringify(update).includes('phone')))
  h.phone.ended.resolve()
  await h.result
}

test('forwards an OTP through the real ACP exchange with exact zeros, no ordinary UI, and immediate file deletion', async () => {
  const h = await harness()
  try {
    await h.result
    assert.deepEqual(h.phone.answers, [{ code: '001234' }])
    assert.deepEqual(await readdir(h.directory), [])
    assert.equal(h.disconnects(), 1)
    assert.equal(h.phone.stops, 0)
    assert.doesNotMatch(JSON.stringify(h.requests) + JSON.stringify(h.updates), /001234/)
  } finally { await h.close() }
})

for (const [form, tool, values] of [
  [browserLogin, 'browser_sign_in', ['CANARY_username', ' CANARY_password ']],
  [computerLogin, 'computer_sign_in', ['CANARY_password', '001234']],
  [storeSecret, 'secret_request', ['CANARY_store_secret']],
] as const) test(`collects all ${tool} fields privately before one native submission`, async () => {
  const phone = new PrivatePhone(privateApproval(form, tool))
  const h = await harness(phone, { respond: async (index, save) => {
    assert.deepEqual(phone.answers, [])
    if (index) assert.deepEqual(await readdir(h.directory), [])
    return save(values[index]!)
  } })
  try {
    await h.result
    assert.equal(phone.answers.length, 1)
    assert.deepEqual(Object.values(phone.answers[0]!), [...values])
    assert.deepEqual(await readdir(h.directory), [])
    assert.doesNotMatch(JSON.stringify(h.requests) + JSON.stringify(h.updates), /CANARY_/)
    assert.equal(h.disconnects(), 1)
  } finally { await h.close() }
})

for (const status of ['cancelled', 'timed_out']) test(`${status} on a later private field discards the whole answer and leaves the phone waiting`, async () => {
  const phone = new PrivatePhone(privateApproval(browserLogin, 'browser_sign_in'))
  const h = await harness(phone, { respond: (index, save) => index === 0 ? save('CANARY_partial') : {
    isError: false, structuredContent: { status }, content: [{ type: 'text', text: JSON.stringify({ status }) }],
  } })
  try {
    await fallback(h)
    assert.deepEqual(phone.answers, [])
    assert.equal(phone.stops, 0)
    assert.deepEqual(await readdir(h.directory), [])
    assert.equal(h.disconnects(), 1)
    assert.doesNotMatch(JSON.stringify(h.requests) + JSON.stringify(h.updates), /CANARY_/)
  } finally { await h.close() }
})

test('no declared helper or changed ownership/request means no card and no ordinary fallback', async () => {
  for (const mode of ['server', 'changed']) {
    const phone = new PrivatePhone(); phone.changed = mode === 'changed'
    const h = await harness(phone, { server: mode !== 'server' })
    try { await fallback(h); assert.equal(h.requests.length, 0); assert.deepEqual(phone.answers, []) } finally { await h.close() }
  }
})

test('refuses a different MCP protocol before opening a secret card', async () => {
  const h = await harness(new PrivatePhone(), { initializeVersion: 'future' })
  try {
    await fallback(h)
    assert.equal(h.requests.some(request => request.params.method === 'tools/call'), false)
    assert.deepEqual(h.phone.answers, [])
    assert.equal(h.disconnects(), 1)
  } finally { await h.close() }
})

test('an uncertain native private POST is attempted once, with no values or raw errors in updates', async () => {
  const phone = new PrivatePhone(); phone.failAnswer = true
  const h = await harness(phone, { respond: (_index, save) => save('CANARY_uncertain') })
  try {
    await phone.posted.promise
    await fallback(h)
    assert.equal(phone.answers.length, 1)
    assert.deepEqual(await readdir(h.directory), [])
    assert.equal(h.requests.filter(request => request.params.method === 'tools/call').length, 1)
    assert.doesNotMatch(JSON.stringify(h.requests) + JSON.stringify(h.updates), /CANARY_|DO_NOT_LEAK/)
  } finally { await h.close() }
})

test('native changes after collection prevent submission without recollecting or retrying', async () => {
  const phone = new PrivatePhone()
  const h = await harness(phone, { respond: async (_index, save) => { phone.changed = true; return save('CANARY_changed') } })
  try {
    await fallback(h)
    assert.deepEqual(phone.answers, [])
    assert.deepEqual(await readdir(h.directory), [])
    assert.equal(h.requests.filter(request => request.params.method === 'tools/call').length, 1)
  } finally { await h.close() }
})

for (const action of ['withdraw', 'cancel']) test(`${action} disconnects the dedicated helper and cleans a late returned file without sending its value`, async () => {
  const phone = new PrivatePhone(); phone.asyncMode = true
  const answer = Promise.withResolvers<unknown>()
  const asked = Promise.withResolvers<void>()
  const h = await harness(phone, { respond: () => { asked.resolve(); return answer.promise } })
  try {
    await asked.promise
    if (action === 'withdraw') phone.withdraw()
    else await h.agent.notify(acp.methods.agent.session.cancel, { sessionId: '1' })
    await h.result
    assert.deepEqual(phone.answers, [])
    assert.equal(phone.stops, 0) // The phone model already ended; do not stop it for form cancellation.
    assert.equal(h.disconnects(), 1)
    answer.resolve(await h.save('CANARY_late'))
    const file = h.files[0]!
    for (let count = 0; count < 100; count++) {
      if (await lstat(file).then(() => false, () => true)) break
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    await assert.rejects(lstat(file), { code: 'ENOENT' })
    assert.doesNotMatch(JSON.stringify(h.requests) + JSON.stringify(h.updates), /CANARY_/)
  } finally { await h.close() }
})

test('malformed and failed delivery results are not echoed and any received file is discarded', async () => {
  for (const mode of ['error', 'unknown', 'mismatch', 'reference']) {
    const h = await harness(new PrivatePhone(), { respond: async (_index, save) => {
      const result = await save('CANARY_malformed') as { isError: boolean, structuredContent: Record<string, unknown>, content: { type: string, text: string }[] }
      if (mode === 'error') result.isError = true
      if (mode === 'unknown') result.structuredContent.value = 'DO_NOT_LEAK'
      if (mode === 'mismatch') result.content[0]!.text = JSON.stringify({ status: 'cancelled' })
      if (mode === 'reference') result.structuredContent = { status: 'saved', secretRef: 'DO_NOT_LEAK' }
      return result
    } })
    try {
      await fallback(h)
      assert.deepEqual(h.phone.answers, [])
      assert.deepEqual(await readdir(h.directory), [])
      assert.doesNotMatch(JSON.stringify(h.updates), /CANARY_|DO_NOT_LEAK|ZodError/)
    } finally { await h.close() }
  }
})

test('reconnect replay does not open a private card or resend the native answer', async () => {
  const h = await harness()
  try {
    await h.result
    const count = h.requests.length
    await h.agent.request(acp.methods.agent.session.load, { ...h.workspace, sessionId: '1' })
    assert.equal(h.requests.length, count)
    assert.equal(h.phone.answers.length, 1)
    assert.match(JSON.stringify(h.updates), /reconnect replay is observation only/)
  } finally { await h.close() }
})

for (const [form, tool, values, route] of [
  [browserCode, 'browser_ask_code', ['001234'], 'browser/asks'],
  [browserLogin, 'browser_sign_in', ['CANARY_http_user', 'CANARY_http_password'], 'browser/asks'],
  [computerLogin, 'computer_sign_in', ['CANARY_http_password', '001234'], 'computer/asks'],
  [storeSecret, 'secret_request', ['CANARY_http_store'], 'secrets/requests'],
] as const) test(`source-shaped HTTP + real ACP: ${tool} reaches only its matching dedicated endpoint`, async () => {
  const fixture = await new PhoneFixture().start()
  const backend = new HttpPhoneBackend(new PhoneHttp(fixture.url, fixture.token), '/phone/work', 0)
  const h = await harness(new PrivatePhone(), { backend, respond: (index, save) => save(values[index]!) })
  try {
    await fixture.submitted.promise
    const native = privateView(form, tool).approvals![0]!
    native.id = 'private/request/1'; native.callId = 'private/call/1'
    fixture.conversations.get(1)!.approvals = [native]
    fixture.publish(1)
    await h.result
    const named = form.type === 'secret' ? { value: values[0] }
      : { values: Object.fromEntries(form.fields.map((field, index) => [field.name, values[index]])), remember: false, useSaved: false }
    assert.deepEqual(fixture.privateAnswers, [{ path: `/api/${route}/private%2Frequest%2F1`, body: named }])
    assert.deepEqual(fixture.answers, [])
    assert.equal(fixture.aborts, 0)
    assert.deepEqual(await readdir(h.directory), [])
    assert.doesNotMatch(JSON.stringify(h.requests) + JSON.stringify(h.updates), /CANARY_http|001234/)
  } finally { await h.close(); await fixture.close() }
})

for (const mode of ['permissions', 'oversize', 'newline', 'missing']) test(`${mode} private file causes no native answer and no ordinary fallback`, async () => {
  const h = await harness(new PrivatePhone(), { respond: async (_index, save) => {
    const reply = await save('CANARY_bad_file') as { structuredContent: { file: string } }
    const file = reply.structuredContent.file
    if (mode === 'permissions') await chmod(file, 0o644)
    if (mode === 'oversize') await writeFile(file, 'x'.repeat(65537))
    if (mode === 'newline') await writeFile(file, 'CANARY_bad_file\n')
    if (mode === 'missing') await unlink(file)
    return reply
  } })
  try {
    await fallback(h)
    assert.deepEqual(h.phone.answers, [])
    assert.deepEqual(await readdir(h.directory), [])
    assert.doesNotMatch(JSON.stringify(h.updates), /CANARY_|private-relay-|ZodError|ENOENT/)
  } finally { await h.close() }
})

test('a private MCP failure is sanitized and never retried or redirected to ordinary elicitation', async () => {
  const h = await harness(new PrivatePhone(privateApproval(browserLogin, 'browser_sign_in')), { respond: (index, save) => {
    if (index === 0) return save('CANARY_partial')
    throw new acp.RequestError(-32603, 'DO_NOT_LEAK transport failure', { details: 'CANARY_transport' })
  } })
  try {
    await fallback(h)
    assert.deepEqual(h.phone.answers, [])
    assert.deepEqual(await readdir(h.directory), [])
    assert.equal(h.requests.filter(request => request.params.method === 'tools/call').length, 2)
    assert.doesNotMatch(JSON.stringify(h.updates), /CANARY_|DO_NOT_LEAK/)
  } finally { await h.close() }
})

test('an unusable exact-directory setting stays phone-only before creating a card', async () => {
  const h = await harness(new PrivatePhone(), { secretFilesDir: 'relative/not-allowed' })
  try { await fallback(h); assert.deepEqual(h.requests, []); assert.deepEqual(h.phone.answers, []) } finally { await h.close() }
})

test('active global Stop cancels the phone once, closes the private helper, and discards a late answer', async () => {
  const reply = Promise.withResolvers<unknown>()
  const asked = Promise.withResolvers<void>()
  const h = await harness(new PrivatePhone(), { respond: () => { asked.resolve(); return reply.promise } })
  try {
    await asked.promise
    await h.agent.notify(acp.methods.agent.session.cancel, { sessionId: '1' })
    assert.equal((await h.result).stopReason, 'cancelled')
    assert.equal(h.phone.stops, 1)
    assert.equal(h.disconnects(), 1)
    reply.resolve(await h.save('CANARY_cancelled'))
    await until(() => h.files.length === 1)
    for (let count = 0; count < 200; count++) {
      if (await lstat(h.files[0]!).then(() => false, () => true)) break
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    assert.deepEqual(await readdir(h.directory), [])
    assert.deepEqual(h.phone.answers, [])
  } finally { await h.close() }
})

test('cancelling before connect returns disconnects the late connection without asking for a secret', async () => {
  const opened = Promise.withResolvers<unknown>()
  const opening = Promise.withResolvers<void>()
  const h = await harness(new PrivatePhone(), { connect: () => { opening.resolve(); return opened.promise } })
  try {
    await opening.promise
    await h.agent.notify(acp.methods.agent.session.cancel, { sessionId: '1' })
    assert.equal((await h.result).stopReason, 'cancelled')
    opened.resolve({ connectionId: 'private-connection' })
    await until(() => h.disconnects() === 1)
    assert.equal(h.requests.some(request => request.method === 'mcp/message'), false)
    assert.deepEqual(h.phone.answers, [])
  } finally { await h.close() }
})

test('transport disconnect after a partial private collection sends no native answer and does not stop phone work', async () => {
  const waiting = Promise.withResolvers<void>()
  const blocked = Promise.withResolvers<unknown>()
  const h = await harness(new PrivatePhone(privateApproval(browserLogin, 'browser_sign_in')), { respond: (index, save) => {
    if (index === 0) return save('CANARY_disconnected')
    waiting.resolve(); return blocked.promise
  } })
  try {
    await waiting.promise
    assert.deepEqual(await readdir(h.directory), [])
    h.connection.close()
    await h.result.catch(() => {})
    assert.deepEqual(h.phone.answers, [])
    assert.equal(h.phone.stops, 0)
    assert.doesNotMatch(JSON.stringify(h.updates), /CANARY_/)
    blocked.resolve({ isError: true, content: [] })
  } finally { await h.close() }
})

test('invalid content in the first mixed-form field stops collection before asking for any other field', async () => {
  const h = await harness(new PrivatePhone(privateApproval(browserLogin, 'browser_sign_in')), { respond: (_index, save) => save('CANARY_invalid\n') })
  try {
    await fallback(h)
    assert.equal(h.requests.filter(request => request.params.method === 'tools/call').length, 1)
    assert.deepEqual(h.phone.answers, [])
    assert.deepEqual(await readdir(h.directory), [])
  } finally { await h.close() }
})

test('Stop aborts private collection immediately, without waiting for the phone Stop acknowledgement', async () => {
  const stop = Promise.withResolvers<void>()
  class SlowStopPhone extends PrivatePhone {
    override async cancel() { this.stops++; await stop.promise }
  }
  const phone = new SlowStopPhone()
  const asked = Promise.withResolvers<void>()
  const reply = Promise.withResolvers<unknown>()
  const h = await harness(phone, { respond: () => { asked.resolve(); return reply.promise } })
  try {
    await asked.promise
    await h.agent.notify(acp.methods.agent.session.cancel, { sessionId: '1' })
    await until(() => phone.stops === 1 && h.disconnects() === 1)
    reply.resolve(await h.save('CANARY_stop_race'))
    for (let count = 0; count < 200; count++) {
      if (await lstat(h.files[0]!).then(() => false, () => true)) break
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    assert.deepEqual(await readdir(h.directory), [])
    assert.deepEqual(phone.answers, [])
    phone.ended.resolve(); stop.resolve()
    assert.equal((await h.result).stopReason, 'cancelled')
  } finally { stop.resolve(); await h.close() }
})

for (const [form, tool] of [[browserCode, 'browser_ask_code'], [browserLogin, 'browser_sign_in'], [computerLogin, 'computer_sign_in'], [storeSecret, 'secret_request']] as const) {
  test(`explicit Decline completes ${tool} by rejecting only its native request`, { timeout: 5000 }, async () => {
    const phone = new PrivatePhone(privateApproval(form, tool))
    const h = await harness(phone, { respond: () => ({ isError: false, structuredContent: { status: 'declined' }, content: [{ type: 'text', text: '{"status":"declined"}' }] }) })
    try {
      assert.equal((await h.result).stopReason, 'end_turn')
      assert.deepEqual(phone.declines, [phone.approval.id])
      assert.deepEqual(phone.answers, [])
      assert.equal(phone.stops, 0)
      assert.equal(h.disconnects(), 1)
      assert.deepEqual(await readdir(h.directory), [])
    } finally { await h.close() }
  })
}

test('Decline on the second field completes the native request without submitting partial values', { timeout: 5000 }, async () => {
  const phone = new PrivatePhone(privateApproval(browserLogin, 'browser_sign_in'))
  const h = await harness(phone, { respond: (index, save) => index === 0 ? save('CANARY_partial_decline') : {
    isError: false, structuredContent: { status: 'declined' }, content: [{ type: 'text', text: '{"status":"declined"}' }],
  } })
  try {
    await h.result
    assert.deepEqual(phone.declines, [phone.approval.id])
    assert.deepEqual(phone.answers, [])
    assert.equal(phone.stops, 0)
    assert.deepEqual(await readdir(h.directory), [])
    assert.doesNotMatch(JSON.stringify(h.requests) + JSON.stringify(h.updates), /CANARY_/)
  } finally { await h.close() }
})

test('changed native identity prevents a Decline from rejecting a replacement', async () => {
  const phone = new PrivatePhone()
  const h = await harness(phone, { respond: () => {
    phone.changed = true
    return { isError: false, structuredContent: { status: 'declined' }, content: [{ type: 'text', text: '{"status":"declined"}' }] }
  } })
  try { await fallback(h); assert.deepEqual(phone.declines, []); assert.deepEqual(phone.answers, []); assert.equal(phone.stops, 0) } finally { await h.close() }
})

test('an uncertain Decline POST is not retried and does not submit secret values', async () => {
  const phone = new PrivatePhone(); phone.failDecline = true
  const h = await harness(phone, { respond: () => ({ isError: false, structuredContent: { status: 'declined' }, content: [{ type: 'text', text: '{"status":"declined"}' }] }) })
  try {
    await fallback(h)
    assert.deepEqual(phone.declines, [phone.approval.id])
    assert.deepEqual(phone.answers, [])
    assert.doesNotMatch(JSON.stringify(h.updates), /DO_NOT_LEAK/)
  } finally { await h.close() }
})

test('a Decline result arriving after local cancellation must not reject the native request', async () => {
  const asked = Promise.withResolvers<void>()
  const reply = Promise.withResolvers<unknown>()
  const h = await harness(new PrivatePhone(), { respond: () => { asked.resolve(); return reply.promise } })
  try {
    await asked.promise
    await h.agent.notify(acp.methods.agent.session.cancel, { sessionId: '1' })
    await h.result
    reply.resolve({ isError: false, structuredContent: { status: 'declined' }, content: [{ type: 'text', text: '{"status":"declined"}' }] })
    await tick(); await tick()
    assert.deepEqual(h.phone.declines, [])
    assert.deepEqual(h.phone.answers, [])
  } finally { await h.close() }
})

const extensionForm = {
  type: 'ask', title: 'Extension account', text: 'Enter dummy extension details.', submit: 'Send details',
  fields: [
    { name: 'account', label: 'Account name', placeholder: 'Dummy name' },
    { name: 'accessKey', label: 'Access key', secret: true, autocomplete: 'new-password' },
  ],
}
function extensionApproval(form: unknown = extensionForm): SecretAskApproval {
  const event = new Projection().consume(privateView(form, 'extension_question'))[0]
  assert.ok(event?.type === 'approval' && event.form?.type === 'ask')
  return { ...event, form: event.form }
}

for (const fields of [extensionForm.fields, [extensionForm.fields[1]!], Array.from({ length: 6 }, (_, index) => ({ name: `field${index}`, label: `Field ${index}`, secret: index === 5 }))]) {
  test(`secret extension forms collect all ${fields.length} named fields privately, then submit once`, async () => {
    const phone = new PrivatePhone(extensionApproval({ ...extensionForm, fields }))
    const values = fields.map((_, index) => index === fields.length - 1 ? '001234' : 'CANARY_extension_account')
    const h = await harness(phone, { formSupport: true, respond: async (index, save) => {
      assert.deepEqual(phone.answers, [])
      assert.deepEqual(await readdir(h.directory), [])
      return save(values[index]!)
    } })
    try {
      await h.result
      assert.deepEqual(phone.answers, [Object.fromEntries(fields.map((field, index) => [field.name, values[index]]))])
      assert.equal(phone.checks, 2)
      assert.equal(h.disconnects(), 1)
      assert.deepEqual(await readdir(h.directory), [])
      assert.doesNotMatch(JSON.stringify(h.requests) + JSON.stringify(h.updates), /CANARY_|001234/)
      const cards = h.requests.filter(request => request.params.method === 'tools/call')
      assert.equal(cards.length, fields.length)
      for (const [index, card] of cards.entries()) {
        const args = (card.params.params as { arguments: Record<string, unknown> }).arguments
        assert.equal(args.label, `${fields[index]!.label} (${index + 1}/${fields.length})`)
        assert.match(String(args.reason), /Extension account/)
        assert.match(String(args.reason), /Submit action: Send details/)
        assert.match(String(args.reason), /developer determines whether they are saved or returned/)
        assert.match(String(args.reason), /Private entry does not make that later use private/)
      }
    } finally { await h.close() }
  })
}

test('extension values keep native string semantics, including newlines and outer whitespace delivered by the helper', async () => {
  const phone = new PrivatePhone(extensionApproval())
  const h = await harness(phone, { respond: (index, save) => save(index ? ' CANARY_extension\nvalue ' : 'dummy') })
  try {
    await h.result
    assert.deepEqual(phone.answers, [{ account: 'dummy', accessKey: ' CANARY_extension\nvalue ' }])
    assert.doesNotMatch(JSON.stringify(h.requests) + JSON.stringify(h.updates), /CANARY_/)
  } finally { await h.close() }
})

for (const status of ['declined', 'cancelled', 'timed_out']) test(`extension ${status} after one collected field sends no partial values`, async () => {
  const phone = new PrivatePhone(extensionApproval())
  const h = await harness(phone, { respond: (index, save) => index === 0 ? save('CANARY_extension_partial') : {
    isError: false, structuredContent: { status }, content: [{ type: 'text', text: JSON.stringify({ status }) }],
  } })
  try {
    if (status === 'declined') await h.result
    else await fallback(h)
    assert.deepEqual(phone.answers, [])
    assert.deepEqual(phone.declines, status === 'declined' ? [phone.approval.id] : [])
    assert.equal(phone.stops, 0)
    assert.equal(h.disconnects(), 1)
    assert.deepEqual(await readdir(h.directory), [])
    assert.doesNotMatch(JSON.stringify(h.requests) + JSON.stringify(h.updates), /CANARY_/)
  } finally { await h.close() }
})

for (const mode of ['no-helper', 'changed', 'missing-handler', 'invalid-directory']) test(`secret extension ${mode} stays on the phone without opening ordinary fields`, async () => {
  const phone = new PrivatePhone(extensionApproval())
  phone.changed = mode === 'changed'
  const h = await harness(phone, {
    formSupport: mode !== 'no-helper', server: mode !== 'no-helper',
    ...(mode === 'missing-handler' ? { backend: Object.assign(phone, { answerSecretAsk: undefined }) as PhoneBackend } : {}),
    ...(mode === 'invalid-directory' ? { secretFilesDir: 'relative/not-allowed' } : {}),
  })
  try {
    await fallback(h)
    assert.deepEqual(h.requests, [])
    assert.deepEqual(phone.answers, [])
    assert.deepEqual(phone.declines, [])
  } finally { await h.close() }
})

for (const mode of ['changed', 'uncertain-answer', 'uncertain-decline', 'helper-error', 'malformed-reply', 'bad-permissions', 'empty', 'oversize']) {
  test(`secret extension ${mode} prevents resubmission and keeps failures secret-free`, async () => {
    const phone = new PrivatePhone(extensionApproval())
    phone.failAnswer = mode === 'uncertain-answer'
    phone.failDecline = mode === 'uncertain-decline'
    const h = await harness(phone, { formSupport: true, respond: async (index, save) => {
      if (index === 0) return save('CANARY_extension_partial')
      if (mode === 'changed') phone.changed = true
      if (mode === 'uncertain-decline') return { isError: false, structuredContent: { status: 'declined' }, content: [{ type: 'text', text: '{"status":"declined"}' }] }
      if (mode === 'helper-error') throw new Error('DO_NOT_LEAK helper failure')
      const reply = await save(mode === 'empty' ? '' : mode === 'oversize' ? 'x'.repeat(4097) : 'CANARY_extension_value') as { isError: boolean, structuredContent: { file: string } }
      if (mode === 'malformed-reply') reply.isError = true
      if (mode === 'bad-permissions') await chmod(reply.structuredContent.file, 0o644)
      return reply
    } })
    try {
      await fallback(h)
      assert.equal(phone.answers.length, mode === 'uncertain-answer' ? 1 : 0)
      assert.equal(phone.declines.length, mode === 'uncertain-decline' ? 1 : 0)
      assert.equal(h.requests.filter(request => request.params.method === 'tools/call').length, 2)
      assert.equal(h.disconnects(), 1)
      assert.deepEqual(await readdir(h.directory), [])
      assert.doesNotMatch(JSON.stringify(h.requests) + JSON.stringify(h.updates), /CANARY_|DO_NOT_LEAK|ZodError|EACCES/)
    } finally { await h.close() }
  })
}

for (const action of ['withdraw', 'cancel', 'disconnect']) test(`secret extension ${action} sends no answer or decline and cleans received files`, async () => {
  const phone = new PrivatePhone(extensionApproval())
  phone.asyncMode = action !== 'disconnect'
  const pending = Promise.withResolvers<unknown>()
  const asked = Promise.withResolvers<void>()
  const h = await harness(phone, { respond: (index, save) => {
    if (index === 0) return save('CANARY_extension_partial')
    asked.resolve(); return pending.promise
  } })
  try {
    await asked.promise
    assert.deepEqual(await readdir(h.directory), [])
    if (action === 'withdraw') phone.withdraw()
    else if (action === 'cancel') await h.agent.notify(acp.methods.agent.session.cancel, { sessionId: '1' })
    else h.connection.close()
    await h.result.catch(error => { if (action !== 'disconnect') throw error })
    // A disconnected transport cannot deliver a new path; only received files can be removed.
    if (action === 'disconnect') pending.resolve({ isError: true, content: [] })
    else pending.resolve(await h.save('CANARY_extension_late'))
    for (let count = 0; count < 200; count++) {
      if ((await readdir(h.directory)).length === 0) break
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    assert.deepEqual(await readdir(h.directory), [])
    assert.deepEqual(phone.answers, [])
    assert.deepEqual(phone.declines, [])
    assert.equal(phone.stops, 0)
    assert.doesNotMatch(JSON.stringify(h.requests) + JSON.stringify(h.updates), /CANARY_/)
  } finally { await h.close() }
})

test('secret extension replay remains observation-only without opening another password card', async () => {
  const phone = new PrivatePhone(extensionApproval())
  const h = await harness(phone)
  try {
    await h.result
    const count = h.requests.length
    await h.agent.request(acp.methods.agent.session.load, { ...h.workspace, sessionId: '1' })
    assert.equal(h.requests.length, count)
    assert.equal(phone.answers.length, 1)
    assert.match(JSON.stringify(h.updates), /reconnect replay is observation only/)
  } finally { await h.close() }
})

test('secret extension validation runs even when another backend bypasses Projection', async () => {
  for (const form of [
    { ...extensionForm, fields: [{ name: 'key', label: 'Key' }] },
    { ...extensionForm, unknown: 'DO_NOT_LEAK' },
    { ...extensionForm, fields: [...extensionForm.fields, extensionForm.fields[0]] },
  ]) {
    const item = { ...extensionApproval(), form } as SecretAskApproval
    const phone = new PrivatePhone(item)
    const client = { request: async () => { assert.fail('Unvalidated extension opened a card') } } as unknown as acp.AgentContext
    assert.equal(await forwardSecretAsk(phone, '1', item, client, new AbortController().signal, new SecretFiles('/unused')), 'phone')
    assert.equal(phone.checks, 0)
    assert.deepEqual(phone.answers, [])
  }
})

for (const uncertain of [false, true]) test(`secret extension real ACP + HTTP ${uncertain ? 'lost acknowledgement' : 'completion'} uses exactly one native ask POST`, async () => {
  const fixture = await new PhoneFixture().start()
  const answers: { path: string, body: unknown }[] = []
  let ownerChecks = 0
  let directory = ''
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/me') ownerChecks++
    if (url.pathname.startsWith('/api/asks/')) {
      assert.equal(init?.method, 'POST')
      assert.deepEqual(await readdir(directory), [])
      answers.push({ path: url.pathname, body: JSON.parse(String(init?.body)) })
      if (uncertain) throw new Error('DO_NOT_LEAK uncertain CANARY_http_extension')
      fixture.conversations.get(1)!.approvals = []
      fixture.finish(1, 'Extension completed.')
      return Response.json({ ok: true })
    }
    return fetch(input, init)
  }
  const backend = new HttpPhoneBackend(new PhoneHttp(fixture.url, fixture.token, request), '/phone/work', 0)
  const h = await harness(new PrivatePhone(), { backend, respond: (index, save) => save(index ? '001234' : 'CANARY_http_extension') })
  directory = h.directory
  try {
    await fixture.submitted.promise
    const native = privateView(extensionForm, 'extension_question').approvals![0]!
    native.id = 'extension/request/1'; native.callId = 'extension/call/1'
    fixture.conversations.get(1)!.approvals = [native]
    fixture.publish(1)
    if (uncertain) {
      await until(() => h.updates.some(update => JSON.stringify(update).includes('no automatic retry')))
      fixture.conversations.get(1)!.approvals = []
      fixture.finish(1, 'Complete after phone inspection.')
    }
    await h.result
    assert.equal(ownerChecks, 3, 'One startup check plus two input-owner checks')
    assert.deepEqual(answers, [{ path: '/api/asks/extension%2Frequest%2F1', body: { values: { account: 'CANARY_http_extension', accessKey: '001234' } } }])
    assert.deepEqual(fixture.privateAnswers, [])
    assert.deepEqual(fixture.answers, [])
    assert.equal(fixture.aborts, 0)
    assert.equal(h.disconnects(), 1)
    assert.deepEqual(await readdir(h.directory), [])
    assert.doesNotMatch(JSON.stringify(h.requests) + JSON.stringify(h.updates), /CANARY_|001234|DO_NOT_LEAK/)
  } finally { await h.close(); await fixture.close() }
})

test('an invalid first extension value stops collection before the next password card', async () => {
  const phone = new PrivatePhone(extensionApproval())
  const h = await harness(phone, { respond: (_index, save) => save('x'.repeat(4097)) })
  try {
    await fallback(h)
    assert.equal(h.requests.filter(request => request.params.method === 'tools/call').length, 1)
    assert.deepEqual(phone.answers, [])
    assert.deepEqual(phone.declines, [])
    assert.deepEqual(await readdir(h.directory), [])
  } finally { await h.close() }
})

const continueOrdinary = { action: 'accept', content: { collection: 'Continue with ordinary input' } }
const ordinaryCases = [
  { form: browserCode, tool: 'browser_ask_code', values: { code: '001234' }, path: '/api/browser/asks/', destination: /existing code fields/ },
  { form: browserLogin, tool: 'browser_sign_in', values: { username: ' CANARY_user ', password: ' CANARY_password ' }, path: '/api/browser/asks/', destination: /existing sign-in fields/ },
  { form: computerLogin, tool: 'computer_sign_in', values: { password: 'CANARY_password', code: '001234' }, path: '/api/computer/asks/', destination: /Dummy laptop/ },
  { form: storeSecret, tool: 'secret_request', values: { value: 'CANARY_saved_secret' }, path: '/api/secrets/requests/', destination: /Settings > Secrets/ },
  { form: extensionForm, tool: 'extension_question', values: { account: 'CANARY_account', accessKey: '001234' }, path: '/api/asks/', destination: /requesting extension/ },
] as const

for (const example of ordinaryCases) test(`ordinary ${example.tool} warns before all-field entry, preserves exact strings and submits once without private transport`, async () => {
  const phone = new PrivatePhone(example.form.type === 'ask' ? extensionApproval() : privateApproval(example.form, example.tool))
  const h = await harness(phone, { server: false, formSupport: true, secretFilesDir: '/does-not-exist', ordinaryRespond: params => {
    assert.deepEqual(phone.answers, [])
    assert.match(params.message, /not private delivery/)
    assert.match(params.message, /visible and retained in ADE history or logs/)
    assert.match(params.message, /Masking depends on the ADE/)
    assert.match(params.message, example.destination)
    const properties = params.requestedSchema.properties
    if ('collection' in properties) {
      assert.deepEqual(Object.keys(properties), ['collection'])
      assert.equal(phone.checks, 1)
      assert.match(String(properties.collection!.description), /not private delivery/)
      return continueOrdinary
    }
    assert.equal(phone.checks, 2)
    assert.deepEqual(params.requestedSchema.required, Object.keys(example.values))
    for (const property of Object.values(properties)) {
      assert.equal(property.type, 'string')
      assert.match(String(property.description), /not private delivery/)
    }
    return { action: 'accept', content: example.values }
  } })
  try {
    await h.result
    assert.deepEqual(phone.answers, [example.values])
    assert.equal(phone.checks, 3)
    assert.deepEqual(phone.declines, [])
    assert.deepEqual(h.requests, [])
    assert.equal(h.formRequests.length, 2)
    assert.deepEqual(await readdir(h.directory), [])
    assert.doesNotMatch(JSON.stringify(h.formRequests) + JSON.stringify(h.updates), /CANARY_|001234/)
  } finally { await h.close() }
})

for (const stage of ['warning', 'entry']) for (const outcome of ['phone', 'cancel', 'decline', 'malformed', 'unsupported', 'changed']) {
  if (stage === 'entry' && outcome === 'phone') continue
  test(`ordinary sensitive ${stage} ${outcome} never submits a partial form`, async () => {
    const phone = new PrivatePhone(extensionApproval())
    const h = await harness(phone, { server: false, formSupport: true, ordinaryRespond: params => {
      const warning = 'collection' in params.requestedSchema.properties
      if (warning && stage === 'entry') return continueOrdinary
      if (outcome === 'phone') return { action: 'accept', content: { collection: 'Complete in pi-phone' } }
      if (outcome === 'unsupported') throw new acp.RequestError(-32601, 'DO_NOT_LEAK CANARY_failure')
      if (outcome === 'malformed') return { action: 'accept', content: { account: 'CANARY_partial', collection: 'Continue with ordinary input' } }
      if (outcome === 'changed') { phone.changed = true; return warning ? continueOrdinary : { action: 'accept', content: { account: 'CANARY_partial', accessKey: '001234' } } }
      return { action: outcome }
    } })
    try {
      if (outcome === 'decline') await h.result
      else await fallback(h)
      assert.deepEqual(phone.answers, [])
      assert.deepEqual(phone.declines, outcome === 'decline' ? [phone.approval.id] : [])
      assert.equal(h.formRequests.length, stage === 'warning' ? 1 : 2)
      assert.deepEqual(h.requests, [])
      assert.equal(phone.stops, 0)
      assert.doesNotMatch(JSON.stringify(h.updates), /DO_NOT_LEAK|CANARY_|001234/)
    } finally { await h.close() }
  })
}

for (const example of ordinaryCases) for (const invalid of ['missing', 'extra', 'empty', 'oversize', 'numeric', 'newline', 'nul']) {
  if (example.form.type === 'ask' && (invalid === 'newline' || invalid === 'nul')) continue // Native extension asks allow line breaks.
  test(`ordinary ${example.tool} validates ${invalid} values before its native POST`, async () => {
    const phone = new PrivatePhone(example.form.type === 'ask' ? extensionApproval() : privateApproval(example.form, example.tool))
    const content: Record<string, unknown> = { ...example.values }
    const name = Object.keys(content)[0]!
    if (invalid === 'missing') delete content[name]
    else if (invalid === 'extra') content.unexpected = 'CANARY_extra'
    else content[name] = invalid === 'empty' ? '' : invalid === 'numeric' ? 1234 : invalid === 'newline' ? 'CANARY_line\n' : invalid === 'nul' ? 'CANARY_\u0000' : 'x'.repeat(example.form.type === 'ask' ? 4097 : 16_385)
    const h = await harness(phone, { server: false, formSupport: true, ordinaryRespond: params => 'collection' in params.requestedSchema.properties ? continueOrdinary : { action: 'accept', content } })
    try {
      await fallback(h)
      assert.deepEqual(phone.answers, [])
      assert.deepEqual(phone.declines, [])
      assert.equal(h.formRequests.length, 2)
      assert.doesNotMatch(JSON.stringify(h.updates), /CANARY_|1234|DO_NOT_LEAK/)
    } finally { await h.close() }
  })
}

for (const stage of ['warning', 'entry']) for (const action of ['withdraw', 'cancel', 'disconnect']) test(`ordinary sensitive ${action} during ${stage} ignores late answers without native decisions`, async () => {
  const phone = new PrivatePhone(extensionApproval())
  phone.asyncMode = action === 'withdraw'
  const asked = Promise.withResolvers<void>(), released = Promise.withResolvers<void>()
  const h = await harness(phone, { server: false, formSupport: true, ordinaryRespond: async (params, signal) => {
    const warning = 'collection' in params.requestedSchema.properties
    if (warning && stage === 'entry') return continueOrdinary
    asked.resolve()
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    released.resolve()
    return warning ? continueOrdinary : { action: 'accept', content: { account: 'CANARY_late', accessKey: '001234' } }
  } })
  try {
    const rejected = action === 'disconnect' ? assert.rejects(h.result) : undefined
    await asked.promise
    if (action === 'withdraw') phone.withdraw()
    else if (action === 'cancel') await h.agent.notify(acp.methods.agent.session.cancel, { sessionId: '1' })
    else { h.connection.close(); await rejected }
    await released.promise
    phone.ended.resolve()
    if (action !== 'disconnect') await h.result
    await tick()
    assert.deepEqual(phone.answers, [])
    assert.deepEqual(phone.declines, [])
    assert.equal(phone.stops, action === 'cancel' ? 1 : 0)
    assert.doesNotMatch(JSON.stringify(h.updates), /CANARY_|001234/)
  } finally { await h.close() }
})

for (const decline of [false, true]) test(`ordinary sensitive uncertain ${decline ? 'Decline' : 'answer'} POST never reopens fields or retries`, async () => {
  const phone = new PrivatePhone(extensionApproval())
  phone.failAnswer = !decline; phone.failDecline = decline
  const h = await harness(phone, { server: false, formSupport: true, ordinaryRespond: params => 'collection' in params.requestedSchema.properties ? continueOrdinary
    : decline ? { action: 'decline' } : { action: 'accept', content: { account: 'CANARY_uncertain', accessKey: '001234' } } })
  try {
    await fallback(h)
    assert.equal(phone.answers.length, decline ? 0 : 1)
    assert.equal(phone.declines.length, decline ? 1 : 0)
    assert.equal(h.formRequests.length, 2)
    assert.match(JSON.stringify(h.updates), /no automatic retry/)
    assert.doesNotMatch(JSON.stringify(h.updates), /CANARY_|001234|DO_NOT_LEAK/)
  } finally { await h.close() }
})

test('ordinary sensitive replay outside an active turn stays observation-only', async () => {
  const phone = new PrivatePhone()
  const h = await harness(phone, { server: false, formSupport: true, ordinaryRespond: params => 'collection' in params.requestedSchema.properties ? continueOrdinary : { action: 'accept', content: { code: '001234' } } })
  try {
    await h.result
    await h.agent.request(acp.methods.agent.session.load, { ...h.workspace, sessionId: '1' })
    assert.equal(h.formRequests.length, 2)
    assert.equal(phone.answers.length, 1)
    assert.match(JSON.stringify(h.updates), /observation only/)
  } finally { await h.close() }
})

test('ordinary sensitive collection independently checks capability, strict schemas, saved choices and checked handlers', async () => {
  const client = { request: async () => { assert.fail('Unsupported input opened a form') } } as unknown as acp.AgentContext
  for (const options of [{ formSupported: false, privateMcp: false }, { formSupported: true, privateMcp: true }]) {
    const phone = new PrivatePhone()
    assert.equal(await forwardOrdinarySensitive(phone, '1', phone.approval, client, new AbortController().signal, options), 'phone')
    assert.equal(phone.checks, 0)
  }
  const options = { formSupported: true, privateMcp: false }
  for (const form of [{ ...browserLogin, saved: true }, { ...browserCode, extra: 'CANARY_unknown' }, { type: 'crd-setup', pin: 'CANARY_unknown' }]) {
    const phone = new PrivatePhone({ ...privateApproval(), privateForm: form } as unknown as PrivateApproval)
    assert.equal(await forwardOrdinarySensitive(phone, '1', phone.approval, client, new AbortController().signal, options), 'phone')
    assert.equal(phone.checks, 0)
  }
  for (const form of [{ ...extensionForm, fields: [{ name: 'key', label: 'Key' }] }, { ...extensionForm, fields: [...extensionForm.fields, extensionForm.fields[0]] }]) {
    const phone = new PrivatePhone({ ...extensionApproval(), form } as SecretAskApproval)
    assert.equal(await forwardOrdinarySensitive(phone, '1', phone.approval, client, new AbortController().signal, options), 'phone')
    assert.equal(phone.checks, 0)
  }
  for (const kind of ['private', 'extension']) {
    const phone = new PrivatePhone(kind === 'private' ? privateApproval() : extensionApproval())
    Object.defineProperty(phone, kind === 'private' ? 'answerPrivate' : 'answerSecretAsk', { value: undefined })
    assert.equal(await forwardOrdinarySensitive(phone, '1', phone.approval, client, new AbortController().signal, options), 'phone')
    assert.equal(phone.checks, 0)
  }
})

for (const example of ordinaryCases) for (const uncertain of [false, true]) test(`ordinary ${example.tool} real ACP + HTTP ${uncertain ? 'lost acknowledgement' : 'completion'} preserves the native destination and attempts one POST`, async () => {
  const fixture = await new PhoneFixture().start()
  const writes: { path: string, body: unknown }[] = []
  let ownerChecks = 0
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/me') ownerChecks++
    if (init?.method === 'POST' && url.pathname.startsWith(example.path)) {
      writes.push({ path: url.pathname, body: JSON.parse(String(init.body)) })
      if (uncertain) throw new Error('DO_NOT_LEAK CANARY_uncertain_http')
      fixture.conversations.get(1)!.approvals = []
      fixture.finish(1, 'Ordinary input completed.')
      return Response.json({ ok: true })
    }
    return fetch(input, init)
  }
  const backend = new HttpPhoneBackend(new PhoneHttp(fixture.url, fixture.token, request), '/phone/work', 0)
  const h = await harness(new PrivatePhone(), { backend, server: false, formSupport: true,
    ordinaryRespond: params => 'collection' in params.requestedSchema.properties ? continueOrdinary : { action: 'accept', content: example.values } })
  try {
    await fixture.submitted.promise
    const native = privateView(example.form, example.tool).approvals![0]!
    fixture.conversations.get(1)!.approvals = [native]
    fixture.publish(1)
    if (uncertain) {
      await until(() => h.updates.some(update => JSON.stringify(update).includes('no automatic retry')))
      fixture.conversations.get(1)!.approvals = []
      fixture.finish(1, 'Completed after phone inspection.')
    }
    await h.result
    const body = 'value' in example.values ? { value: example.values.value }
      : example.form.type === 'ask' ? { values: example.values } : { values: example.values, remember: false, useSaved: false }
    assert.deepEqual(writes, [{ path: example.path + encodeURIComponent(native.id), body }])
    assert.equal(ownerChecks, 4, 'One startup check plus three input-owner checks')
    assert.deepEqual(fixture.answers, [])
    assert.deepEqual(fixture.privateAnswers, [])
    assert.equal(fixture.aborts, 0)
    assert.deepEqual(h.requests, [])
    assert.equal(h.formRequests.length, 2)
    assert.doesNotMatch(JSON.stringify(h.formRequests) + JSON.stringify(h.updates), /CANARY_|001234|DO_NOT_LEAK/)
  } finally { await h.close(); await fixture.close() }
})

for (const kind of ['private', 'extension']) for (const failure of ['connect', 'result', 'directory']) test(`advertised private ${kind} ${failure} failure never downgrades to ordinary input despite form support`, async () => {
  const phone = new PrivatePhone(kind === 'private' ? privateApproval() : extensionApproval())
  const h = await harness(phone, { formSupport: true,
    ...(failure === 'directory' ? { secretFilesDir: '/does-not-exist' } : {}),
    ...(failure === 'connect' ? { connect: async () => { throw new Error('DO_NOT_LEAK CANARY_failure') } } : {}),
    respond: () => ({ isError: true, content: [{ type: 'text', text: 'DO_NOT_LEAK CANARY_failure' }] }),
  })
  try {
    await fallback(h)
    assert.deepEqual(h.formRequests, [])
    assert.deepEqual(phone.answers, [])
    assert.deepEqual(phone.declines, [])
    assert.doesNotMatch(JSON.stringify(h.updates), /DO_NOT_LEAK|CANARY_/)
  } finally { await h.close() }
})

test('ordinary secret storage refuses an OTP-length value rather than changing its destination', async () => {
  const phone = new PrivatePhone(privateApproval(storeSecret, 'secret_request'))
  const h = await harness(phone, { server: false, formSupport: true, ordinaryRespond: params => 'collection' in params.requestedSchema.properties
    ? continueOrdinary : { action: 'accept', content: { value: '001234' } } })
  try { await fallback(h); assert.deepEqual(phone.answers, []); assert.deepEqual(phone.declines, []); assert.equal(h.formRequests.length, 2) } finally { await h.close() }
})
