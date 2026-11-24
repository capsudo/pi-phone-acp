import { setTimeout as delay } from 'node:timers/promises'
import { PhoneContractError, PhoneHttpError } from './http.js'
import type { PhoneBackend } from './phone.js'

export type PhoneFailure = 'authentication' | 'incompatible' | 'unreachable'
const messages: Record<PhoneFailure, string> = {
  authentication: 'Phone authentication or authorization failed. Check the private device-session token and phone access.',
  incompatible: 'Phone API is incompatible. Check the build-508 interface. ACP disconnected; phone work was not cancelled or resubmitted.',
  unreachable: 'Phone API is unreachable or timed out. ACP disconnected; phone work was not cancelled or resubmitted. Reconnect to the same conversation to inspect its state.',
}

/** Contains only adapter-authored diagnostics, never a backend error or response. */
export class PhoneUnavailable extends Error {
  constructor(readonly reason: PhoneFailure) { super(messages[reason]) }
}

export interface AvailabilityOptions {
  timeoutMs?: number
  intervalMs?: number
  retryDelayMs?: number
}

export async function verifyPhone(phone: PhoneBackend, signal: AbortSignal, timeoutMs = 10_000): Promise<void> {
  signal.throwIfAborted()
  try {
    await phone.doctor(AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]))
    signal.throwIfAborted()
  } catch (error) {
    // Client shutdown/cancellation is not evidence of a phone failure.
    signal.throwIfAborted()
    const reason = error instanceof PhoneHttpError && [401, 403].includes(error.status) ? 'authentication'
      : error instanceof PhoneContractError || (error instanceof PhoneHttpError && error.status < 500 && ![408, 429].includes(error.status)) ? 'incompatible'
        : 'unreachable'
    throw new PhoneUnavailable(reason)
  }
}

/** One sequential, read-only monitor per connection, including when no session is attached. */
export async function watchPhone(phone: PhoneBackend, signal: AbortSignal, options: AvailabilityOptions = {}): Promise<void> {
  let failures = 0
  for (;;) {
    await delay(failures ? options.retryDelayMs ?? 5000 : options.intervalMs ?? 15_000, undefined, { signal })
    try {
      await verifyPhone(phone, signal, options.timeoutMs)
      failures = 0
    } catch (error) {
      signal.throwIfAborted()
      // Auth/contract failures are definitive. Allow one transient network/5xx
      // failure; confirm it with another /api/me read, never a conversation write.
      if (!(error instanceof PhoneUnavailable) || error.reason !== 'unreachable' || ++failures >= 2) throw error
    }
  }
}
