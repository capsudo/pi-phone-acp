import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readConfig, readToken } from '../src/config.js'
import { PhoneHttp } from '../src/http.js'
import { z } from 'zod'

const environment = { PI_PHONE_URL: 'http://phone:8787', PI_PHONE_TOKEN_FILE: '/private/token' }

test('requires explicit service origin and private credential path, never credentials in URLs', () => {
  assert.equal(readConfig(environment).cwd, '~/work')
  for (const url of ['ftp://phone', 'http://user:password@phone', 'http://phone/api', 'http://phone/?token=private', 'http://phone/#private']) {
    assert.throws(() => readConfig({ ...environment, PI_PHONE_URL: url }))
  }
  assert.throws(() => readConfig({ ...environment, PI_PHONE_TOKEN_FILE: 'relative' }))
  assert.throws(() => readConfig({ ...environment, PI_PHONE_CWD: 'machine:desktop/work' }))
  assert.throws(() => readConfig({}))
})

test('reads an owned private token file and rejects broad permissions, symlinks and header injection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-phone-acp-config-'))
  const path = join(directory, 'token')
  try {
    await writeFile(path, 'test-only-token\n', { mode: 0o600 })
    assert.equal(await readToken(path), 'test-only-token')
    await chmod(path, 0o644)
    await assert.rejects(readToken(path))
    await chmod(path, 0o600)
    await symlink(path, join(directory, 'link'))
    await assert.rejects(readToken(join(directory, 'link')))
    await writeFile(path, 'test\r\nX-Injected: true')
    await assert.rejects(readToken(path))
    await writeFile(path, ' ')
    await assert.rejects(readToken(path))
    await writeFile(path, 'x'.repeat(8193))
    await assert.rejects(readToken(path))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('does not follow redirects or send a credential outside the configured API origin', async () => {
  let calls = 0
  const request: typeof fetch = async (url, options) => {
    calls++
    assert.equal(new URL(String(url)).origin, 'http://phone:8787')
    assert.equal(options?.redirect, 'error')
    return new Response('{}', { status: 302, headers: { location: 'http://elsewhere.invalid' } })
  }
  const http = new PhoneHttp(new URL('http://phone:8787'), 'test-only-token', request)
  await assert.rejects(http.json('/api/me', z.object({}), AbortSignal.timeout(1000)))
  await assert.rejects(http.json('//elsewhere.invalid/api/me', z.object({}), AbortSignal.timeout(1000)))
  await assert.rejects(http.json('/login?token=private', z.object({}), AbortSignal.timeout(1000)))
  assert.equal(calls, 1)
})
