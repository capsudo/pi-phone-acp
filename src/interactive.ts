import { z } from 'zod'
import * as acp from '@agentclientprotocol/sdk'
import type { PhoneBackend, PhoneEvent } from './phone.js'
import { askValues, formRequest } from './forms.js'

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
  return 'phone'
}
