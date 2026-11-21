import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { test } from 'node:test'
import * as acp from '@agentclientprotocol/sdk/unstable'
import { PhoneFixture } from './fixture.js'
import { privateView } from './private-fixture.js'

function launch(env: NodeJS.ProcessEnv, setup: (peer: ReturnType<typeof acp.client>) => ReturnType<typeof acp.client> = peer => peer) {
  const child = spawn(process.execPath, ['dist/cli.js'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let errors = ''
  let output = ''
  child.stdout.on('data', chunk => { output += Buffer.from(chunk).toString('utf8') })
  child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk })
  const updates: acp.SessionNotification[] = []
  const peer = setup(acp.client()).onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params) })
  const connection = peer.connect(acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>))
  const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
  return { child, connection, agent: connection.agent, updates, exited, errors: () => errors, output: () => output }
}

for (const termination of ['SIGTERM', 'SIGKILL', 'EOF'] as const) {
test(`stdio ${termination} leaves phone work running, and a replacement loads the same result`, { timeout: 15000 }, async () => {
  const fixture = await new PhoneFixture().start()
  const directory = await mkdtemp(join(tmpdir(), 'pi-phone-acp-stdio-'))
  const tokenFile = join(directory, 'token')
  await writeFile(tokenFile, fixture.token, { mode: 0o600 })
  const env = { ...process.env, PI_PHONE_URL: fixture.url.origin, PI_PHONE_TOKEN_FILE: tokenFile }
  const first = launch(env)
  let second: ReturnType<typeof launch> | undefined
  try {
    const initialized = await first.agent.request(acp.methods.agent.initialize, { protocolVersion: 2 })
    assert.equal(initialized.protocolVersion, 1)
    const { sessionId } = await first.agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, { cwd: '/t3/project', mcpServers: [] })
    const prompt = first.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'continue without T3' }] })
    const rejected = assert.rejects(prompt)
    await fixture.submitted.promise
    if (termination === 'EOF') first.child.stdin.end()
    else first.child.kill(termination)
    await first.exited
    await rejected
    assert.equal(fixture.conversations.get(Number(sessionId))!.busy, true)
    assert.equal(fixture.aborts, 0)
    fixture.finish(Number(sessionId), 'completed while adapter was absent')
    second = launch(env)
    await second.agent.request(acp.methods.agent.initialize, { protocolVersion: 1 })
    await second.agent.request(acp.methods.agent.session.load, { sessionId, cwd: '/t3/project', mcpServers: [] })
    assert.ok(second.updates.some(item => item.update.sessionUpdate === 'agent_message_chunk' && item.update.content.type === 'text' && item.update.content.text === 'completed while adapter was absent'))
    assert.equal(fixture.submissions.length, 1)
    assert.doesNotMatch(first.errors() + second.errors(), new RegExp(fixture.token))
    assert.equal(first.errors(), '')
    second.child.stdin.end()
    assert.equal(await second.exited, 0)
  } finally {
    first.connection.close()
    second?.connection.close()
    if (first.child.exitCode === null) first.child.kill('SIGKILL')
    if (second && second.child.exitCode === null) second.child.kill('SIGKILL')
    await fixture.close()
    await rm(directory, { recursive: true, force: true })
  }
})

}

test('CLI startup failures are sanitized and do not contaminate ACP stdout', { timeout: 5000 }, async () => {
  const child = spawn(process.execPath, ['dist/cli.js'], {
    env: { ...process.env, PI_PHONE_URL: 'http://user:DO_NOT_LEAK@phone', PI_PHONE_TOKEN_FILE: '/missing' },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise<number | null>(resolve => child.once('exit', resolve))
  assert.equal(code, 1)
  assert.equal(stdout, '')
  assert.doesNotMatch(stderr, /DO_NOT_LEAK|user:|\/missing/)
  assert.match(stderr, /could not start/)
})

test('compiled stdio private card uses the configured exact directory and posts an OTP without secret-bearing stdout/stderr', { timeout: 15000 }, async () => {
  const fixture = await new PhoneFixture().start()
  const directory = await mkdtemp(join(tmpdir(), 'pi-phone-private-stdio-'))
  const files = join(directory, 'files')
  await mkdir(files, { mode: 0o700 })
  const file = join(files, '0123456789abcdef0123456789abcdef')
  const tokenFile = join(directory, 'token')
  await writeFile(tokenFile, fixture.token, { mode: 0o600 })
  let initialized = false
  let calls = 0
  let disconnects = 0
  const child = launch({ ...process.env, PI_PHONE_URL: fixture.url.origin, PI_PHONE_TOKEN_FILE: tokenFile, PI_PHONE_SECRET_FILES_DIR: files }, peer => peer
    .onRequest(acp.methods.client.elicitation.create, () => { assert.fail('Private input must not use ordinary elicitation') })
    .onRequest('*', async ({ method, params }) => {
      const p = params as Record<string, unknown>
      if (method === 'mcp/connect') { assert.deepEqual(p, { serverId: 't3-code' }); return { connectionId: 'stdio-private' } }
      if (method === 'mcp/disconnect') { disconnects++; return {} }
      assert.equal(method, 'mcp/message'); assert.equal(p.connectionId, 'stdio-private')
      if (p.method === 'initialize') return { protocolVersion: '2025-06-18', serverInfo: { name: 'T3 Code', version: '0.1.8' }, capabilities: {} }
      assert.ok(initialized)
      assert.equal(p.method, 'tools/call')
      const inner = p.params as { name: string, arguments: Record<string, unknown> }
      assert.equal(inner.name, 'request_secret'); assert.equal(inner.arguments.delivery, 'file')
      assert.equal(Object.hasOwn(inner.arguments, 'value'), false)
      calls++
      await writeFile(file, '000007', { mode: 0o600, flag: 'wx' })
      const structuredContent = { status: 'saved', file }
      return { isError: false, structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent) }] }
    })
    .onNotification('*', ({ method, params }) => {
      if (method === 'mcp/message') { assert.deepEqual(params, { connectionId: 'stdio-private', method: 'notifications/initialized' }); initialized = true }
    }))
  try {
    await child.agent.request(acp.methods.agent.initialize, { protocolVersion: 2 })
    const { sessionId } = await child.agent.request(acp.methods.agent.session.new, {
      cwd: '/t3/project', mcpServers: [{ type: 'acp', name: 't3-code', serverId: 't3-code' }],
    })
    const prompt = child.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'Fixture private code' }] })
    await fixture.submitted.promise
    fixture.conversations.get(Number(sessionId))!.approvals = privateView().approvals!
    fixture.publish(Number(sessionId))
    assert.equal((await prompt).stopReason, 'end_turn')
    assert.deepEqual(fixture.privateAnswers, [{ path: '/api/browser/asks/risky-17-call-1', body: { values: { code: '000007' }, remember: false, useSaved: false } }])
    assert.deepEqual(await readdir(files), [])
    assert.equal(calls, 1); assert.equal(disconnects, 1); assert.equal(fixture.aborts, 0)
    child.child.stdin.end()
    assert.equal(await child.exited, 0)
    assert.equal(child.errors(), '')
    assert.doesNotMatch(child.output() + child.errors() + JSON.stringify(child.updates), /000007|test-only-device-session/)
  } finally {
    child.connection.close()
    if (child.child.exitCode === null) child.child.kill('SIGKILL')
    await fixture.close()
    await rm(directory, { recursive: true, force: true })
  }
})
