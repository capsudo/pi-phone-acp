import type { Socket } from 'node:net'
import { z } from 'zod'

const maxFrameBytes = 48 * 1024 * 1024
const frameSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ready'), identity: z.string().regex(/^[a-f0-9]{64}$/), pid: z.number().int().positive() }),
  z.strictObject({ type: z.literal('data'), data: z.string() }),
  z.strictObject({ type: z.literal('closed'), reason: z.enum(['closed', 'authentication', 'incompatible', 'unreachable']) }),
])
export type RelayFrame = z.infer<typeof frameSchema>

export function writeFrame(socket: Socket, frame: RelayFrame): Promise<void> {
  const line = JSON.stringify(frame) + '\n'
  if (Buffer.byteLength(line) > maxFrameBytes || socket.destroyed) {
    return Promise.reject(new Error('Relay transport is unavailable'))
  }
  return new Promise<void>((resolve, reject) => {
    socket.write(line, error => {
      if (error) {
        reject(new Error('Relay transport is unavailable'))
      }
      else {
        resolve()
      }
    })
  })
}

export async function* readFrames(socket: Socket): AsyncGenerator<RelayFrame> {
  let parts: Buffer[] = []
  let length = 0
  for await (const bytes of socket) {
    const chunk = Buffer.from(bytes as Uint8Array)
    let start = 0
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start)
      const end = newline < 0 ? chunk.length : newline
      length += end - start
      if (length > maxFrameBytes) {
        throw new Error('Relay frame exceeds the transport limit')
      }
      parts.push(chunk.subarray(start, end))
      if (newline < 0) {
        break
      }
      const line = Buffer.concat(parts, length).toString('utf8')
      parts = []
      length = 0
      let frame: RelayFrame
      try {
        frame = frameSchema.parse(JSON.parse(line))
      } catch {
        throw new Error('Relay returned an incompatible frame')
      }
      yield frame
      start = newline + 1
    }
  }
  if (length) {
    throw new Error('Relay stream ended within a frame')
  }
}

export function decodeData(data: string): Buffer {
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length > 32 * 1024 * 1024 + 1 || bytes.toString('base64') !== data) {
    throw new Error('Relay returned invalid ACP data')
  }
  return bytes
}
