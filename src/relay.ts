import { createConnection } from 'node:net'
import type { Readable, Writable } from 'node:stream'
import { PhoneUnavailable } from './availability.js'
import { decodeData, readFrames } from './relay-protocol.js'
import { readSocketPath } from './socket.js'

export async function relayPhone(path: string, input: Readable, output: Writable, signal: AbortSignal, identity?: string): Promise<void> {
  await readSocketPath({ PI_PHONE_SOCKET: path }, true)
  signal.throwIfAborted()
  const socket = createConnection({ path, allowHalfOpen: true })
  const abort = () => {
    socket.destroy()
    // interrupt a blocked ADE output write as well; closing only the socket cannot release that wait
    output.destroy()
  }
  const inputError = () => socket.destroy()
  const outputError = () => socket.destroy()
  signal.addEventListener('abort', abort, { once: true })
  input.on('error', inputError)
  output.on('error', outputError)
  socket.on('error', () => {})
  let headerDeadline: NodeJS.Timeout | undefined

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => socket.destroy(), 2000)
      const failed = () => {
        cleanup()
        reject(new Error('Could not connect to the persistent adapter'))
      }
      const connected = () => {
        cleanup()
        resolve()
      }
      const cleanup = () => {
        clearTimeout(timer)
        socket.off('connect', connected)
        socket.off('close', failed)
        socket.off('error', failed)
      }
      socket.once('connect', connected)
      socket.once('close', failed)
      socket.once('error', failed)
    })

    // verify the backend identity before forwarding ADE input, so a socket override cannot select another configuration
    let accepted = identity === undefined
    if (accepted) {
      input.pipe(socket)
    }
    else {
      headerDeadline = setTimeout(() => socket.destroy(), 2000)
    }
    for await (const frame of readFrames(socket)) {
      if (frame.type === 'ready') {
        if (identity && (accepted || frame.identity !== identity)) {
          throw new Error('Persistent adapter does not match this configuration')
        }
        clearTimeout(headerDeadline)
        if (!accepted) {
          accepted = true
          input.pipe(socket)
        }
        continue
      }
      if (!accepted) {
        throw new Error('Persistent adapter did not identify its configuration')
      }
      if (frame.type === 'closed') {
        if (frame.reason !== 'closed') {
          throw new PhoneUnavailable(frame.reason)
        }
        return
      }
      const bytes = decodeData(frame.data)
      await new Promise<void>((resolve, reject) => {
        const cancelled = () => {
          signal.removeEventListener('abort', cancelled)
          reject(signal.reason)
        }
        if (signal.aborted) {
          cancelled()
          return
        }
        signal.addEventListener('abort', cancelled, { once: true })
        output.write(bytes, error => {
          signal.removeEventListener('abort', cancelled)
          if (error) {
            reject(new Error('ADE output is closed'))
          }
          else {
            resolve()
          }
        })
      })
    }
    if (!signal.aborted) {
      throw new Error('Persistent adapter connection ended unexpectedly')
    }
  } catch (error) {
    if (!signal.aborted) {
      throw error
    }
  } finally {
    clearTimeout(headerDeadline)
    signal.removeEventListener('abort', abort)
    input.off('error', inputError)
    if (!output.destroyed) {
      output.off('error', outputError)
    }
    input.unpipe(socket)
    socket.destroy()
  }
}
