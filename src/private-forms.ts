import { z } from 'zod'

// Dedicated build-508 consumers only; never infer a private consumer from host.ask
// metadata or from an interview question's wording.
const text = z.string().min(1).max(2000)
const field = z.strictObject({ name: z.enum(['username', 'password', 'code']), index: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), label: text })
const fields = z.array(field).min(1).max(3).refine(items =>
  new Set(items.map(item => item.name)).size === items.length && new Set(items.map(item => item.index)).size === items.length)
export const privateFormSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('secret'), name: z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/), description: z.string().max(2000) }),
  z.strictObject({
    type: z.literal('browser'), kind: z.enum(['sign-in', 'code']), site: text, fields,
    instruction: z.string().max(2000).optional(), secret: text.optional(), saved: z.boolean().optional(), place: text.optional(),
  }).refine(form => form.kind === 'code'
    ? form.fields.length === 1 && form.fields[0]!.name === 'code'
    : form.fields.every(item => item.name !== 'code')),
  z.strictObject({
    type: z.literal('computer-sign-in'), machine: text, machineName: text,
    app: z.strictObject({ name: text, label: text }), fields, secret: text.optional(), saved: z.boolean().optional(),
  }),
])
export type PrivateForm = z.infer<typeof privateFormSchema>

export function supportedPrivateForm(raw: unknown, tool: string): PrivateForm | undefined {
  const result = privateFormSchema.safeParse(raw)
  if (!result.success) return undefined
  const form = result.data
  if ('saved' in form && form.saved) return undefined // Preserve the phone's saved-sign-in choices.
  const expected = form.type === 'secret' ? 'secret_request' : form.type === 'computer-sign-in' ? 'computer_sign_in'
    : form.kind === 'code' ? 'browser_ask_code' : 'browser_sign_in'
  return tool === expected ? form : undefined
}

export function privateFields(form: PrivateForm): { name: string, label: string }[] {
  if (form.type === 'secret') return [{ name: 'value', label: `Save ${form.name} in phone Settings > Secrets` }]
  const labels = { username: 'Username or email', password: 'Password', code: 'Security code' }
  return form.fields.map(item => ({ name: item.name, label: labels[item.name] }))
}

const valueSchema = (form: PrivateForm) => z.string().min(form.type === 'secret' ? 8 : 1).max(16_384).refine(value => !/[\r\n\u0000]/.test(value))

export function privateFieldValue(form: PrivateForm, value: unknown): string {
  return valueSchema(form).parse(value)
}

export function privateValues(form: PrivateForm, values: Record<string, string>): Record<string, string> {
  const schema = z.strictObject(Object.fromEntries(privateFields(form).map(field => [field.name, valueSchema(form)])))
  // Do not trim, normalize, convert OTPs to numbers, or include failures in diagnostics.
  return schema.parse(values)
}
