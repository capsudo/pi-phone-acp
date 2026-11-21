import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SecretFiles } from '../src/secret-files.js'

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'private-files-'))
  const directory = join(base, 'delivery')
  await mkdir(directory, { mode: 0o700 })
  const path = join(directory, '0123456789abcdef0123456789abcdef')
  const files = new SecretFiles(directory)
  return { base, directory, path, files, close: () => rm(base, { recursive: true, force: true }) }
}
const signal = () => new AbortController().signal
const missing = async (path: string) => assert.rejects(lstat(path), { code: 'ENOENT' })

test('private delivery preserves exact UTF-8 content and OTP zeros, and removes its file before returning', async () => {
  const f = await fixture()
  try {
    for (const content of ['001234', ' \tdummy-only-ä \t', '\ufeffdummy-only', 'dummy\n']) {
      await writeFile(f.path, content, { mode: 0o600 })
      assert.equal(await f.files.consume(f.path, signal()), content)
      await missing(f.path)
    }
  } finally { await f.close() }
})

for (const kind of ['permissions', 'special-bits', 'empty', 'oversize', 'encoding', 'hardlink', 'symlink', 'directory', 'fifo', 'aborted']) {
  test(`refuses ${kind} delivery without raw errors, and cleans the received name`, async () => {
    const f = await fixture()
    const controller = new AbortController()
    try {
      const outside = join(f.base, 'DO_NOT_LEAK')
      await writeFile(outside, 'outside-dummy-only', { mode: 0o600 })
      if (kind === 'symlink') await symlink(outside, f.path)
      else if (kind === 'directory') await mkdir(f.path, { mode: 0o700 })
      else if (kind === 'fifo') execFileSync('mkfifo', [f.path])
      else if (kind === 'hardlink') await link(outside, f.path)
      else {
        await writeFile(f.path, kind === 'empty' ? '' : kind === 'oversize' ? 'x'.repeat(65537)
          : kind === 'encoding' ? Buffer.from([0xff]) : 'dummy-only', { mode: kind === 'permissions' ? 0o644 : 0o600 })
        if (kind === 'special-bits') await chmod(f.path, 0o4600)
        if (kind === 'aborted') controller.abort(new Error('DO_NOT_LEAK'))
      }
      await assert.rejects(f.files.consume(f.path, controller.signal), error => {
        assert.equal((error as Error).message, 'Private delivery file could not be validated or removed')
        assert.doesNotMatch(String(error), /DO_NOT_LEAK|dummy-only|\/tmp\//)
        return true
      })
      if (kind !== 'directory') await missing(f.path)
      assert.equal(await readFile(outside, 'utf8'), 'outside-dummy-only')
    } finally { await f.close() }
  })
}

test('rejects outside, noncanonical and invalid names without deleting unrelated files', async () => {
  const f = await fixture()
  try {
    const outside = join(f.base, 'outside.txt')
    await writeFile(outside, 'dummy-only', { mode: 0o600 })
    for (const path of [outside, `${f.directory}/../outside.txt`, `${f.directory}/./0123456789abcdef0123456789abcdef`, join(f.directory, 'unexpected.json'), `${f.path}.partial`, join(f.directory, '0123456789ABCDEF0123456789ABCDEF'), 'relative.txt']) {
      await assert.rejects(f.files.consume(path, signal()))
    }
    assert.equal(await readFile(outside, 'utf8'), 'dummy-only')
  } finally { await f.close() }
})

test('refuses symlinked or nonprivate delivery directories without reading or deleting their files', async () => {
  const f = await fixture()
  try {
    await writeFile(f.path, 'dummy-only', { mode: 0o600 })
    const alias = join(f.base, 'alias')
    await symlink(f.directory, alias)
    await assert.rejects(new SecretFiles(alias).consume(join(alias, '0123456789abcdef0123456789abcdef'), signal()))
    const ancestor = join(f.base, 'ancestor')
    await symlink(f.base, ancestor)
    const noncanonical = join(ancestor, 'delivery')
    await assert.rejects(new SecretFiles(noncanonical).consume(join(noncanonical, '0123456789abcdef0123456789abcdef'), signal()))
    await chmod(f.directory, 0o755)
    await assert.rejects(f.files.consume(f.path, signal()))
    assert.equal(await readFile(f.path, 'utf8'), 'dummy-only')
  } finally { await f.close() }
})

test('discard removes a late delivered file without reading the answer', async () => {
  const f = await fixture()
  try {
    await writeFile(f.path, 'dummy-only', { mode: 0o600 })
    await f.files.discard(f.path)
    await missing(f.path)
  } finally { await f.close() }
})
