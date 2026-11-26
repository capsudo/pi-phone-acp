import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { readConfig } from './config.js'
import { readSocketPath, SocketOccupiedError } from './socket.js'

/** starts or reuses the configured adapter and returns the socket path and identity expected by the relay */
export async function ensureAdapter(env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<{ path: string, identity: string }> {
  const config = readConfig(env)
  const executable = await realpath(fileURLToPath(new URL('./cli.js', import.meta.url)))
  const version: unknown = JSON.parse(await readFile(join(dirname(executable), '../package.json'), 'utf8')).version
  const identity = createHash('sha256').update(JSON.stringify([
    1, executable, version, config.url.origin, config.cwd, config.tokenFile, env.HOME ?? '', env.PI_PHONE_SECRET_FILES_DIR ?? '',
  ])).digest('hex')

  let path = env.PI_PHONE_SOCKET
  if (!path) {
    let root = await realpath(tmpdir())
    if (Buffer.byteLength(join(root, `pi-phone-acp-${process.getuid?.()}`, `${identity.slice(0, 24)}.sock`)) > 100) {
      root = await realpath('/tmp')
    }
    const directory = join(root, `pi-phone-acp-${process.getuid?.()}`)
    await mkdir(directory, { mode: 0o700 }).catch(error => {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
        throw error
      }
    })
    path = join(directory, `${identity.slice(0, 24)}.sock`)
  }

  // validate the private directory before starting a process or trusting an existing socket
  let occupied = false
  try {
    const entry = await lstat(path)
    occupied = true
    if (!entry.isSocket() || entry.uid !== process.getuid?.()) {
      throw new Error('Adapter socket path is occupied')
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error
    }
  }

  if (!occupied) {
    try {
      await readSocketPath({ PI_PHONE_SOCKET: path }, false)
    } catch (error) {
      if (!(error instanceof SocketOccupiedError)) {
        throw error
      }
      // another launcher can bind after the initial lstat; reuse its endpoint instead of failing this launch
      occupied = true
    }
    if (!occupied) {
      signal.throwIfAborted()
      await startAdapter(executable, { ...env, PI_PHONE_SOCKET: path, PI_PHONE_INSTANCE: identity }, signal)
    }
  }

  // another ADE can arrive between bind and chmod; wait for the private endpoint, never change or delete it
  const deadline = Date.now() + 2000
  for (;;) {
    signal.throwIfAborted()
    try {
      await readSocketPath({ PI_PHONE_SOCKET: path }, true)
      return { path, identity }
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error
      }
      await delay(20, undefined, { signal })
    }
  }
}

async function startAdapter(executable: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  const child = spawn(process.execPath, [executable, '--serve'], {
    env,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })

  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', cancelled)
        child.off('message', message)
        child.off('error', failed)
        child.off('exit', failed)
        if (error) { reject(error) }
        else { resolve() }
      }
      const failed = () => finish(new Error('Could not start the persistent adapter'))
      const cancelled = () => finish(new Error('Adapter startup was cancelled'))
      const message = (value: unknown) => {
        if (!value || typeof value !== 'object' || !('type' in value)) {
          failed()
        }
        else if (value.type === 'ready' || value.type === 'occupied') {
          finish()
        }
        else {
          failed()
        }
      }
      const timer = setTimeout(failed, 5000)
      child.on('message', message)
      child.once('error', failed)
      child.once('exit', failed)
      signal.addEventListener('abort', cancelled, { once: true })
      if (signal.aborted) { cancelled() }
    })
  } catch (error) {
    child.kill('SIGTERM')
    throw error
  } finally {
    // release only this launcher's process handles; the adapter owns its listening socket after startup
    if (child.connected) { child.disconnect() }
    child.unref()
  }
}
