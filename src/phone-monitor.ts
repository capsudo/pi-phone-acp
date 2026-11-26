import { setTimeout as delay } from 'node:timers/promises'
import { PhoneUnavailable, verifyPhone, type AvailabilityOptions } from './availability.js'
import type { PhoneBackend } from './phone.js'

interface Connection {
  readonly signal: AbortSignal
  close(error?: unknown): void
}

/** shares phone checks across relay connections without sharing their ACP session state */
export class PhoneMonitor {
  private readonly lifetime = new AbortController()
  private readonly connections = new Set<Connection>()
  private readonly interval: number
  private probe: Promise<void> | undefined
  private diagnosis: Promise<void> | undefined
  private worker: Promise<void> | undefined
  private lastContact = 0
  private lastCheck = 0
  private lastDiagnosis = -Infinity
  private failure: PhoneUnavailable | undefined

  constructor(
    private readonly phone: PhoneBackend,
    private readonly options: AvailabilityOptions = {},
    private readonly onStatus?: (failure: PhoneUnavailable | undefined) => void,
  ) {
    this.interval = options.intervalMs ?? 300_000
  }

  start(): void {
    if (!this.worker) {
      this.worker = this.run()
    }
  }

  contact(): void {
    this.lastContact = Date.now()
  }

  async attach(connection: Connection): Promise<void> {
    this.lifetime.signal.throwIfAborted()
    connection.signal.throwIfAborted()
    this.connections.add(connection)
    connection.signal.addEventListener('abort', () => this.connections.delete(connection), { once: true })

    try {
      // every new ACP connection must pass a current authenticated read; concurrent reads share one request
      await this.check()
      connection.signal.throwIfAborted()
    } catch (error) {
      if (!connection.signal.aborted && !this.lifetime.signal.aborted) {
        const failure = error instanceof PhoneUnavailable ? error : new PhoneUnavailable('unreachable')
        connection.close(failure)
        this.suspect()
      }
      throw error
    }
  }

  suspect(): void {
    if (this.lifetime.signal.aborted || this.diagnosis || Date.now() - this.lastDiagnosis < this.interval) {
      return
    }

    this.lastDiagnosis = Date.now()
    void this.diagnose()
  }

  async stop(): Promise<void> {
    this.lifetime.abort()
    for (const connection of this.connections) {
      connection.close()
    }
    this.connections.clear()
    await Promise.all([this.worker, this.diagnosis, this.probe].map(task => task?.catch(() => {})))
  }

  private check(): Promise<void> {
    if (!this.probe) {
      this.lastCheck = Date.now()
      this.probe = verifyPhone(this.phone, this.lifetime.signal, this.options.timeoutMs).then(() => {
        this.contact()
        this.setStatus(undefined)
      }).finally(() => { this.probe = undefined })
    }
    return this.probe
  }

  private diagnose(): Promise<void> {
    if (!this.diagnosis) {
      this.diagnosis = this.confirmLoss().finally(() => { this.diagnosis = undefined })
    }
    return this.diagnosis
  }

  private async confirmLoss(): Promise<void> {
    try {
      try {
        await this.check()
      } catch (error) {
        this.lifetime.signal.throwIfAborted()
        if (!(error instanceof PhoneUnavailable) || error.reason !== 'unreachable') {
          throw error
        }
        await delay(this.options.retryDelayMs ?? 5000, undefined, { signal: this.lifetime.signal })
        await this.check()
      }
    } catch (error) {
      if (!this.lifetime.signal.aborted) {
        const failure = error instanceof PhoneUnavailable ? error : new PhoneUnavailable('unreachable')
        this.setStatus(failure)
        for (const connection of this.connections) {
          connection.close(failure)
        }
      }
    }
  }

  private setStatus(failure: PhoneUnavailable | undefined): void {
    const changed = this.failure?.reason !== failure?.reason
    this.failure = failure
    if (changed) {
      if (!failure) {
        this.lastDiagnosis = -Infinity
      }
      this.onStatus?.(failure)
    }
  }

  private async run(): Promise<void> {
    try {
      for (;;) {
        // validated phone traffic already proves contact; idle and offline adapters still get periodic checks
        if (Date.now() - this.lastContact >= this.interval) {
          await this.diagnose()
        }
        const nextCheck = Math.max(this.lastContact, this.lastCheck) + this.interval
        await delay(Math.max(1, nextCheck - Date.now()), undefined, { signal: this.lifetime.signal })
      }
    } catch {
      // stop() aborts the timer and any in-flight read without changing phone availability
    }
  }
}
