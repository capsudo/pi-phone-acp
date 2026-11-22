import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type * as acp from '@agentclientprotocol/sdk/unstable'
import type { PhoneBackend, PrivateApproval, SecretAskApproval } from './phone.js'
import { privateFields, privateFieldValue, privateValues, supportedPrivateForm } from './private-forms.js'
import { askValues, supportedSecretAsk } from './forms.js'
import { SecretFiles } from './secret-files.js'

const failed = () => new Error('Private input could not be forwarded; complete it on the phone. No automatic retry was attempted.')
const connectionSchema = z.object({ connectionId: z.string().min(1).max(200) })
const deliverySchema = z.union([
  z.strictObject({ status: z.literal('saved'), file: z.string().min(1).max(4096) }),
  z.strictObject({ status: z.enum(['declined', 'cancelled', 'timed_out']), note: z.string().max(2000).optional() }),
])
const resultSchema = z.object({
  isError: z.literal(false), structuredContent: deliverySchema,
  content: z.tuple([z.object({ type: z.literal('text'), text: z.string().max(16_384) })]),
})

export function defaultSecretFiles(): SecretFiles {
  // Never infer an allowlist from a returned filename. Custom server homes need
  // an explicit exact directory; mismatches stay phone-only.
  return new SecretFiles(process.env.PI_PHONE_SECRET_FILES_DIR ?? join(homedir(), '.t3', 'userdata', 'secrets', 'files'))
}

/** Bound candidate extraction also permits cleanup of malformed/late replies. */
function replyFiles(raw: unknown): string[] {
  const found = new Set<string>()
  const candidate = (value: unknown) => {
    if (value && typeof value === 'object' && 'file' in value && typeof value.file === 'string' && value.file.length <= 4096) found.add(value.file)
  }
  if (raw && typeof raw === 'object') {
    if ('structuredContent' in raw) candidate(raw.structuredContent)
    if ('content' in raw && Array.isArray(raw.content)) for (const block of raw.content.slice(0, 8)) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.length <= 16_384) {
        try { candidate(JSON.parse(block.text)) } catch { /* Never expose parse errors. */ }
      }
    }
  }
  return [...found]
}

/** Stop local waiting promptly, but retain a handler to clean any late delivery. */
async function wait<T>(pending: Promise<T>, signal: AbortSignal, late: (value: T) => Promise<void>): Promise<T> {
  const aborted = Promise.withResolvers<never>()
  let abandoned = false
  const stop = () => { abandoned = true; aborted.reject(failed()) }
  const tracked = pending.then(async value => {
    if (abandoned || signal.aborted) { await late(value); throw failed() }
    return value
  })
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
  try { return await Promise.race([tracked, aborted.promise]) }
  finally {
    signal.removeEventListener('abort', stop)
    void tracked.catch(() => {})
  }
}

/** T3 0.1.8's connectionId-based bridge, not the SDK's newer MCP carrier. */
class SecretCards {
  private connectionId: string | undefined
  private closing: Promise<void> | undefined
  constructor(private readonly client: acp.AgentContext, private readonly files: SecretFiles, private readonly signal: AbortSignal) {}

  private async disconnect(connectionId: string): Promise<void> {
    await this.client.request('mcp/disconnect', { connectionId }, {
      cancellationSignal: AbortSignal.timeout(2000), stopWaitingOnCancel: true,
    })
  }

  close(): Promise<void> {
    if (!this.closing) this.closing = this.connectionId ? this.disconnect(this.connectionId).catch(() => {}) : Promise.resolve()
    return this.closing
  }

  async open(): Promise<void> {
    const setupSignal = AbortSignal.any([this.signal, AbortSignal.timeout(10_000)])
    const raw = await wait(this.client.request('mcp/connect', { serverId: 't3-code' }), setupSignal, async late => {
      const parsed = connectionSchema.safeParse(late)
      if (parsed.success) await this.disconnect(parsed.data.connectionId).catch(() => {})
    })
    this.connectionId = connectionSchema.parse(raw).connectionId
    const initialized = await wait(this.client.request('mcp/message', {
      connectionId: this.connectionId, method: 'initialize', params: {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pi-phone-acp', version: '0.1.0' },
      },
    }), setupSignal, async () => {})
    z.object({ protocolVersion: z.literal('2025-06-18') }).parse(initialized)
    setupSignal.throwIfAborted()
    await this.client.notify('mcp/message', { connectionId: this.connectionId, method: 'notifications/initialized' })
  }

  async answer(label: string, reason: string, timeoutMs: number): Promise<{ status: 'saved', value: string } | { status: 'declined' | 'cancelled' | 'timed_out' }> {
    this.signal.throwIfAborted()
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(timeoutMs + 2000)])
    const discard = async (raw: unknown) => {
      const results = await Promise.allSettled(replyFiles(raw).map(path => this.files.discard(path)))
      if (results.some(result => result.status === 'rejected')) throw failed()
    }
    const raw = await wait(this.client.request('mcp/message', {
      connectionId: this.connectionId, method: 'tools/call', params: {
        name: 'request_secret', arguments: { label, reason, delivery: 'file', timeoutMs, clientRequestId: `pi-phone-acp:${randomUUID()}` },
      },
    }), signal, discard)
    try {
      const reply = resultSchema.parse(raw)
      const written = deliverySchema.parse(JSON.parse(reply.content[0].text))
      if (JSON.stringify(written) !== JSON.stringify(reply.structuredContent)) throw failed()
      if (reply.structuredContent.status !== 'saved') return { status: reply.structuredContent.status }
      return { status: 'saved', value: await this.files.consume(reply.structuredContent.file, signal) }
    } finally { await discard(raw) }
  }
}

export async function forwardPrivate(
  phone: PhoneBackend, id: string, item: PrivateApproval, client: acp.AgentContext, signal: AbortSignal,
  files: SecretFiles, timeoutMs = 5 * 60_000,
): Promise<'done' | 'phone'> {
  const form = supportedPrivateForm(item.privateForm, item.tool)
  if (!form || !files.supported || !phone.privateFormCurrent || !phone.answerPrivate || !phone.declinePrivate) return 'phone'
  const approval = { ...item, privateForm: form }
  const values: Record<string, string> = Object.create(null) as Record<string, string>
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(20 * 60_000)])
  const cards = new SecretCards(client, files, lifetime)
  const cancel = () => { void cards.close() }
  try {
    lifetime.throwIfAborted()
    if (!await phone.privateFormCurrent(id, approval, lifetime)) return 'phone'
    await cards.open()
    lifetime.addEventListener('abort', cancel, { once: true })
    lifetime.throwIfAborted()
    const destination = form.type === 'secret' ? `Save in phone Settings > Secrets as ${form.name}. ${form.description}`
      : form.type === 'browser' ? `Fill the existing ${form.kind === 'code' ? 'code' : 'sign-in'} fields at ${form.site}. ${form.instruction ?? ''}`
        : `Fill the existing sign-in fields in ${form.app.label} on ${form.machineName}.`
    const fields = privateFields(form)
    for (const [index, field] of fields.entries()) {
      lifetime.throwIfAborted()
      const answer = await cards.answer(`${field.label} (${index + 1}/${fields.length})`,
        `${destination}\nAll ${fields.length} fields are collected privately before one submission to the phone. Decline rejects this phone request without sending values. Cancel or timeout leaves it on the phone. ${form.type === 'secret' ? '' : 'Sign-in values are not saved in phone Secrets. '}T3 removes outer whitespace; use the phone when it matters.`, timeoutMs)
      lifetime.throwIfAborted()
      if (answer.status === 'declined') {
        if (!phone.declinePrivate) return 'phone'
        await phone.declinePrivate(id, approval, lifetime)
        return 'done'
      }
      if (answer.status !== 'saved') return 'phone'
      values[field.name] = privateFieldValue(form, answer.value)
    }
    lifetime.throwIfAborted()
    const checked = privateValues(form, values)
    // answerPrivate rechecks ownership and native request identity before its POST.
    await phone.answerPrivate(id, approval, checked, lifetime)
    return 'done'
  } catch { throw failed() }
  finally {
    lifetime.removeEventListener('abort', cancel)
    await cards.close()
    for (const key of Object.keys(values)) delete values[key]
  }
}

/** Collect the whole extension form privately, including any unmarked companion fields. */
export async function forwardSecretAsk(
  phone: PhoneBackend, id: string, item: SecretAskApproval, client: acp.AgentContext, signal: AbortSignal,
  files: SecretFiles, timeoutMs = 5 * 60_000,
): Promise<'done' | 'phone'> {
  const form = supportedSecretAsk(item.form)
  if (!form || !files.supported || !phone.secretAskCurrent || !phone.answerSecretAsk || !phone.declineSecretAsk) return 'phone'
  const approval = { ...item, form }
  const values: Record<string, string> = Object.create(null) as Record<string, string>
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(20 * 60_000)])
  const cards = new SecretCards(client, files, lifetime)
  const cancel = () => { void cards.close() }
  try {
    lifetime.throwIfAborted()
    if (!await phone.secretAskCurrent(id, approval, lifetime)) return 'phone'
    await cards.open()
    lifetime.addEventListener('abort', cancel, { once: true })
    lifetime.throwIfAborted()
    for (const [index, field] of form.fields.entries()) {
      lifetime.throwIfAborted()
      const answer = await cards.answer(`${field.label} (${index + 1}/${form.fields.length})`,
        [form.title, form.text, field.placeholder && `Hint: ${field.placeholder}`, `Submit action: ${form.submit}`,
          'The requesting extension receives these answers. Its developer determines whether they are saved or returned to the phone model. Private entry does not make that later use private.',
          `All ${form.fields.length} fields are collected before one submission. Required text; 1–4096 characters per field. Decline rejects this phone request without sending values. Cancel or timeout leaves it on the phone. T3 removes outer whitespace; use the phone when it matters.`,
        ].filter(Boolean).join('\n\n'), timeoutMs)
      lifetime.throwIfAborted()
      if (answer.status === 'declined') {
        await phone.declineSecretAsk(id, approval, lifetime)
        return 'done'
      }
      if (answer.status !== 'saved') return 'phone'
      values[field.name] = z.string().min(1).max(4096).parse(answer.value)
    }
    lifetime.throwIfAborted()
    await phone.answerSecretAsk(id, approval, askValues(form, values), lifetime)
    return 'done'
  } catch { throw failed() }
  finally {
    lifetime.removeEventListener('abort', cancel)
    await cards.close()
    for (const key of Object.keys(values)) delete values[key]
  }
}
