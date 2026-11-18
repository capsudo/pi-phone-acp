import type { z } from 'zod'

export class PhoneHttpError extends Error {
  constructor(readonly status: number) { super(`Phone HTTP request failed (${status})`) }
}

export class PhoneHttp {
  constructor(
    private readonly origin: URL,
    private readonly token: string,
    private readonly request: typeof fetch = fetch,
    private readonly timeoutMs = 35_000,
  ) {}

  async json<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal, body?: unknown): Promise<T> {
    // Only adapter-authored same-origin paths can receive this credential.
    if (!path.startsWith('/api/') || path.startsWith('//') || new URL(path, this.origin).origin !== this.origin.origin) {
      throw new Error('Invalid phone API path')
    }
    const response = await this.request(new URL(path, this.origin), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'X-Pocket': '1',
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new PhoneHttpError(response.status)
    }
    if (!response.headers.get('content-type')?.includes('application/json')) {
      await response.body?.cancel()
      throw new Error('Phone returned an incompatible response')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Phone returned no JSON body')
    let bytes = 0
    const chunks: Uint8Array[] = []
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > 32 * 1024 * 1024) throw new Error('Phone response exceeds 32 MiB')
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => {}) }
    return schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  }
}
