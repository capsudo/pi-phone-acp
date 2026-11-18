import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

export interface Config {
  url: URL
  tokenFile: string
  cwd: string
}

export function readConfig(env: NodeJS.ProcessEnv): Config {
  let url: URL
  try { url = new URL(env.PI_PHONE_URL ?? '') } catch { throw new Error('PI_PHONE_URL must be a service origin') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('PI_PHONE_URL must be an HTTP(S) origin without credentials, path, query or fragment')
  }
  const tokenFile = env.PI_PHONE_TOKEN_FILE
  if (!tokenFile || !isAbsolute(tokenFile)) throw new Error('PI_PHONE_TOKEN_FILE must name an absolute private file path')
  const cwd = env.PI_PHONE_CWD ?? '~/work'
  if (!cwd.startsWith('/') && !cwd.startsWith('~/')) throw new Error('PI_PHONE_CWD must be a local phone path, absolute or beginning with ~/')
  return { url, tokenFile, cwd }
}

export async function readToken(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 8192 || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error('Credential file must be an owned regular file, private to its owner, and at most 8 KiB')
    }
    const token = (await file.readFile('utf8')).trim()
    if (!token || /\s|[^\x21-\x7e]/.test(token)) throw new Error('Credential file must contain only one device-session token')
    return token
  } finally { await file.close() }
}
