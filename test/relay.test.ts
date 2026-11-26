import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import * as acp from '@agentclientprotocol/sdk/unstable'
import { HttpPhoneBackend } from '../src/backend.js'
import { PhoneHttp } from '../src/http.js'
import { PhoneMonitor } from '../src/phone-monitor.js'
import { decodeData } from '../src/relay-protocol.js'
import { servePhone } from '../src/server.js'
import { readSocketPath } from '../src/socket.js'
import { PhoneFixture } from './fixture.js'
import { riskyApproval } from './approval-fixture.js'

const workspace = { cwd: '/t3/project', mcpServers: [] }
const availability = { timeoutMs: 150, intervalMs: 80, retryDelayMs: 15 }
async function until(condition: () => boolean) {
  const deadline = Date.now() + 4000
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'Condition did not settle')
    await delay(5)
  }
}

function launch(path: string, setup: (peer: ReturnType<typeof acp.client>) => ReturnType<typeof acp.client> = peer => peer) {
  // the relay receives no phone URL or token configuration
  const child = spawn(process.execPath, ['dist/cli.js', '--relay'], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PI_PHONE_SOCKET: path },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let errors = '', output = ''
  child.stderr.on('data', chunk => { errors += chunk })
  child.stdout.on('data', chunk => { output += chunk })
  const updates: acp.SessionNotification[] = []
  const connection = setup(acp.client()).onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params) })
    .connect(acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>))
  const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
  return { child, connection, agent: connection.agent, updates, exited, errors: () => errors, output: () => output }
}
const initialize = (relay: ReturnType<typeof launch>) => relay.agent.request(acp.methods.agent.initialize, { protocolVersion: 1 })

async function harness(options = availability) {
  const fixture = await new PhoneFixture().start()
  const directory = await mkdtemp(join(tmpdir(), 'phone-relay-'))
  const path = join(directory, 'acp.sock')
  const status: (string | undefined)[] = []
  const health = new HttpPhoneBackend(new PhoneHttp(fixture.url, fixture.token), '~/work', 1)
  const monitor = new PhoneMonitor(health, options, failure => { status.push(failure?.reason) })
  const server = await servePhone(path, monitor, () => new HttpPhoneBackend(new PhoneHttp(fixture.url, fixture.token, fetch, 3000, {
    success: () => monitor.contact(), failure: () => monitor.suspect(),
  }), '~/work', 1))
  const relays: ReturnType<typeof launch>[] = []
  return {
    fixture, directory, path, monitor, server, status,
    launch(setup?: (peer: ReturnType<typeof acp.client>) => ReturnType<typeof acp.client>) { const relay = launch(path, setup); relays.push(relay); return relay },
    async close() {
      for (const relay of relays) {
        relay.connection.close()
        if (relay.child.exitCode === null) { relay.child.kill('SIGKILL') }
      }
      await server.stop()
      await fixture.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

for (const failure of ['auth', 'network', 'contract'] as const) test(`persistent adapter survives ${failure} loss and new relays load ongoing work/history without resubmission`, { timeout: 10000 }, async () => {
  const h = await harness()
  try {
    const first = h.launch()
    await initialize(first)
    const { sessionId } = await first.agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, workspace)
    h.fixture.loseSubmitResponse = failure === 'network'
    const prompt = first.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'keep working through relay loss' }] })
    const rejected = assert.rejects(prompt)
    await h.fixture.submitted.promise
    if (failure === 'auth') { h.fixture.meStatus = 401 }
    if (failure === 'network') { h.fixture.meDrop = true }
    if (failure === 'contract') { h.fixture.meBody = { password: 'DO_NOT_LEAK' } }
    h.fixture.rejectPollStatus = 503
    await first.connection.closed
    await rejected
    assert.equal(await first.exited, 1)
    assert.match(first.errors(), failure === 'auth' ? /authentication/ : failure === 'network' ? /unreachable/ : /incompatible/)
    assert.doesNotMatch(first.errors() + first.output(), /DO_NOT_LEAK|test-only-device-session|127\.0\.0\.1/)
    assert.equal(h.fixture.conversations.get(Number(sessionId))!.busy, true)
    assert.equal(h.fixture.aborts, 0)
    assert.equal(h.fixture.submissions.length, 1)

    const offline = h.launch()
    await assert.rejects(initialize(offline))
    assert.equal(await offline.exited, 1)
    assert.ok((await lstat(h.path)).isSocket())
    h.fixture.meStatus = 200
    h.fixture.meDrop = false
    h.fixture.meBody = undefined
    h.fixture.rejectPollStatus = 0
    await until(() => h.status.at(-1) === undefined)

    const second = h.launch()
    await initialize(second)
    await second.agent.request(acp.methods.agent.session.load, { ...workspace, sessionId })
    assert.equal(h.fixture.submissions.length, 1)
    h.fixture.finish(Number(sessionId), 'phone finished while adapter stayed alive')
    await until(() => second.updates.some(item => item.update.sessionUpdate === 'agent_message_chunk' && item.update.content.type === 'text' && item.update.content.text === 'phone finished while adapter stayed alive'))
    assert.ok(second.updates.some(item => item.update.sessionUpdate === 'user_message_chunk'))
    assert.equal(h.fixture.submissions.length, 1)
    assert.equal(h.fixture.aborts, 0)
    assert.deepEqual(h.fixture.answers, [])
    assert.deepEqual(h.fixture.privateAnswers, [])
    second.child.stdin.end()
    assert.equal(await second.exited, 0)
    assert.equal(second.errors(), '')
  } finally { await h.close() }
})

test('idle phone loss closes every relay, but the same listening adapter detects recovery without clients', { timeout: 10000 }, async () => {
  const h = await harness()
  try {
    const first = h.launch(), second = h.launch()
    await Promise.all([initialize(first), initialize(second)])
    h.fixture.meHang = true
    await Promise.all([first.connection.closed, second.connection.closed])
    assert.deepEqual(await Promise.all([first.exited, second.exited]), [1, 1])
    assert.ok(h.status.includes('unreachable'))
    const requests = h.fixture.meRequests
    h.fixture.meHang = false
    await until(() => h.status.at(-1) === undefined)
    assert.ok(h.fixture.meRequests > requests)
    assert.ok((await lstat(h.path)).isSocket())
    assert.equal(h.fixture.conversations.size, 0)
    assert.equal(h.fixture.submissions.length, 0)
    assert.equal(h.fixture.aborts, 0)
  } finally { await h.close() }
})

for (const ending of ['EOF', 'SIGTERM', 'SIGKILL'] as const) test(`relay ${ending} detaches only its connection and leaves the adapter and other relay usable`, { timeout: 10000 }, async () => {
  const h = await harness()
  try {
    const first = h.launch(), second = h.launch()
    await Promise.all([initialize(first), initialize(second)])
    const { sessionId } = await first.agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, workspace)
    const prompt = first.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'work survives relay shutdown' }] })
    const rejected = assert.rejects(prompt)
    await h.fixture.submitted.promise
    if (ending === 'EOF') { first.child.stdin.end() }
    else { first.child.kill(ending) }
    await first.exited
    await rejected
    assert.equal(first.errors(), '')
    assert.equal(second.connection.signal.aborted, false)
    await second.agent.request(acp.methods.agent.session.load, { ...workspace, sessionId })
    h.fixture.finish(Number(sessionId), 'result from another relay')
    await until(() => second.updates.some(item => item.update.sessionUpdate === 'agent_message_chunk'))
    assert.equal(h.fixture.submissions.length, 1)
    assert.equal(h.fixture.aborts, 0)
    assert.deepEqual(h.status, [])
  } finally { await h.close() }
})

test('conversation-specific errors confirm phone access without closing other ACP connections', { timeout: 10000 }, async () => {
  const h = await harness({ ...availability, intervalMs: 1000 })
  try {
    const relay = h.launch()
    await initialize(relay)
    await assert.rejects(relay.agent.request(acp.methods.agent.session.load, { ...workspace, sessionId: '999' }))
    await until(() => h.fixture.meRequests >= 2)
    assert.equal(relay.connection.signal.aborted, false)
    assert.deepEqual(h.status, [])
    const { sessionId } = await relay.agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, workspace)
    assert.equal(sessionId, '1')
    assert.equal(h.fixture.submissions.length, 0)
    assert.equal(h.fixture.aborts, 0)
  } finally { await h.close() }
})

test('server shutdown closes relays cleanly, aborts health checks and removes only its own socket', { timeout: 10000 }, async () => {
  const h = await harness()
  try {
    const relay = h.launch()
    await initialize(relay)
    h.fixture.meHang = true
    h.monitor.suspect()
    await until(() => h.fixture.meActive === 1)
    await h.server.stop()
    await h.server.closed
    assert.equal(await relay.exited, 0)
    assert.equal(relay.errors(), '')
    await until(() => h.fixture.meActive === 0)
    const requests = h.fixture.meRequests
    await delay(200)
    assert.equal(h.fixture.meRequests, requests)
    await assert.rejects(lstat(h.path), { code: 'ENOENT' })
    assert.equal(h.fixture.aborts, 0)
  } finally { await h.close() }
})

test('private socket permissions, occupied paths, duplicates and symlinks fail closed without deleting files', { timeout: 10000 }, async () => {
  const h = await harness()
  try {
    assert.equal((await lstat(h.path)).mode & 0o777, 0o600)
    assert.equal(await readSocketPath({ PI_PHONE_SOCKET: h.path }, true), h.path)
    await assert.rejects(servePhone(h.path, h.monitor, () => { throw new Error('must not create a phone backend') }))
    const relay = h.launch()
    await initialize(relay)
    const occupied = join(h.directory, 'occupied')
    await writeFile(occupied, 'DO_NOT_REPLACE', { mode: 0o600 })
    await assert.rejects(readSocketPath({ PI_PHONE_SOCKET: occupied }, false))
    await assert.rejects(readSocketPath({ PI_PHONE_SOCKET: occupied }, true))
    assert.equal(await readFile(occupied, 'utf8'), 'DO_NOT_REPLACE')
    const link = join(h.directory, 'link')
    await symlink(h.path, link)
    await assert.rejects(readSocketPath({ PI_PHONE_SOCKET: link }, true))
    await chmod(h.directory, 0o755)
    await assert.rejects(readSocketPath({ PI_PHONE_SOCKET: h.path }, true))
    await chmod(h.directory, 0o700)
    await assert.rejects(readSocketPath({ PI_PHONE_SOCKET: 'relative.sock' }, true))
    await assert.rejects(readSocketPath({ PI_PHONE_SOCKET: join(h.directory, 'x'.repeat(101)) }, false))
  } finally { await h.close() }
})

test('malformed relay control frames are sanitized and never copied to ACP stdout', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phone-relay-bad-'))
  const path = join(directory, 'acp.sock')
  const sockets = new Set<Socket>()
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.end('{"type":"closed","reason":"DO_NOT_LEAK"}\n')
  })
  await new Promise<void>(resolve => server.listen(path, resolve))
  await chmod(path, 0o600)
  const relay = launch(path)
  try {
    await assert.rejects(initialize(relay))
    assert.equal(await relay.exited, 1)
    assert.equal(relay.output(), '')
    assert.match(relay.errors(), /relay could not connect/)
    assert.doesNotMatch(relay.errors(), /DO_NOT_LEAK|acp\.sock/)
    assert.throws(() => decodeData('not-base64!'))
  } finally {
    relay.connection.close()
    if (relay.child.exitCode === null) { relay.child.kill('SIGKILL') }
    for (const socket of sockets) { socket.destroy() }
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})

test('compiled foreground adapter keeps the same PID through phone loss and replacement relays', { timeout: 10000 }, async () => {
  const fixture = await new PhoneFixture().start()
  const directory = await mkdtemp(join(tmpdir(), 'phone-server-process-'))
  const path = join(directory, 'acp.sock')
  const token = join(directory, 'token')
  await writeFile(token, fixture.token, { mode: 0o600 })
  fixture.meStatus = 401
  const child = spawn(process.execPath, ['dist/cli.js', '--serve'], {
    env: { ...process.env, PI_PHONE_URL: fixture.url.origin, PI_PHONE_TOKEN_FILE: token, PI_PHONE_SOCKET: path },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const pid = child.pid
  let errors = '', output = ''
  child.stderr.on('data', chunk => { errors += chunk })
  child.stdout.on('data', chunk => { output += chunk })
  const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
  const relays: ReturnType<typeof launch>[] = []
  try {
    await until(() => fixture.meRequests >= 1)
    const first = launch(path)
    relays.push(first)
    await assert.rejects(initialize(first))
    assert.equal(await first.exited, 1)
    assert.equal(child.exitCode, null)
    fixture.meStatus = 200
    const second = launch(path)
    relays.push(second)
    await initialize(second)
    assert.equal(child.pid, pid)
    assert.equal(child.exitCode, null)
    const { sessionId } = await second.agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, workspace)
    const prompt = second.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'persistent adapter, disposable relay' }] })
    const rejected = assert.rejects(prompt)
    await fixture.submitted.promise
    fixture.meStatus = 403
    fixture.rejectPollStatus = 401
    await second.connection.closed
    await rejected
    assert.equal(await second.exited, 1)
    assert.equal(child.exitCode, null)
    assert.equal(child.pid, pid)
    assert.equal(fixture.conversations.get(Number(sessionId))!.busy, true)
    assert.equal(fixture.submissions.length, 1)
    assert.equal(fixture.aborts, 0)
    child.kill('SIGTERM')
    assert.equal(await exited, 0)
    assert.equal(output, '')
    assert.match(errors, /authentication/)
    assert.match(errors, /reachable again/)
    assert.doesNotMatch(errors, /test-only-device-session|127\.0\.0\.1|Unhandled|ERR_STREAM/)
    await assert.rejects(lstat(path), { code: 'ENOENT' })
  } finally {
    for (const relay of relays) {
      relay.connection.close()
      if (relay.child.exitCode === null) { relay.child.kill('SIGKILL') }
    }
    if (child.exitCode === null) { child.kill('SIGKILL') }
    await exited
    await fixture.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('phone loss through the relay closes permission UI without approving, declining or cancelling phone work', { timeout: 10000 }, async () => {
  const h = await harness()
  const asked = Promise.withResolvers<void>()
  const dismissed = Promise.withResolvers<void>()
  try {
    const relay = h.launch(peer => peer.onRequest(acp.methods.client.session.requestPermission, async ({ signal }) => {
      asked.resolve()
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      dismissed.resolve()
      return { outcome: { outcome: 'cancelled' } }
    }))
    await initialize(relay)
    const { sessionId } = await relay.agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, workspace)
    const prompt = relay.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'wait for native approval' }] })
    const rejected = assert.rejects(prompt)
    await h.fixture.submitted.promise
    h.fixture.conversations.get(Number(sessionId))!.approvals = [riskyApproval]
    h.fixture.publish(Number(sessionId))
    await asked.promise
    h.fixture.meStatus = 401
    h.fixture.rejectPollStatus = 401
    await relay.connection.closed
    await rejected
    await dismissed.promise
    assert.equal(await relay.exited, 1)
    assert.equal(h.fixture.aborts, 0)
    assert.deepEqual(h.fixture.answers, [])
    assert.deepEqual(h.fixture.privateAnswers, [])
    assert.equal(h.fixture.submissions.length, 1)
    assert.deepEqual(h.fixture.conversations.get(Number(sessionId))!.approvals, [riskyApproval])
    assert.equal(h.fixture.conversations.get(Number(sessionId))!.busy, true)
  } finally { await h.close() }
})

test('relay SIGTERM interrupts blocked ADE stdout instead of leaving a stale process', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phone-relay-blocked-'))
  const path = join(directory, 'acp.sock')
  const sockets = new Set<Socket>()
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.write(JSON.stringify({ type: 'data', data: Buffer.alloc(2 * 1024 * 1024, 'x').toString('base64') }) + '\n')
  })
  await new Promise<void>(resolve => server.listen(path, resolve))
  await chmod(path, 0o600)
  const child = spawn(process.execPath, ['dist/cli.js', '--relay'], { env: { ...process.env, PI_PHONE_SOCKET: path }, stdio: ['pipe', 'pipe', 'pipe'] })
  let errors = ''
  child.stderr.on('data', chunk => { errors += chunk })
  const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
  const cleanupDeadline = setTimeout(() => child.kill('SIGKILL'), 4000)
  cleanupDeadline.unref()
  try {
    await until(() => child.stdout.readableLength > 0)
    await delay(50)
    assert.equal(child.exitCode, null)
    child.kill('SIGTERM')
    assert.equal(await exited, 0)
    assert.equal(errors, '')
  } finally {
    clearTimeout(cleanupDeadline)
    if (child.exitCode === null) { child.kill('SIGKILL') }
    child.stdout.destroy()
    child.stdin.destroy()
    for (const socket of sockets) { socket.destroy() }
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
