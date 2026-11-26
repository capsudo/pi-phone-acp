import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import * as acp from '@agentclientprotocol/sdk/unstable'
import { adapterInfo, stopAdapter } from './daemon-fixture.js'
import { PhoneFixture } from './fixture.js'

const workspace = { cwd: '/t3/project', mcpServers: [] }
async function until(condition: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 4000
  while (!await condition()) {
    assert.ok(Date.now() < deadline, 'Condition did not settle')
    await delay(5)
  }
}
function launch(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ['dist/cli.js'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let errors = '', output = ''
  child.stderr.on('data', chunk => { errors += chunk })
  child.stdout.on('data', chunk => { output += chunk })
  const updates: acp.SessionNotification[] = []
  const connection = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params) })
    .connect(acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>))
  const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
  return { child, connection, agent: connection.agent, updates, exited, errors: () => errors, output: () => output }
}
const initialize = (relay: ReturnType<typeof launch>) => relay.agent.request(acp.methods.agent.initialize, { protocolVersion: 1 })

async function harness(automaticPath = false) {
  const fixture = await new PhoneFixture().start()
  const directory = await mkdtemp(join(tmpdir(), 'acp-default-'))
  const tokenFile = join(directory, 'token')
  await writeFile(tokenFile, fixture.token, { mode: 0o600 })
  const socket = join(directory, 'adapter.sock')
  const env = { ...process.env, TMPDIR: directory, PI_PHONE_URL: fixture.url.origin, PI_PHONE_TOKEN_FILE: tokenFile, PI_PHONE_SOCKET: socket }
  if (automaticPath) { delete (env as NodeJS.ProcessEnv).PI_PHONE_SOCKET }
  const relays: ReturnType<typeof launch>[] = []
  return {
    fixture, directory, env, socket, tokenFile,
    launch(overrides: NodeJS.ProcessEnv = {}) { const relay = launch({ ...env, ...overrides }); relays.push(relay); return relay },
    async close() {
      for (const relay of relays) {
        relay.connection.close()
        if (relay.child.exitCode === null) { relay.child.kill('SIGKILL') }
      }
      await stopAdapter(socket)
      const runtime = join(directory, `pi-phone-acp-${process.getuid?.()}`)
      const entries = await readdir(runtime).catch(() => [])
      for (const entry of entries) { await stopAdapter(join(runtime, entry)) }
      await fixture.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test('normal command automatically selects a private socket and reuses one adapter without flags', { timeout: 10000 }, async () => {
  const h = await harness(true)
  try {
    const first = h.launch()
    await initialize(first)
    const directory = join(h.directory, `pi-phone-acp-${process.getuid?.()}`)
    const entries = await readdir(directory)
    assert.equal(entries.length, 1)
    const path = join(directory, entries[0]!)
    const before = await adapterInfo(path)
    assert.equal((await lstat(directory)).mode & 0o777, 0o700)
    assert.equal((await lstat(path)).mode & 0o777, 0o600)
    assert.notEqual(before.pid, first.child.pid)
    first.child.stdin.end()
    assert.equal(await first.exited, 0)
    const second = h.launch()
    await initialize(second)
    const after = await adapterInfo(path)
    assert.equal(after.pid, before.pid)
    assert.equal(after.identity, before.identity)
    assert.equal(first.errors() + second.errors(), '')
    assert.equal(h.fixture.conversations.size, 0)
    assert.equal(h.fixture.submissions.length, 0)
    assert.equal(h.fixture.aborts, 0)
    assert.doesNotMatch(first.output() + second.output(), /"type":"ready"|identity|test-only-device-session/)
  } finally { await h.close() }
})

test('simultaneous ADE launches start only one listening adapter and all connect successfully', { timeout: 10000 }, async () => {
  const h = await harness()
  try {
    const relays = Array.from({ length: 6 }, () => h.launch())
    await Promise.all(relays.map(initialize))
    const before = await adapterInfo(h.socket)
    assert.equal(h.fixture.conversations.size, 0)
    for (const relay of relays.slice(0, 3)) { relay.child.stdin.end() }
    assert.deepEqual(await Promise.all(relays.slice(0, 3).map(relay => relay.exited)), [0, 0, 0])
    assert.equal((await adapterInfo(h.socket)).pid, before.pid)
    for (const relay of relays.slice(3)) { assert.equal(relay.connection.signal.aborted, false) }
    assert.ok(relays.every(relay => relay.errors() === ''))
    assert.equal(h.fixture.aborts, 0)
  } finally { await h.close() }
})

test('default relay closes on pi-phone loss, then reconnects to the same persistent adapter without resubmission', { timeout: 10000 }, async () => {
  const h = await harness()
  try {
    const first = h.launch()
    await initialize(first)
    const before = await adapterInfo(h.socket)
    const { sessionId } = await first.agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, workspace)
    const prompt = first.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'same persistent adapter by default' }] })
    const rejected = assert.rejects(prompt)
    await h.fixture.submitted.promise
    h.fixture.meStatus = 401
    h.fixture.rejectPollStatus = 401
    await first.connection.closed
    await rejected
    assert.equal(await first.exited, 1)
    assert.equal((await adapterInfo(h.socket)).pid, before.pid)
    assert.equal(h.fixture.conversations.get(Number(sessionId))!.busy, true)
    h.fixture.meStatus = 200
    h.fixture.rejectPollStatus = 0
    const second = h.launch()
    await initialize(second)
    await second.agent.request(acp.methods.agent.session.load, { ...workspace, sessionId })
    assert.equal(h.fixture.submissions.length, 1)
    h.fixture.finish(Number(sessionId), 'finished without a replacement task')
    await until(() => second.updates.some(item => item.update.sessionUpdate === 'agent_message_chunk' && item.update.content.type === 'text' && item.update.content.text === 'finished without a replacement task'))
    assert.equal((await adapterInfo(h.socket)).pid, before.pid)
    assert.equal(h.fixture.submissions.length, 1)
    assert.equal(h.fixture.aborts, 0)
    assert.deepEqual(h.fixture.answers, [])
    assert.doesNotMatch(first.output() + first.errors() + second.output() + second.errors(), /test-only-device-session|127\.0\.0\.1/)
  } finally { await h.close() }
})

test('a socket for a different configuration is refused before any ADE requests reach pi-phone', { timeout: 10000 }, async () => {
  const h = await harness()
  try {
    const first = h.launch()
    await initialize(first)
    const before = await adapterInfo(h.socket)
    const wrong = h.launch({ PI_PHONE_CWD: '/different-config' })
    const failed = assert.rejects(initialize(wrong))
    const creation = assert.rejects(wrong.agent.request(acp.methods.agent.session.new, workspace))
    await Promise.all([failed, creation])
    assert.equal(await wrong.exited, 1)
    assert.equal(h.fixture.conversations.size, 0)
    assert.equal(h.fixture.submissions.length, 0)
    assert.equal(first.connection.signal.aborted, false)
    assert.equal((await adapterInfo(h.socket)).pid, before.pid)
    assert.doesNotMatch(wrong.errors(), /different-config|test-only-device-session|127\.0\.0\.1/)
  } finally { await h.close() }
})

test('persistent adapter reads an updated private token file without starting another backend', { timeout: 10000 }, async () => {
  const h = await harness()
  try {
    const first = h.launch()
    await initialize(first)
    const before = await adapterInfo(h.socket)
    first.child.stdin.end()
    assert.equal(await first.exited, 0)
    h.fixture.acceptedToken = 'ROTATED_TEST_TOKEN'
    await writeFile(h.tokenFile, h.fixture.acceptedToken, { mode: 0o600 })
    const second = h.launch()
    await initialize(second)
    assert.equal((await adapterInfo(h.socket)).pid, before.pid)
    assert.equal(first.errors() + second.errors(), '')
    assert.doesNotMatch(first.output() + second.output(), /ROTATED_TEST_TOKEN|test-only-device-session/)
  } finally { await h.close() }
})

test('default startup preserves occupied paths and performs no pi-phone writes', { timeout: 10000 }, async () => {
  const h = await harness()
  await writeFile(h.socket, 'KEEP_THIS_FILE', { mode: 0o600 })
  try {
    const relay = h.launch()
    await assert.rejects(initialize(relay))
    assert.equal(await relay.exited, 1)
    assert.equal(await readFile(h.socket, 'utf8'), 'KEEP_THIS_FILE')
    assert.equal(h.fixture.meRequests, 0)
    assert.equal(h.fixture.conversations.size, 0)
  } finally {
    await rm(h.socket)
    await h.close()
  }
})

test('doctor and help do not start a persistent adapter', { timeout: 10000 }, async () => {
  const h = await harness(true)
  try {
    for (const flag of ['--help', '--doctor']) {
      const child = spawn(process.execPath, ['dist/cli.js', flag], { env: h.env })
      let errors = ''
      child.stderr.on('data', chunk => { errors += chunk })
      child.stdout.resume()
      assert.equal(await new Promise<number | null>(resolve => child.once('exit', resolve)), 0)
      assert.equal(errors, '')
    }
    assert.equal(h.fixture.meRequests, 1)
    await assert.rejects(lstat(join(h.directory, `pi-phone-acp-${process.getuid?.()}`)), { code: 'ENOENT' })
    assert.equal(h.fixture.conversations.size, 0)
  } finally { await h.close() }
})
