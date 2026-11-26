import { lstat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { readFrames } from '../src/relay-protocol.js'

export async function adapterInfo(path: string) {
  const socket = createConnection(path)
  socket.on('error', () => {})
  socket.setTimeout(2000, () => socket.destroy(new Error('Test adapter did not identify itself')))
  try {
    for await (const frame of readFrames(socket)) {
      if (frame.type !== 'ready') {
        throw new Error('Test adapter did not send its identity')
      }
      return frame
    }
    throw new Error('Test adapter closed before identifying itself')
  } finally { socket.destroy() }
}

export async function stopAdapter(path: string): Promise<void> {
  let pid: number
  try {
    await lstat(path)
    pid = (await adapterInfo(path)).pid
  } catch (error) {
    if (error instanceof Error && 'code' in error && ['ENOENT', 'ECONNREFUSED'].includes(String(error.code))) {
      return
    }
    throw error
  }
  try { process.kill(pid, 'SIGTERM') } catch { return }
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    try { process.kill(pid, 0) } catch { return }
    await delay(20)
  }
  try { process.kill(pid, 'SIGKILL') } catch {}
}
