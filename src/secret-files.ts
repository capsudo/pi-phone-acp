import { constants } from 'node:fs'
import { lstat, open, realpath, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'

const maxBytes = 64 * 1024
const refused = () => new Error('Private delivery file could not be validated or removed')

/** Linux file delivery. Neither contents, paths nor filesystem exceptions escape. */
export class SecretFiles {
  constructor(readonly directory: string) {}

  get supported(): boolean {
    return process.platform === 'linux' && typeof process.getuid === 'function' && isAbsolute(this.directory) && resolve(this.directory) === this.directory
  }

  async consume(path: string, signal: AbortSignal): Promise<string> {
    return this.access(path, signal, true) as Promise<string>
  }

  async discard(path: string): Promise<void> {
    await this.access(path, new AbortController().signal, false)
  }

  private async access(path: string, signal: AbortSignal, read: boolean): Promise<string | undefined> {
    let directory: Awaited<ReturnType<typeof open>> | undefined
    let file: Awaited<ReturnType<typeof open>> | undefined
    let leaf: string | undefined
    let failure = false
    let value: string | undefined
    try {
      const root = this.directory
      if (process.platform !== 'linux' || !process.getuid || !isAbsolute(root) || resolve(root) !== root ||
          typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || dirname(path) !== root ||
          !/^[0-9a-f]{32}$/.test(basename(path)) || await realpath(root) !== root) throw refused()
      directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      const parent = await directory.stat()
      const current = await lstat(root)
      if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o7777) !== 0o700 ||
          current.dev !== parent.dev || current.ino !== parent.ino || await realpath(root) !== root) throw refused()
      // Keep lookup and unlink under the checked directory descriptor even if a
      // parent pathname changes. The final component is never followed.
      leaf = `/proc/self/fd/${directory.fd}/${basename(path)}`
      file = await open(leaf, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const before = await file.stat()
      if (!before.isFile() || before.uid !== process.getuid() || (before.mode & 0o7777) !== 0o600 || before.nlink !== 1 ||
          before.size < 1 || before.size > maxBytes) throw refused()
      if (read) {
        const bytes = Buffer.alloc(maxBytes + 1)
        try {
          let size = 0
          for (;;) {
            signal.throwIfAborted()
            const { bytesRead } = await file.read(bytes, size, bytes.length - size, null)
            if (!bytesRead) break
            size += bytesRead
            if (size > maxBytes) throw refused()
          }
          signal.throwIfAborted()
          const after = await file.stat()
          if (size !== before.size || after.size !== size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw refused()
          value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size))
        } finally { bytes.fill(0) }
      }
    } catch (error) {
      if (read || (error as NodeJS.ErrnoException).code !== 'ENOENT') failure = true
    }
    finally {
      // Only names beneath the validated owner-only directory can reach unlink;
      // malformed external paths are never read, followed or removed.
      if (leaf) {
        try { await unlink(leaf) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failure = true
        }
      }
      try { await file?.close() } catch { failure = true }
      try { await directory?.close() } catch { failure = true }
    }
    if (failure) throw refused()
    return value
  }
}
