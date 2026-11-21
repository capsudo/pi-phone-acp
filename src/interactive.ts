import { z } from 'zod'
import * as acp from '@agentclientprotocol/sdk/unstable'
import type { PhoneBackend, PhoneEvent } from './phone.js'
import { askFormSchema, interviewFormSchema, privateAsk, askValues, formRequest, questionAnswer, questionProperties, questionText, supportedInterview, PhoneOnlyInterview, type ResponseItem } from './forms.js'
import { markdownLabel } from './markdown.js'

const responseSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('accept'), content: z.record(z.string(), z.unknown()).nullish() }),
  z.object({ action: z.literal('decline') }), z.object({ action: z.literal('cancel') }),
])
export type InteractiveApproval = Extract<PhoneEvent, { type: 'approval' }>

/** No form responses go into ACP message/tool updates or adapter diagnostics. */
export async function forwardInteractive(phone: PhoneBackend, id: string, item: InteractiveApproval, client: acp.AgentContext, signal: AbortSignal): Promise<'done' | 'phone'> {
  const form = item.form
  if (!form) return 'phone'
  const request = async (message: string, properties: Record<string, acp.ElicitationPropertySchema>, required: string[] = []) => {
    signal.throwIfAborted()
    const response = await client.request(acp.methods.client.elicitation.create,
      formRequest(id, item.callId, message, properties, required), { cancellationSignal: signal, stopWaitingOnCancel: true })
    signal.throwIfAborted()
    return responseSchema.parse(response)
  }
  if (form.type === 'ask') {
    // Projection is not the only possible PhoneBackend. Recheck at the collection
    // boundary: a masked field or extension-owned return path is not private.
    if (!askFormSchema.safeParse(form).success || privateAsk(form)) return 'phone'
    if (!phone.answerAsk || !phone.answerApproval) return 'phone'
    const message = [form.title, form.text, `Submit action: ${form.submit}`, 'Do not enter passwords or one-time codes here: ordinary T3 answers are stored in history. Required text; 1–4096 characters per field. T3 trims outer whitespace. Decline refuses this phone question. Cancel leaves it waiting on the phone.'].filter(Boolean).join('\n\n')
    const properties = Object.fromEntries(form.fields.map(field => [field.name, {
      type: 'string' as const, title: field.label,
      description: [message, field.placeholder && `Hint: ${field.placeholder}`].filter(Boolean).join('\n\n'), minLength: 1, maxLength: 4096,
    }]))
    // T3 does not render a zero-property schema: require an explicit completion value.
    const empty = form.fields.length === 0
    const answer = await request(message,
      empty ? { complete: { type: 'boolean', title: form.submit } } : properties, empty ? ['complete'] : form.fields.map(field => field.name))
    if (answer.action === 'cancel') return 'phone'
    if (answer.action === 'decline') await phone.answerApproval(item.id, false, signal)
    else {
      if (empty && !z.strictObject({ complete: z.literal(true) }).safeParse(answer.content).success) return 'phone'
      await phone.answerAsk(item.id, askValues(form, empty ? {} : answer.content), signal)
    }
    return 'done'
  }
  if (!interviewFormSchema.safeParse(form).success || !phone.getInterview || !phone.answerInterview) return 'phone'
  const original = await phone.getInterview(id, form.callId, signal)
  const interview = supportedInterview(original, form.count)
  const prefix = [markdownLabel(interview.questions.title ?? form.title), interview.questions.description,
    'Do not enter passwords or one-time codes here: ordinary T3 answers are stored in history. All answers are optional: use Skip to leave a question unanswered. No defaults are selected automatically. Other and choice notes are supported. T3 trims outer whitespace. Local answers are sent only after the final Submit confirmation. Decline skips the whole interview; Cancel leaves it waiting on the phone.'].filter(Boolean).join('\n\n')
  const draft: ResponseItem[] = []
  let context: string[] = []
  const unchanged = async () => {
    signal.throwIfAborted()
    const current = await phone.getInterview!(id, form.callId, signal)
    // No compare-and-swap route exists upstream. Refuse observed phone edits;
    // simultaneous editing in the phone sheet is not supported.
    if (JSON.stringify(current) !== JSON.stringify(original)) throw new PhoneOnlyInterview('state')
    signal.throwIfAborted()
  }
  const decline = async () => {
    await unchanged()
    // Omit draft: retain any saved phone prefills/partial answers on explicit skip.
    await phone.answerInterview!(id, form.callId, { action: 'cancel' }, signal)
  }
  for (const q of interview.questions.questions) {
    if (q.type === 'info') { context.push(questionText(q)); continue }
    const message = [prefix, ...context, questionText(q)].join('\n\n')
    context = []
    const routes = q.type === 'text' ? ['answer', 'skip'] : ['options', 'other', 'skip']
    const routeAnswer = await request(message, { route: { type: 'string', title: 'Answer this question', enum: routes } }, ['route'])
    if (routeAnswer.action === 'cancel') return 'phone'
    if (routeAnswer.action === 'decline') { await decline(); return 'done' }
    const { route } = z.strictObject({ route: z.string().refine(value => routes.includes(value)) }).parse(routeAnswer.content)
    if (route === 'skip') continue
    const property = route === 'other' ? { type: 'string' as const, title: 'Other choice' } : questionProperties(q).value!
    const answer = await request(message, { value: property }, ['value'])
    if (answer.action === 'cancel') return 'phone'
    if (answer.action === 'decline') { await decline(); return 'done' }
    const explicit = z.strictObject({ value: z.union([z.string().min(1), z.array(z.string()).min(1)]) }).parse(answer.content)
    if (route === 'other' && typeof explicit.value !== 'string') throw new Error('Invalid Other choice')
    const raw: Record<string, unknown> = route === 'other' ? { other: explicit.value } : { value: explicit.value }
    questionAnswer(q, raw) // Validate type/membership before displaying any returned choice in a note question.
    if (route === 'options') {
      const selected = Array.isArray(explicit.value) ? explicit.value : [explicit.value]
      // T3 requires every rendered field, even optional ones. Branch explicitly
      // instead of requiring placeholder notes or silently losing skip semantics.
      for (const option of selected) {
        const noteChoice = await request(message, { addNote: { type: 'boolean', title: `Add a note to ${option}?` } }, ['addNote'])
        if (noteChoice.action === 'cancel') return 'phone'
        if (noteChoice.action === 'decline') { await decline(); return 'done' }
        const { addNote } = z.strictObject({ addNote: z.boolean() }).parse(noteChoice.content)
        if (!addNote) continue
        const noteAnswer = await request(message, { note: { type: 'string', title: `Note for ${option}` } }, ['note'])
        if (noteAnswer.action === 'cancel') return 'phone'
        if (noteAnswer.action === 'decline') { await decline(); return 'done' }
        const { note } = z.strictObject({ note: z.string().min(1) }).parse(noteAnswer.content)
        const index = q.options!.findIndex(o => (typeof o === 'string' ? o : o.label) === option)
        if (index < 0) throw new Error('Invalid selection')
        raw[`note_${index}`] = note
      }
    }
    const value = questionAnswer(q, raw)
    if (value) draft.push(value)
  }
  const answer = await request([prefix, ...context, 'Review answers (unlisted questions remain unanswered):', `\`\`\`json\n${JSON.stringify(draft, null, 2)}\n\`\`\``,  'Submit replaces recommendation prefills with exactly these explicit answers.'].join('\n\n'),
    { submit: { type: 'boolean', title: 'Submit completed interview to pi-phone?' } }, ['submit'])
  if (answer.action === 'decline') { await decline(); return 'done' }
  if (answer.action !== 'accept' || !z.strictObject({ submit: z.literal(true) }).safeParse(answer.content).success) return 'phone'
  await unchanged()
  await phone.answerInterview(id, form.callId, { action: 'submit', draft }, signal)
  return 'done'
}
