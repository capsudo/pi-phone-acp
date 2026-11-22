import type { AskForm, InterviewForm, ResponseItem } from './forms.js'
import type { PrivateForm } from './private-forms.js'

/** Normalized phone boundary. Durable work always remains on the phone. */
export interface PhoneMessage {
  role: 'user' | 'assistant'
  text: string
}

export interface PhoneSession {
  id: string
  history: readonly PhoneMessage[]
  replay?: readonly PhoneEvent[]
}

export type PhoneEvent =
  | { type: 'text' | 'user' | 'thought' | 'notice', text: string }
  | { type: 'tool', id: string, name: string, status: 'pending' | 'in_progress' | 'completed' | 'failed', input?: unknown, output?: string }
  | { type: 'approval', id: string, callId: string, tool: string, subject: string, reason: string, interactive: boolean, form?: AskForm | InterviewForm, privateForm?: PrivateForm }
  | { type: 'approval_withdrawn', id: string }
  | { type: 'end', reason: 'end_turn' | 'cancelled' | 'max_tokens' }

export type PrivateApproval = Extract<PhoneEvent, { type: 'approval' }> & { privateForm: PrivateForm }

export type SecretAskApproval = Extract<PhoneEvent, { type: 'approval' }> & { form: AskForm }

export type InterviewApproval = Extract<PhoneEvent, { type: 'approval' }> & { form: InterviewForm }
export type InterviewAnswer = { action: 'submit' | 'cancel', draft?: ResponseItem[] }

export interface PhoneBackend {
  create(signal: AbortSignal): Promise<PhoneSession>
  load(id: string, signal: AbortSignal): Promise<PhoneSession>
  /** Aborting signal detaches the observer, never the phone task. */
  observe?(id: string, signal: AbortSignal): AsyncIterable<PhoneEvent>
  /** Submit once. A lost response must never trigger automatic resubmission. */
  run(id: string, text: string, requestId: string, signal: AbortSignal): AsyncIterable<PhoneEvent>
  /** Explicit user cancellation only, never transport loss or shutdown. */
  cancel(id: string, requestId: string): Promise<void>
  answerApproval?(id: string, allow: boolean, signal: AbortSignal): Promise<void>
  answerAsk?(id: string, values: Record<string, string>, signal: AbortSignal): Promise<void>
  secretAskCurrent?(id: string, approval: SecretAskApproval, signal: AbortSignal): Promise<boolean>
  answerSecretAsk?(id: string, approval: SecretAskApproval, values: Record<string, string>, signal: AbortSignal): Promise<void>
  declineSecretAsk?(id: string, approval: SecretAskApproval, signal: AbortSignal): Promise<void>
  privateFormCurrent?(id: string, approval: PrivateApproval, signal: AbortSignal): Promise<boolean>
  answerPrivate?(id: string, approval: PrivateApproval, values: Record<string, string>, signal: AbortSignal): Promise<void>
  declinePrivate?(id: string, approval: PrivateApproval, signal: AbortSignal): Promise<void>
  sensitiveInterviewCurrent?(id: string, approval: InterviewApproval, original: unknown, signal: AbortSignal): Promise<boolean>
  answerSensitiveInterview?(id: string, approval: InterviewApproval, original: unknown, answer: InterviewAnswer, signal: AbortSignal): Promise<void>
  getInterview?(id: string, callId: string, signal: AbortSignal): Promise<unknown>
  answerInterview?(id: string, callId: string, answer: { action: 'submit' | 'cancel', draft?: ResponseItem[] }, signal: AbortSignal): Promise<void>
}
