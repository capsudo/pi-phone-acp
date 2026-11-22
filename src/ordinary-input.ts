import { z } from 'zod'
import * as acp from '@agentclientprotocol/sdk/unstable'
import type { PhoneBackend, PhoneEvent } from './phone.js'
import { askValues, formRequest, supportedSecretAsk } from './forms.js'
import { privateFields, privateValues, supportedPrivateForm } from './private-forms.js'

export const ordinaryInputWarning = 'This uses ordinary ADE input, not private delivery. Answers may be visible and retained in ADE history or logs. Masking depends on the ADE.'
const choices = ['Complete in pi-phone', 'Continue with ordinary input'] as const
const responseSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('accept'), content: z.record(z.string(), z.unknown()).nullish() }),
  z.object({ action: z.literal('decline') }), z.object({ action: z.literal('cancel') }),
])
type Request = (message: string, properties: Record<string, acp.ElicitationPropertySchema>, required?: string[]) => Promise<z.infer<typeof responseSchema>>

/** Consent contains no answer fields and must finish before any sensitive entry. */
export async function confirmOrdinaryInput(request: Request, destination: string): Promise<'continue' | 'phone' | 'decline'> {
  const message = [ordinaryInputWarning, destination,
    'Continue with ordinary input to enter answers here, or Complete in pi-phone to leave the request waiting there. No answer has been submitted. Decline cancels this phone request without submitting answers; Cancel leaves it waiting in pi-phone.'].join('\n\n')
  const answer = await request(message, { collection: {
    type: 'string', title: 'Choose where to enter answers', description: message, enum: [...choices],
  } }, ['collection'])
  if (answer.action === 'decline') return 'decline'
  if (answer.action === 'cancel') return 'phone'
  const { collection } = z.strictObject({ collection: z.enum(choices) }).parse(answer.content)
  return collection === choices[1] ? 'continue' : 'phone'
}

/** Only capability absence selects this path; a failed private attempt never does. */
export async function forwardOrdinarySensitive(
  phone: PhoneBackend, id: string, item: Extract<PhoneEvent, { type: 'approval' }>, client: acp.AgentContext, signal: AbortSignal,
  options: { formSupported: boolean, privateMcp: boolean },
): Promise<'done' | 'phone'> {
  if (!options.formSupported || options.privateMcp) return 'phone'
  const form = item.privateForm ? supportedPrivateForm(item.privateForm, item.tool) : supportedSecretAsk(item.form)
  if (!form) return 'phone'
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(20 * 60_000)])
  let current: () => Promise<boolean>
  let submit: (values: Record<string, string>) => Promise<void>
  let decline: () => Promise<void>
  if (form.type === 'ask') {
    if (!phone.secretAskCurrent || !phone.answerSecretAsk || !phone.declineSecretAsk) return 'phone'
    const approval = { ...item, form }
    current = () => phone.secretAskCurrent!(id, approval, lifetime)
    submit = values => phone.answerSecretAsk!(id, approval, askValues(form, values), lifetime)
    decline = () => phone.declineSecretAsk!(id, approval, lifetime)
  } else {
    if (!phone.privateFormCurrent || !phone.answerPrivate || !phone.declinePrivate) return 'phone'
    const approval = { ...item, privateForm: form }
    current = () => phone.privateFormCurrent!(id, approval, lifetime)
    submit = values => phone.answerPrivate!(id, approval, privateValues(form, values), lifetime)
    decline = () => phone.declinePrivate!(id, approval, lifetime)
  }
  const destination = form.type === 'ask'
    ? [form.title, form.text, `Submit action: ${form.submit}`, 'The developer of the requesting extension determines whether submitted answers are saved or returned to the phone model.'].filter(Boolean).join('\n\n')
    : form.type === 'secret' ? `Save in phone Settings > Secrets as ${form.name}. ${form.description}`
      : form.type === 'browser' ? `Fill the existing ${form.kind === 'code' ? 'code' : 'sign-in'} fields at ${form.site}. ${form.instruction ?? ''} Sign-in values are not saved in phone Secrets.`
        : `Fill the existing sign-in fields in ${form.app.label} on ${form.machineName}. Sign-in values are not saved in phone Secrets.`
  const request: Request = async (message, properties, required = []) => {
    lifetime.throwIfAborted()
    const answer = await client.request(acp.methods.client.elicitation.create,
      formRequest(id, item.callId, message, properties, required), { cancellationSignal: lifetime, stopWaitingOnCancel: true })
    lifetime.throwIfAborted()
    return responseSchema.parse(answer)
  }
  lifetime.throwIfAborted()
  if (!await current()) return 'phone'
  const consent = await confirmOrdinaryInput(request, destination)
  if (consent === 'phone') return 'phone'
  if (consent === 'decline') { await decline(); return 'done' }
  // Recheck after the warning too: owner/request changes must not open entry fields.
  if (!await current()) return 'phone'
  const fields = form.type === 'ask' ? form.fields : privateFields(form)
  const minLength = form.type === 'secret' ? 8 : 1
  const maxLength = form.type === 'ask' ? 4096 : 16_384
  const message = [ordinaryInputWarning, destination,
    `All ${fields.length} fields are required before one submission to the phone. Required text; ${minLength}–${maxLength} characters per field. The ADE may trim outer whitespace; use the phone when it matters. Decline rejects this phone request without sending values. Cancel leaves it waiting on the phone.`,
    form.type === 'ask' ? undefined : 'Line breaks and NUL are not allowed for this phone request.',
  ].filter(Boolean).join('\n\n')
  const properties = Object.fromEntries(fields.map(field => [field.name, {
    type: 'string' as const, title: field.label, minLength, maxLength,
    description: [message, 'placeholder' in field && field.placeholder && `Hint: ${field.placeholder}`].filter(Boolean).join('\n\n'),
  }]))
  const answer = await request(message, properties, fields.map(field => field.name))
  if (answer.action === 'cancel') return 'phone'
  if (answer.action === 'decline') await decline()
  else {
    const values = z.record(z.string(), z.string()).parse(answer.content)
    await submit(values)
  }
  return 'done'
}
