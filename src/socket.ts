import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'

export class SocketOccupiedError extends Error {
  constructor() { super('Socket path is already occupied') }
}

export async function readSocketPath(env: NodeJS.ProcessEnv, existing: boolean): Promise<string> {
  const path = env.PI_PHONE_SOCKET
  if (!path || !isAbsolute(path) || Buffer.byteLength(path) > 100 || path.includes('\0')) {
    throw new Error('PI_PHONE_SOCKET must name an absolute local socket path of at most 100 bytes')
  }

  const directory = dirname(path)
  const parent = await lstat(directory)
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0 || await realpath(directory) !== directory) {
    throw new Error('Socket directory must be canonical, owned and private')
  }

  let entry
  try {
    entry = await lstat(path)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error
    }
  }

  if (existing) {
    if (!entry?.isSocket() || entry.uid !== process.getuid?.() || (entry.mode & 0o077) !== 0) {
      throw new Error('Relay requires an owned private socket')
    }
  }
  else if (entry) {
    // preserve occupied paths, including stale sockets; never unlink another adapter's endpoint
    throw new SocketOccupiedError()
  }

  return path
}
