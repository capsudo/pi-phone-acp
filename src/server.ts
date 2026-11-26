import { chmod } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { PassThrough, Readable } from 'node:stream'
import { ndJsonStream } from '@agentclientprotocol/sdk/unstable'
import { createAdapter } from './adapter.js'
import { PhoneUnavailable } from './availability.js'
import type { PhoneBackend } from './phone.js'
import type { PhoneMonitor } from './phone-monitor.js'
import { writeFrame } from './relay-protocol.js'
import { readSocketPath } from './socket.js'

export async function servePhone(path: string, monitor: PhoneMonitor, createPhone: () => PhoneBackend, identity?: string) {
  await readSocketPath({ PI_PHONE_SOCKET: path }, false)
  const clients = new Map<Socket, () => void>()
  const done = Promise.withResolvers<void>()
  let stopping: Promise<void> | undefined

  const server = createServer({ allowHalfOpen: true }, socket => {
    const input = new PassThrough()
    let closing = false
    let shutdownTimer: NodeJS.Timeout | undefined
    socket.pipe(input)
    if (identity) {
      void writeFrame(socket, { type: 'ready', identity, pid: process.pid }).catch(() => socket.destroy())
    }

    const connection = createAdapter(createPhone(), { phoneMonitor: monitor }).connect(ndJsonStream(
      new WritableStream<Uint8Array>({
        write(bytes) {
          if (closing) {
            throw new Error('ACP connection is closed')
          }
          return writeFrame(socket, { type: 'data', data: Buffer.from(bytes).toString('base64') })
        },
      }),
      Readable.toWeb(input) as ReadableStream<Uint8Array>,
    ))

    const stop = () => connection.close()
    clients.set(socket, stop)
    socket.on('error', stop)
    socket.once('end', stop)
    socket.once('close', () => {
      clearTimeout(shutdownTimer)
      clients.delete(socket)
      input.destroy()
      stop()
    })

    connection.signal.addEventListener('abort', () => {
      closing = true
      const failure = connection.signal.reason
      const reason = failure instanceof PhoneUnavailable ? failure.reason : 'closed'
      // keep the physical socket long enough to deliver the sanitized close reason to the relay
      shutdownTimer = setTimeout(() => socket.destroy(), 2000)
      shutdownTimer.unref()
      void writeFrame(socket, { type: 'closed', reason }).then(() => socket.end(), () => socket.destroy())
    }, { once: true })
  })

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => {
        server.off('error', reject)
        resolve()
      })
    })
    await chmod(path, 0o600)
  } catch (error) {
    if (server.listening) {
      server.close()
    }
    throw error
  }

  const stop = (): Promise<void> => {
    if (!stopping) {
      stopping = (async () => {
        const listenerClosed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
        for (const close of clients.values()) {
          close()
        }
        await monitor.stop()
        await listenerClosed
      })().then(() => { done.resolve() }, error => {
        done.reject(error)
        throw error
      })
    }
    return stopping
  }

  server.on('error', () => { void stop().catch(() => {}) })
  monitor.start()
  return { stop, closed: done.promise }
}
