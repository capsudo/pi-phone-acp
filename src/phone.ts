/** Normalized phone boundary. Implementations must keep durable work on the phone. */
export interface PhoneMessage {
  role: 'user' | 'assistant'
  text: string
}

export interface PhoneSession {
  /** The native phone conversation ID, stable across adapter restarts. */
  id: string
  history: readonly PhoneMessage[]
}

export type PhoneEvent =
  | { type: 'text', text: string }
  | { type: 'thought', text: string }
  | { type: 'end', reason: 'end_turn' | 'cancelled' }

export interface PhoneBackend {
  create(signal: AbortSignal): Promise<PhoneSession>
  load(id: string, signal: AbortSignal): Promise<PhoneSession>
  /**
   * Submit once and observe its result. Aborting signal detaches the observer only.
   * A lost response must not cause automatic resubmission with a fresh request ID.
   * Yield end only when this submission is known to have settled on the phone.
   */
  run(id: string, text: string, requestId: string, signal: AbortSignal): AsyncIterable<PhoneEvent>
  /** Explicit user cancellation only, never called on transport loss or shutdown. */
  cancel(id: string, requestId: string): Promise<void>
}
