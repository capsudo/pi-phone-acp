import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { promisify } from 'node:util'

const [cli, version] = process.argv.slice(2)
const run = promisify(execFile)
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PI_PHONE_')))
env.PATH = '/no-host-tools'

async function tokenFile(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-phone-acp-nix-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'token')
  await writeFile(file, 'nix-package-test-only', { mode: 0o600 })
  return file
}

test('release metadata and runtime-only dependencies are installed', async () => {
  const root = join(dirname(dirname(cli)), 'lib/node_modules/pi-phone-acp')
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.version, version)
  assert.equal(pkg.devDependencies, undefined)
  assert.equal(pkg.scripts, undefined)
  for (const name of Object.keys(pkg.dependencies)) {
    await readFile(join(root, 'node_modules', name, 'package.json'))
  }
  for (const name of ['typescript', 'tsx', '@types/node']) {
    await assert.rejects(readFile(join(root, 'node_modules', name, 'package.json')), { code: 'ENOENT' })
  }
})

test('CLI runs without a host Node.js on PATH', { timeout: 10000 }, async () => {
  const { stdout, stderr } = await run(cli, ['--help'], { env, timeout: 5000 })
  assert.match(stdout, /ACP v1 over stdio/)
  assert.equal(stderr, '')
  await assert.rejects(run(cli, ['--doctor'], { env, timeout: 5000 }), error => {
    assert.equal(error.code, 1)
    assert.equal(error.stdout, '')
    assert.match(error.stderr, /Check configuration/)
    return true
  })
})

test('doctor authenticates a read against a local mock phone', { timeout: 10000 }, async t => {
  const file = await tokenFile(t)
  let reads = 0
  const server = createServer((request, response) => {
    assert.equal(request.method, 'GET')
    assert.equal(request.url, '/api/me')
    assert.equal(request.headers.authorization, 'Bearer nix-package-test-only')
    assert.equal(request.headers['x-pocket'], '1')
    reads++
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({
      user: { id: 'owner', role: 'owner' },
      server: { home: '/phone/home', defaultCwd: '/phone/home/work' },
    }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const { stdout, stderr } = await run(cli, ['--doctor'], {
    env: { ...env, PI_PHONE_URL: `http://127.0.0.1:${server.address().port}`, PI_PHONE_TOKEN_FILE: file },
    timeout: 5000,
  })
  assert.deepEqual(JSON.parse(stdout), { role: 'owner', compatibleShape: true, runtimeVersionVerified: false })
  assert.equal(stderr, '')
  assert.equal(reads, 1)
})

test('packaged ACP stdio initializes and exits cleanly on EOF', { timeout: 10000 }, async t => {
  const file = await tokenFile(t)
  const child = spawn(cli, [], {
    env: { ...env, PI_PHONE_URL: 'http://127.0.0.1:1', PI_PHONE_TOKEN_FILE: file },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
  const exited = once(child, 'exit')
  const lines = createInterface({ input: child.stdout })
  t.after(() => lines.close())
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const response = once(lines, 'line')
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 2 } })}\n`)
  const [line] = await response
  const message = JSON.parse(line)
  assert.equal(message.id, 1)
  assert.equal(message.error, undefined)
  assert.equal(message.result.protocolVersion, 1)
  assert.equal(message.result.agentInfo.name, 'pi-phone-acp')
  child.stdin.end()
  assert.deepEqual(await exited, [0, null])
  assert.equal(stderr, '')
})
