import { z } from 'zod'
import type * as acp from '@agentclientprotocol/sdk'

// Source-checked against build-508 host.ts, extension-points.ts and interviews.ts.
export const askFormSchema = z.strictObject({
  type: z.literal('ask'), title: z.string().min(1).max(120), text: z.string().max(2000).optional(), submit: z.string().min(1).max(30),
  fields: z.array(z.strictObject({
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/), label: z.string().min(1).max(80),
    secret: z.boolean().optional(), placeholder: z.string().optional(), autocomplete: z.string().optional(),
  })).max(6),
}).refine(form => new Set(form.fields.map(field => field.name)).size === form.fields.length)
export type AskForm = z.infer<typeof askFormSchema>
// Input intent, not code/context blocks: displaying source code is not asking for an OTP.
const sensitive = /password|passphrase|\bsecret\b|\botp(?:[ _-]?code)?\b|one[ _-]?time|verification[ _-]*code|security[ _-]*code|auth(?:entication)?[ _-]*code|\b2fa\b|\bmfa\b|two[ -]factor|login[ _-]*code|credential|private[ _-]*key|bearer[ _-]*token|recovery[ _-]*code|backup[ _-]*code|\btotp\b|access[ _-]*token|api[ _-]*key|\bpin(?:[ _-]?code)?\b|(?:enter|paste|type|provide)[^\n]{0,30}\bcode\b/i
export const sensitiveInput = (text: string) => sensitive.test(text)
export function privateAsk(form: AskForm): boolean {
  return sensitiveInput(`${form.title}\n${form.text ?? ''}`) || form.fields.some(field =>
    field.secret === true || /^(code|token|credential)$/i.test(field.name) || /^(code|token|credential)[?:]?$/i.test(field.label.trim()) || sensitiveInput(`${field.name}\n${field.label}\n${field.placeholder ?? ''}\n${field.autocomplete ?? ''}`))
}

export function formRequest(sessionId: string, toolCallId: string, message: string, properties: Record<string, acp.ElicitationPropertySchema>, required: string[] = []): acp.CreateElicitationRequest {
  return { mode: 'form', sessionId, toolCallId, message, requestedSchema: { type: 'object', properties, required } }
}
export function askValues(form: AskForm, content: unknown): Record<string, string> {
  return z.strictObject(Object.fromEntries(form.fields.map(field => [field.name, z.string().min(1).max(4096)]))).parse(content ?? {})
}
