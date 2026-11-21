import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as acp from '@agentclientprotocol/sdk/unstable'
import { createAdapter } from '../src/adapter.js'
import { SecretFiles } from '../src/secret-files.js'
import type { PhoneBackend, PhoneEvent, PrivateApproval } from '../src/phone.js'
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
  constructor(readonly approval = privateApproval()) {}
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
  withdraw() { this.changed = true; this.extra.push({ type: 'approval_withdrawn', id: this.approval.id }); this.wake.resolve() }
}
interface HarnessOptions {
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
  let cards = 0
  let disconnects = 0
  let initialized = false
  const save = async (value: string) => {
    const file = join(directory, randomBytes(16).toString('hex'))
    await writeFile(file, value, { mode: 0o600, flag: 'wx' }); files.push(file)
    const result = { status: 'saved', file }
    return { isError: false, structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }
  }
  const client = acp.client()
    .onRequest(acp.methods.client.elicitation.create, () => { assert.fail('Secrets must never enter ordinary elicitation') })
    .onRequest(acp.methods.client.session.requestPermission, () => { assert.fail('Secrets must never enter permission UI') })
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
  await agent.request(acp.methods.agent.initialize, { protocolVersion: 2 }) // No ordinary form capability needed.
  const workspace = { cwd: '/t3/project', mcpServers: options.server === false ? [] : [{ type: 'acp' as const, name: 't3-code', serverId: 't3-code' }] }
  await agent.request(acp.methods.agent.session.new, workspace)
  const result = agent.request(acp.methods.agent.session.prompt, { sessionId: '1', prompt: [{ type: 'text', text: 'Fixture private request' }] })
  void result.catch(() => {})
  return { phone, agent, connection, result, requests, updates, files, directory, workspace, save,
    disconnects: () => disconnects,
    close: async () => { connection.close(); await rm(base, { recursive: true, force: true }) } }
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
