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
export const interviewFormSchema = z.strictObject({
  type: z.literal('interview'), callId: z.string().min(1), title: z.string(), count: z.number().int().nonnegative(),
})

// Input intent, not code/context blocks: displaying source code is not asking for an OTP.
const sensitive = /password|passphrase|\bsecret\b|\botp(?:[ _-]?code)?\b|one[ _-]?time|verification[ _-]*code|security[ _-]*code|auth(?:entication)?[ _-]*code|\b2fa\b|\bmfa\b|two[ -]factor|login[ _-]*code|credential|private[ _-]*key|bearer[ _-]*token|recovery[ _-]*code|backup[ _-]*code|\btotp\b|access[ _-]*token|api[ _-]*key|\bpin(?:[ _-]?code)?\b|(?:enter|paste|type|provide)[^\n]{0,30}\bcode\b/i
export const sensitiveInput = (text: string) => sensitive.test(text)
export function privateAsk(form: AskForm): boolean {
  return sensitiveInput(`${form.title}\n${form.text ?? ''}`) || form.fields.some(field =>
    field.secret === true || /^(code|token|credential)$/i.test(field.name) || /^(code|token|credential)[?:]?$/i.test(field.label.trim()) || sensitiveInput(`${field.name}\n${field.label}\n${field.placeholder ?? ''}\n${field.autocomplete ?? ''}`))
}

const contentSchema = z.strictObject({
  source: z.string(), lang: z.string().optional(), file: z.string().optional(), title: z.string().optional(),
  showSource: z.boolean().optional(), lines: z.string().optional(), highlights: z.array(z.number().int()).optional(),
})
const optionSchema = z.union([z.string().min(1), z.strictObject({
  label: z.string().min(1), content: contentSchema.optional(), recommended: z.boolean().optional(), conviction: z.enum(['strong', 'slight']).optional(),
})])
const questionSchema = z.strictObject({
  id: z.string().min(1), type: z.enum(['single', 'multi', 'text', 'info']), question: z.string(),
  options: z.array(optionSchema).min(1).optional(), recommended: z.union([z.string(), z.array(z.string())]).optional(),
  conviction: z.enum(['strong', 'slight']).optional(), weight: z.enum(['critical', 'minor']).optional(),
  context: z.string().optional(), content: contentSchema.optional(),
})
const choiceSchema = z.strictObject({ option: z.string(), note: z.string().optional() })
export const responseItemSchema = z.strictObject({
  id: z.string(), value: z.union([z.string(), z.array(z.string()), choiceSchema, z.array(choiceSchema)]),
  attachments: z.array(z.string()).optional(),
})
export type ResponseItem = z.infer<typeof responseItemSchema>
export const interviewSchema = z.strictObject({
  questions: z.strictObject({ title: z.string().optional(), description: z.string().optional(), questions: z.array(questionSchema).min(1).max(50) }),
  draft: z.array(responseItemSchema), status: z.enum(['waiting', 'completed', 'cancelled', 'timeout']),
  createdAt: z.number(), by: z.string().optional(), at: z.number().optional(),
  asked: z.record(z.string(), z.unknown()).optional(),
})
export type Interview = z.infer<typeof interviewSchema>
export type Question = Interview['questions']['questions'][number]
export const labelOf = (option: z.infer<typeof optionSchema>) => typeof option === 'string' ? option : option.label

const phoneOnlyReasons = {
  schema: 'This interview has unsupported or malformed questions, fields or rich content.',
  private: 'This interview requests sensitive input without a verified private return path.',
  media: 'This interview needs phone-only media, Markdown rendering or source-layout features.',
  draft: 'This interview already has a saved phone draft or helper conversation; it will not be replaced.',
  state: 'This interview ended or changed, or its question metadata does not match.',
} as const
export class PhoneOnlyInterview extends Error {
  constructor(reason: keyof typeof phoneOnlyReasons) { super(phoneOnlyReasons[reason]) }
}

export function supportedInterview(raw: unknown, count: number): Interview {
  const result = interviewSchema.safeParse(raw)
  if (!result.success) throw new PhoneOnlyInterview('schema')
  const item = result.data
  const { questions } = item.questions
  if (item.status !== 'waiting' || questions.filter(q => q.type !== 'info').length !== count ||
      new Set(questions.map(q => q.id)).size !== questions.length) throw new PhoneOnlyInterview('state')
  if (sensitiveInput(`${item.questions.title ?? ''}\n${item.questions.description ?? ''}`)) throw new PhoneOnlyInterview('private')
  const unsupportedMedia = /!\[|<(?:img|iframe|video|audio|svg|script)\b|```mermaid/i
  if (unsupportedMedia.test(`${item.questions.title ?? ''}\n${item.questions.description ?? ''}`)) throw new PhoneOnlyInterview('media')
  for (const q of questions) {
    if (q.type !== 'info' && (/^(code|token|credential)$/i.test(q.id) || sensitiveInput(`${q.id}\n${q.question}\n${q.context ?? ''}`))) throw new PhoneOnlyInterview('private')
    if (unsupportedMedia.test(`${q.question}\n${q.context ?? ''}`)) throw new PhoneOnlyInterview('media')
    const labels = q.options?.map(labelOf) ?? []
    if ((q.type === 'single' || q.type === 'multi') !== (labels.length > 0) || new Set(labels).size !== labels.length) throw new PhoneOnlyInterview('schema')
    const rec = q.recommended === undefined ? [] : Array.isArray(q.recommended) ? q.recommended : [q.recommended]
    if (rec.some(value => !labels.includes(value)) || (q.type === 'single' && rec.length > 1) || (q.conviction && !rec.length)) throw new PhoneOnlyInterview('schema')
    // Layout/highlight selections and active Markdown/media need the phone renderer.
    for (const content of [q.content, ...(q.options ?? []).map(o => typeof o === 'string' ? undefined : o.content)]) {
      if (content && (content.lines !== undefined || content.highlights !== undefined || content.showSource === false ||
          /^mermaid$/i.test(content.lang ?? '') || (/^(md|markdown)$/i.test(content.lang ?? '') &&
            (unsupportedMedia.test(content.source) || /<[A-Za-z!/]/.test(content.source))))) throw new PhoneOnlyInterview('media')
    }
  }
  // Never flatten attachments, helper conversations or a person's existing saved draft.
  // Recommendation-only prefills are safe to describe, but never auto-accept.
  const prefill = questions.flatMap(q => q.recommended === undefined || q.conviction === 'slight' ? [] : [{
    id: q.id, value: Array.isArray(q.recommended) ? q.recommended.map(option => ({ option })) : { option: q.recommended },
  }])
  if (Object.keys(item.asked ?? {}).length || (item.draft.length && JSON.stringify(item.draft) !== JSON.stringify(prefill))) throw new PhoneOnlyInterview('draft')
  return item
}

export function formRequest(sessionId: string, toolCallId: string, message: string, properties: Record<string, acp.ElicitationPropertySchema>, required: string[] = []): acp.CreateElicitationRequest {
  return { mode: 'form', sessionId, toolCallId, message, requestedSchema: { type: 'object', properties, required } }
}
export function askValues(form: AskForm, content: unknown): Record<string, string> {
  return z.strictObject(Object.fromEntries(form.fields.map(field => [field.name, z.string().min(1).max(4096)]))).parse(content ?? {})
}
export function questionText(q: Question): string {
  const blocks = [q.question, q.context]
  const content = (c: z.infer<typeof contentSchema>) => {
    // Use a fence longer than any source fence so context cannot become active HTML/media.
    const length = [...c.source.matchAll(/`+/g)].reduce((max, match) => Math.max(max, match[0].length + 1), 3)
    const fence = '`'.repeat(length)
    const source = /^(md|markdown)$/i.test(c.lang ?? '') ? c.source : `${fence}\n${c.source}\n${fence}`
    return [c.title, c.file && `File: ${c.file}`, c.lang && `Language: ${c.lang}`, source].filter(v => v !== undefined && v !== '').join('\n')
  }
  if (q.content) blocks.push(content(q.content))
  q.options?.forEach(o => {
    if (typeof o !== 'string') blocks.push(`Option: ${o.label}${o.recommended ? ' (recommended)' : ''}${o.conviction ? ` (${o.conviction})` : ''}${o.content ? `\n${content(o.content)}` : ''}`)
  })
  if (q.recommended !== undefined) blocks.push(`Recommended: ${JSON.stringify(q.recommended)}${q.conviction ? ` (${q.conviction})` : ''}. Not selected automatically.`)
  if (q.weight) blocks.push(`Weight: ${q.weight}`)
  return blocks.filter(v => v !== undefined).join('\n\n')
}
export function questionProperties(q: Question): Record<string, acp.ElicitationPropertySchema> {
  if (q.type === 'text') return { value: { type: 'string', title: q.question } }
  const labels = q.options!.map(labelOf)
  return { value: q.type === 'multi'
    ? { type: 'array', title: q.question, items: { type: 'string', enum: labels }, minItems: 1 }
    : { type: 'string', title: q.question, enum: labels } }
}
export function questionAnswer(q: Question, raw: unknown): ResponseItem | undefined {
  if (q.type === 'text') {
    const { value } = z.strictObject({ value: z.string().optional() }).parse(raw ?? {})
    return value === undefined || value === '' ? undefined : { id: q.id, value }
  }
  const labels = q.options!.map(labelOf)
  const data = z.strictObject({
    value: (q.type === 'multi' ? z.array(z.string()).refine(v => new Set(v).size === v.length) : z.string()).optional(),
    other: z.string().optional(),
    ...Object.fromEntries(labels.map((_, i) => [`note_${i}`, z.string().optional()])),
  }).parse(raw ?? {}) as Record<string, string | string[] | undefined>
  const selected = data.value === undefined ? [] : Array.isArray(data.value) ? data.value : [data.value]
  if (selected.some(value => !labels.includes(value))) throw new Error('Invalid selection')
  const other = typeof data.other === 'string' && data.other !== '' ? data.other : undefined
  if (q.type === 'single' && other && selected.length) throw new Error('Choose one answer')
  const choices = selected.map(option => {
    const note = data[`note_${labels.indexOf(option)}`] as string | undefined
    return { option, ...(note ? { note } : {}) }
  })
  labels.forEach((label, i) => { if (data[`note_${i}`] && !selected.includes(label)) throw new Error('Note without selection') })
  if (other) choices.push({ option: other })
  return choices.length ? { id: q.id, value: q.type === 'single' ? choices[0]! : choices } : undefined
}
