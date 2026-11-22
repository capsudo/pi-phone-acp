import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as acp from '@agentclientprotocol/sdk/unstable'
import { HttpPhoneBackend } from '../src/backend.js'
import { PhoneHttp } from '../src/http.js'
import { PhoneFixture } from './fixture.js'
import { createAdapter } from '../src/adapter.js'
import { viewSchema } from '../src/contract.js'
import { askFormSchema, askValues, questionAnswer, supportedInterview, sensitiveInterview, type ResponseItem } from '../src/forms.js'
import type { PhoneBackend, PhoneEvent, InterviewApproval, InterviewAnswer } from '../src/phone.js'
import { SecretFiles } from '../src/secret-files.js'
import { Projection } from '../src/projection.js'
import { literalSource, markdownLabel } from '../src/markdown.js'

const ask = { type: 'ask', title: 'Destination', text: 'Choose the destination name.', submit: 'Send', fields: [{ name: 'destination', label: 'Destination name', placeholder: 'A short name' }] }
const questions = {
  questions: { title: 'Review implementation', description: 'Consider each option.', questions: [
    { id: 'intro', type: 'info', question: 'Read the source before choosing.', content: { source: 'const code = "example"', lang: 'ts', file: 'demo.ts' } },
    { id: 'single', type: 'single', question: 'Select approach', options: ['A', { label: 'B', content: { source: 'return 2', lang: 'ts' } }], recommended: 'B', conviction: 'slight', weight: 'critical' },
    { id: 'multi', type: 'multi', question: 'Select checks', options: ['typecheck', 'tests'] },
    { id: 'text', type: 'text', question: 'Additional feedback?' },
    { id: 'outro', type: 'info', question: 'End of review.' },
  ] }, draft: [], status: 'waiting', createdAt: 123,
}
const interviewForm = { type: 'interview', callId: 'call/1', title: 'Review implementation', count: 3 }
const view = (form: unknown) => viewSchema.parse({ full: true, conversation: { id: 1, cwd: '/phone/work' }, entries: [], live: { busy: true }, inbox: [], approvals: [{ id: 'form/1', conversationId: 1, callId: 'call/1', tool: 'ask', subject: 'Question', reason: 'Phone question', form }] })
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

class FormsPhone implements PhoneBackend {
  readonly answers: unknown[] = []
  readonly ended = Promise.withResolvers<void>()
  readonly started = Promise.withResolvers<void>()
  extra: PhoneEvent[] = []
  wake = Promise.withResolvers<void>()
  failAnswer = false
  getCount = 0
  mutateBeforeSubmit = false
  stops = 0
  sensitiveChecks = 0
  ownerChanged = false
  approvalChanged = false
  source: unknown = structuredClone(questions)
  constructor(readonly form: unknown = ask) {}
  async create() { return { id: '1', history: [] } }
  async load() { return { id: '1', history: [], replay: new Projection().consume(view(this.form)) } }
  async *run(_id: string, _text: string, _request: string, signal: AbortSignal): AsyncGenerator<PhoneEvent> {
    this.started.resolve()
    const projection = new Projection()
    yield* projection.consume(view(this.form))
    yield* projection.consume(view(this.form))
    const abort = () => this.wake.resolve()
    signal.addEventListener('abort', abort, { once: true })
    let done = false
    void this.ended.promise.then(() => { done = true; this.wake.resolve() })
    try {
      while (!done && !signal.aborted) {
        yield* this.extra.splice(0)
        await this.wake.promise
        this.wake = Promise.withResolvers<void>()
      }
      signal.throwIfAborted()
      yield { type: 'end', reason: 'end_turn' }
    } finally { signal.removeEventListener('abort', abort) }
  }
  async cancel() { this.stops++; this.ended.resolve() }
  async answerApproval(id: string, allow: boolean) { this.answers.push({ kind: 'approval', id, allow }); this.ended.resolve() }
  async answerAsk(id: string, values: Record<string, string>) {
    this.answers.push({ kind: 'ask', id, values })
    if (this.failAnswer) throw new Error('DO_NOT_LEAK response-body')
    this.ended.resolve()
  }
  async getInterview() { this.getCount++; return this.mutateBeforeSubmit && this.getCount > 1 ? { ...(this.source as object), createdAt: 456 } : structuredClone(this.source) }
  async answerInterview(id: string, callId: string, answer: { action: 'submit' | 'cancel', draft?: ResponseItem[] }) { this.answers.push({ kind: 'interview', id, callId, ...answer }); this.ended.resolve() }
  async sensitiveInterviewCurrent(_id: string, _approval: InterviewApproval, original: unknown, signal: AbortSignal) {
    signal.throwIfAborted(); this.sensitiveChecks++
    return !this.ownerChanged && !this.approvalChanged && JSON.stringify(await this.getInterview()) === JSON.stringify(original)
  }
  async answerSensitiveInterview(id: string, approval: InterviewApproval, original: unknown, answer: InterviewAnswer, signal: AbortSignal) {
    if (!await this.sensitiveInterviewCurrent(id, approval, original, signal)) throw new Error('DO_NOT_LEAK changed interview')
    signal.throwIfAborted()
    this.answers.push(structuredClone({ kind: 'interview', id, callId: approval.form.callId, ...answer }))
    if (this.failAnswer) throw new Error('DO_NOT_LEAK uncertain interview POST')
    this.ended.resolve()
  }
  withdraw() { this.extra.push({ type: 'approval_withdrawn', id: 'form/1' }); this.wake.resolve() }
}
const workspace = { cwd: '/t3/project', mcpServers: [] }
interface PrivateInterviewOptions {
  backend?: PhoneBackend
  files: SecretFiles
  server?: boolean
  respond: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>
}

async function harness(phone: FormsPhone, responses: (params: acp.CreateElicitationRequest, signal: AbortSignal) => unknown | Promise<unknown>, support = true, notices = false, privateInput?: PrivateInterviewOptions) {
  const requests: acp.CreateElicitationRequest[] = []
  const updates: acp.SessionNotification[] = []
  const client = acp.client()
    .onRequest(acp.methods.client.elicitation.create, async ({ params, signal }) => {
      requests.push(params)
      // Match installed T3: every rendered property needs an answer, and property
      // descriptions replace the common message. This catches fictional optional UI.
      return await responses(params, signal) as acp.CreateElicitationResponse
    })
    .onRequest(acp.methods.client.session.requestPermission, () => { assert.fail('Interactive questions must not use permission buttons') })
    .onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params) })
    .onNotification('*', () => {})
    .onRequest('*', async ({ method, params }) => {
      assert.ok(privateInput, 'Unexpected private helper request')
      return await privateInput.respond(method, params as Record<string, unknown>)
    })
  const connection = client.connect(createAdapter(privateInput?.backend ?? phone, privateInput ? { secretFiles: privateInput.files, secretTimeoutMs: 1000 } : {}))
  const agent = connection.agent
  await agent.request(acp.methods.agent.initialize, { protocolVersion: 2, clientCapabilities: {
    ...(support ? { elicitation: { form: {} } } : {}),
    ...(notices ? { session: { notices: {} } } : {}),
  } })
  const { sessionId } = await agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, { ...workspace, mcpServers: privateInput && privateInput.server !== false ? [{ type: 'acp', name: 't3-code', serverId: 't3-code' }] : [] })
  const result = agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'ask' }] })
  return { connection, agent, result, requests, updates }
}
async function settleFallback(h: Awaited<ReturnType<typeof harness>>, phone: FormsPhone) {
  for (let i = 0; i < 30 && h.updates.length === 0; i++) await tick()
  assert.ok(h.updates.length, 'Expected a phone-only notice')
  phone.ended.resolve()
  await h.result
}
function queued(values: unknown[]) {
  return (params: acp.CreateElicitationRequest) => {
    assert.equal(params.mode, 'form')
    assert.ok('sessionId' in params && 'toolCallId' in params && 'requestedSchema' in params)
    assert.equal(params.sessionId, '1')
    assert.equal(params.toolCallId, 'call/1')
    const content = values.shift()
    assert.ok(content !== undefined, 'Unexpected additional question')
    const schema = params.requestedSchema as { properties: Record<string, { description?: string }>, required: string[] }
    for (const key of Object.keys(schema.properties)) assert.ok(Object.hasOwn(content as object, key), `T3 UI cannot skip rendered ${key}`)
    return { action: 'accept', content }
  }
}

test('ordinary source-shaped asks return named values once, preserving common context in every field', async () => {
  const phone = new FormsPhone({ ...ask, fields: [...ask.fields, { name: 'region', label: 'Region' }] })
  const h = await harness(phone, params => {
    assert.ok('requestedSchema' in params)
    const schema = params.requestedSchema as { properties: Record<string, { description: string }> }
    for (const p of Object.values(schema.properties)) assert.match(p.description, /Choose the destination name/)
    return { action: 'accept', content: { destination: 'demo', region: 'EU' } }
  })
  try {
    await h.result
    assert.equal(h.requests.length, 1)
    assert.deepEqual(phone.answers, [{ kind: 'ask', id: 'form/1', values: { destination: 'demo', region: 'EU' } }])
    assert.doesNotMatch(JSON.stringify(h.updates), /demo/)
  } finally { h.connection.close() }
})

for (const action of ['decline', 'cancel']) test(`ask ${action} is not coerced to acceptance`, async () => {
  const phone = new FormsPhone()
  const h = await harness(phone, () => ({ action }))
  try {
    if (action === 'cancel') await settleFallback(h, phone)
    else await h.result
    assert.deepEqual(phone.answers, action === 'decline' ? [{ kind: 'approval', id: 'form/1', allow: false }] : [])
    assert.equal(phone.stops, 0)
  } finally { h.connection.close() }
})

for (const content of [{}, { destination: '' }, { destination: 12 }, { destination: 'x', unexpected: 'DO_NOT_LEAK' }, { destination: 'x'.repeat(4097) }]) test(`rejects malformed ask content without echo or phone answer (${JSON.stringify(content).slice(0, 40)})`, async () => {
  const phone = new FormsPhone()
  const h = await harness(phone, () => ({ action: 'accept', content }))
  try {
    await settleFallback(h, phone)
    assert.deepEqual(phone.answers, [])
    assert.doesNotMatch(JSON.stringify(h.updates), /DO_NOT_LEAK|ZodError/)
  } finally { h.connection.close() }
})

test('unknown action and nested legacy responses never become answers', async () => {
  for (const response of [{ action: 'future' }, { action: { action: 'accept', content: { destination: 'x' } } }]) {
    const phone = new FormsPhone()
    const h = await harness(phone, () => response)
    try { await settleFallback(h, phone); assert.deepEqual(phone.answers, []) } finally { h.connection.close() }
  }
})

test('clients without form capability get a notice, not a request or answer', async () => {
  const phone = new FormsPhone()
  const h = await harness(phone, () => { assert.fail('Client has no form capability') }, false)
  try { await settleFallback(h, phone); assert.equal(h.requests.length, 0); assert.deepEqual(phone.answers, []) } finally { h.connection.close() }
})

test('notice-capable clients without form support get an actionable notice without an input request', async () => {
  const phone = new FormsPhone()
  const h = await harness(phone, () => { assert.fail('Client has no form capability') }, false, true)
  try {
    await settleFallback(h, phone)
    assert.deepEqual(h.updates.map(item => item.update.sessionUpdate), ['notice'])
    assert.equal(h.updates[0]!.update.sessionUpdate === 'notice' && h.updates[0]!.update.title, 'Complete this request in pi-phone')
    assert.equal(h.requests.length, 0)
    assert.deepEqual(phone.answers, [])
    assert.equal(phone.stops, 0)
  } finally { h.connection.close() }
})

test('notice capability leaves supported ordinary forms and their answers unchanged', async () => {
  const phone = new FormsPhone()
  const h = await harness(phone, queued([{ destination: 'demo' }]), true, true)
  try {
    await h.result
    assert.equal(h.requests.length, 1)
    assert.deepEqual(phone.answers, [{ kind: 'ask', id: 'form/1', values: { destination: 'demo' } }])
    assert.equal(h.updates.length, 0)
  } finally { h.connection.close() }
})

test('notice capability leaves supported interviews and their explicit submission unchanged', async () => {
  const phone = new FormsPhone({ ...interviewForm, count: 1 })
  phone.source = { questions: { questions: [{ id: 'text', type: 'text', question: 'Feedback?' }] }, draft: [], status: 'waiting', createdAt: 123 }
  const replies = [{ route: 'answer' }, { value: 'source-ok' }, { submit: true }]
  const h = await harness(phone, queued(replies), true, true)
  try {
    await h.result
    assert.equal(replies.length, 0)
    assert.equal(h.requests.length, 3)
    assert.deepEqual(phone.answers, [{ kind: 'interview', id: '1', callId: 'call/1', action: 'submit', draft: [{ id: 'text', value: 'source-ok' }] }])
    assert.equal(h.updates.length, 0)
  } finally { h.connection.close() }
})

test('unsupported rich interview emits one standalone notice while pending and preserves phone completion', async () => {
  const phone = new FormsPhone({ ...interviewForm, count: 1, title: 'Rich content fallback test' })
  phone.source = { questions: { title: 'Rich content fallback test', questions: [
    { id: 'fallback_check', type: 'text', question: 'Answer on the phone.', content: { source: '![DO_NOT_LEAK](https://example.invalid/demo.png)', lang: 'md', showSource: false } },
  ] }, draft: [], status: 'waiting', createdAt: 123 }
  const h = await harness(phone, () => { assert.fail('Unsupported content must not create an incomplete form or acknowledgement card') }, true, true)
  let finished = false
  void h.result.then(() => { finished = true }, () => { finished = true })
  try {
    for (let i = 0; i < 30 && h.updates.length === 0; i++) await tick()
    assert.equal(finished, false, 'Phone input is still pending when the notice arrives')
    assert.equal(h.updates.length, 1, 'Repeated observations must not duplicate the notice')
    const update = h.updates[0]!.update
    assert.equal(update.sessionUpdate, 'notice')
    if (update.sessionUpdate !== 'notice') assert.fail('Expected a standalone ACP notice')
    assert.equal(update.title, 'Complete this interview in pi-phone')
    assert.equal(update.severity, 'info')
    assert.match(update.description!, /phone-only media, Markdown rendering/)
    assert.match(update.description!, /Complete it in pi-phone/)
    assert.doesNotMatch(JSON.stringify(h.updates), /DO_NOT_LEAK|example.invalid/)
    assert.equal(phone.getCount, 1)
    assert.deepEqual(phone.answers, [])
    assert.equal(h.requests.length, 0)

    phone.extra.push(
      { type: 'approval_withdrawn', id: 'form/1' },
      { type: 'tool', id: 'call/1', name: 'interview', status: 'completed', output: 'fallback_check: phone-ok' },
      { type: 'text', text: 'fallback_check: phone-ok' },
    )
    phone.wake.resolve()
    for (let i = 0; i < 30 && !h.updates.some(item => item.update.sessionUpdate === 'agent_message_chunk'); i++) await tick()
    assert.ok(h.updates.some(item => item.update.sessionUpdate === 'agent_message_chunk' && item.update.content.type === 'text' && item.update.content.text === 'fallback_check: phone-ok'))
    phone.ended.resolve()
    assert.equal((await h.result).stopReason, 'end_turn')
    assert.equal(h.updates.filter(item => item.update.sessionUpdate === 'notice').length, 1)
    assert.deepEqual(phone.answers, [], 'The adapter must not submit an answer or decline for the phone')
    assert.equal(phone.stops, 0)
  } finally { h.connection.close() }
})

test('mixed sensitive asks, OTP autocomplete and unknown fields stay entirely phone-only', async () => {
  for (const form of [
    { ...ask, fields: [...ask.fields, { name: 'private', label: 'Private', secret: true, placeholder: 'DO_NOT_LEAK' }] },
    { ...ask, fields: [{ name: 'value', label: 'Value', autocomplete: 'one-time-code' }] },
    { ...ask, fields: [{ name: 'password', label: 'Account password' }] },
    { ...ask, fields: [{ name: 'value', label: 'Value', newFlag: 'DO_NOT_LEAK' }] },
    { type: 'secret', name: 'DO_NOT_LEAK', description: 'Private' },
    { type: 'browser', kind: 'code', fields: [{ name: 'code' }] },
  ]) {
    const phone = new FormsPhone(form)
    const h = await harness(phone, () => { assert.fail('Sensitive/unknown form was forwarded') })
    try { await settleFallback(h, phone); assert.deepEqual(phone.answers, []); assert.doesNotMatch(JSON.stringify(h.updates) + JSON.stringify(h.requests), /DO_NOT_LEAK/) } finally { h.connection.close() }
  }
})

test('the collection boundary refuses sensitive, mixed and unknown forms even without Projection', async () => {
  class UnprojectedPhone extends FormsPhone {
    override async *run(): AsyncGenerator<PhoneEvent> {
      // Exercise another backend supplying a raw normalized event, not Projection's guard.
      yield { type: 'approval', id: 'form/1', callId: 'call/1', tool: 'ask', subject: 'Question', reason: 'Phone question',
        interactive: true, form: this.form as NonNullable<Extract<PhoneEvent, { type: 'approval' }>['form']> }
      await this.ended.promise
      yield { type: 'end', reason: 'end_turn' }
    }
  }
  const privateFields = [
    { name: 'private', label: 'Private', secret: true, placeholder: 'DO_NOT_LEAK' },
    { name: 'password', label: 'Account password' },
    { name: 'value', label: 'Value', autocomplete: 'one-time-code' },
    { name: 'code', label: 'Code' },
    { name: 'value', label: 'Enter your recovery code' },
  ]
  for (const form of [
    ...privateFields.map(field => ({ ...ask, fields: [...ask.fields, field] })),
    { ...ask, title: 'Sign-in password', fields: ask.fields },
    { ...ask, fields: [...ask.fields, { name: 'unknown', label: 'Unknown', private: true, value: 'DO_NOT_LEAK' }] },
    { ...ask, fields: null },
    { type: 'secret', name: 'DO_NOT_LEAK', description: 'Private' },
    { type: 'browser', kind: 'code', fields: [{ name: 'code' }] },
    { type: 'computer-sign-in', fields: [{ name: 'password' }] },
    { type: 'crd-connect', machine: 'demo' },
    { ...interviewForm, callId: '' },
    { ...interviewForm, private: true, value: 'DO_NOT_LEAK' },
  ]) {
    const phone = new UnprojectedPhone(form)
    const h = await harness(phone, () => { assert.fail('Unverified collection path was opened') })
    try {
      await settleFallback(h, phone)
      assert.equal(h.requests.length, 0)
      assert.equal(phone.getCount, 0)
      assert.deepEqual(phone.answers, [])
      assert.equal(phone.stops, 0)
      assert.doesNotMatch(JSON.stringify(h.updates), /DO_NOT_LEAK/)
    } finally { h.connection.close() }
  }
})

test('mixed ordinary and sensitive interviews require checked phone submission before any collection', async () => {
  for (const question of ['Enter your password', 'Enter the verification code', 'Enter your API key']) {
    const phone = new FormsPhone({ ...interviewForm, count: 2 })
    Object.defineProperty(phone, 'answerSensitiveInterview', { value: undefined })
    phone.source = { questions: { questions: [
      { id: 'ordinary', type: 'text', question: 'An ordinary question first.' },
      { id: 'private', type: 'text', question },
    ] }, draft: [], status: 'waiting', createdAt: 1 }
    const h = await harness(phone, () => { assert.fail('Mixed private interview was partially collected') })
    try {
      await settleFallback(h, phone)
      assert.equal(h.requests.length, 0)
      assert.equal(phone.getCount, 1)
      assert.deepEqual(phone.answers, [])
      assert.equal(phone.stops, 0)
      assert.match(JSON.stringify(h.updates), /supported collection or owner-checked phone submission is unavailable/)
      assert.match(JSON.stringify(h.updates), /Complete it in pi-phone/)
    } finally { h.connection.close() }
  }
})

test('zero-field asks require explicit completion instead of an empty auto-accept form', async () => {
  const phone = new FormsPhone({ ...ask, fields: [], submit: 'Done' })
  const h = await harness(phone, queued([{ complete: true }]))
  try { await h.result; assert.deepEqual(phone.answers, [{ kind: 'ask', id: 'form/1', values: {} }]) } finally { h.connection.close() }
})

test('text/code interviews round-trip single/multi/Other/notes/skip and explicit final completion', async () => {
  const phone = new FormsPhone(interviewForm)
  const replies = [{ route: 'options' }, { value: 'B' }, { addNote: true }, { note: 'Clearer' }, { route: 'options' }, { value: ['tests', 'typecheck'] }, { addNote: false }, { addNote: false }, { route: 'skip' }, { submit: true }]
  const h = await harness(phone, queued(replies))
  try {
    await h.result
    assert.equal(replies.length, 0)
    assert.match(h.requests[0]!.message, /const code = "example"/)
    assert.match(h.requests[0]!.message, /return 2/)
    assert.match(h.requests[0]!.message, /Recommended: "B" \(slight\)/)
    assert.match(h.requests.at(-1)!.message, /End of review/)
    assert.deepEqual(phone.answers, [{ kind: 'interview', id: '1', callId: 'call/1', action: 'submit', draft: [
      { id: 'single', value: { option: 'B', note: 'Clearer' } }, { id: 'multi', value: [{ option: 'tests' }, { option: 'typecheck' }] },
    ] }])
    assert.equal(phone.getCount, 2)
  } finally { h.connection.close() }
})

test('Other and text answers retain native question IDs', async () => {
  const phone = new FormsPhone(interviewForm)
  const h = await harness(phone, queued([{ route: 'other' }, { value: 'C' }, { route: 'skip' }, { route: 'answer' }, { value: 'Feedback' }, { submit: true }]))
  try {
    await h.result
    assert.deepEqual((phone.answers[0] as { draft: unknown }).draft, [{ id: 'single', value: { option: 'C' } }, { id: 'text', value: 'Feedback' }])
  } finally { h.connection.close() }
})

for (const action of ['decline', 'cancel']) test(`interview ${action} preserves phone ownership and saved prefills`, async () => {
  const phone = new FormsPhone(interviewForm)
  const h = await harness(phone, () => ({ action }))
  try {
    if (action === 'cancel') await settleFallback(h, phone)
    else await h.result
    assert.deepEqual(phone.answers, action === 'decline' ? [{ kind: 'interview', id: '1', callId: 'call/1', action: 'cancel' }] : [])
  } finally { h.connection.close() }
})

test('unsupported rich content, images, saved drafts and helpers are not partially forwarded', async () => {
  const cases = [
    { ...questions, questions: { questions: [{ id: 'photo', type: 'image', question: 'Photo?' }] } },
    { ...questions, questions: { questions: [{ id: 'x', type: 'text', question: 'Answer?', media: { type: 'html', html: '<b>DO_NOT_LEAK</b>' } }] } },
    { ...questions, draft: [{ id: 'text', value: 'DO_NOT_LEAK' }] },
    { ...questions, asked: { x: [{ q: 'DO_NOT_LEAK' }] } },
    { ...questions, status: 'timeout' },
  ]
  for (const source of cases) {
    const phone = new FormsPhone(interviewForm); phone.source = source
    const h = await harness(phone, () => { assert.fail('Unsupported interview was partially forwarded') })
    try { await settleFallback(h, phone); assert.deepEqual(phone.answers, []); assert.doesNotMatch(JSON.stringify(h.updates) + JSON.stringify(h.requests), /DO_NOT_LEAK/) } finally { h.connection.close() }
  }
})

test('observed phone edits invalidate an interview before submission', async () => {
  const phone = new FormsPhone(interviewForm); phone.mutateBeforeSubmit = true
  const h = await harness(phone, queued([{ route: 'skip' }, { route: 'skip' }, { route: 'skip' }, { submit: true }]))
  try { await settleFallback(h, phone); assert.deepEqual(phone.answers, []) } finally { h.connection.close() }
})

test('an uncertain answer POST is attempted once, never echoed or retried', async () => {
  const phone = new FormsPhone(); phone.failAnswer = true
  const h = await harness(phone, () => ({ action: 'accept', content: { destination: 'demo' } }))
  try {
    await settleFallback(h, phone)
    assert.equal(phone.answers.length, 1)
    assert.equal(h.requests.length, 1)
    assert.doesNotMatch(JSON.stringify(h.updates), /DO_NOT_LEAK|response-body/)
  } finally { h.connection.close() }
})

for (const action of ['disconnect', 'withdraw', 'cancel']) test(`${action} releases pending form without inventing an answer`, async () => {
  const phone = new FormsPhone()
  const asked = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const h = await harness(phone, async (_params, signal) => {
    asked.resolve()
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    released.resolve()
    return { action: 'accept', content: { destination: 'late' } }
  })
  try {
    const rejection = action === 'disconnect' ? assert.rejects(h.result) : undefined
    await asked.promise
    if (action === 'disconnect') { h.connection.close(); await rejection }
    else if (action === 'withdraw') phone.withdraw()
    else await h.agent.notify(acp.methods.agent.session.cancel, { sessionId: '1' })
    await released.promise
    phone.ended.resolve()
    if (action !== 'disconnect') await h.result
    await tick()
    assert.deepEqual(phone.answers, [])
    assert.equal(phone.stops, action === 'cancel' ? 1 : 0)
  } finally { h.connection.close() }
})

test('validators reject duplicate IDs, options, malformed kinds and invalid native answers', () => {
  const parsed = askFormSchema.parse(ask)
  assert.throws(() => askValues(parsed, { destination: 'x', extra: 'x' }))
  const q = { id: 'q', type: 'multi' as const, question: 'Choose', options: ['A', 'B'] }
  for (const raw of [{ value: ['A', 'A'] }, { value: ['C'] }, { value: ['A'], note_1: 'Wrong selection' }, { value: 3 }]) assert.throws(() => questionAnswer(q, raw))
  assert.throws(() => supportedInterview({ ...questions, questions: { questions: [q, q] } }, 2))
})

test('reconnect replay is observation-only when T3 has no active form turn', async () => {
  const phone = new FormsPhone()
  let requests = 0
  const updates: acp.SessionNotification[] = []
  const client = acp.client().onRequest(acp.methods.client.elicitation.create, () => { requests++; return { action: 'decline' } })
    .onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params) })
  const connection = client.connect(createAdapter(phone))
  try {
    await connection.agent.request(acp.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } })
    await connection.agent.request(acp.methods.agent.session.load, { ...workspace, sessionId: '1' })
    assert.equal(requests, 0)
    assert.deepEqual(phone.answers, [])
    assert.match(JSON.stringify(updates), /active prompt turn/)
  } finally { connection.close() }
})

for (const completion of ['answer', 'cancel', 'withdraw']) test(`async phone forms keep the ACP turn open until ${completion} without restarting phone work`, async () => {
  class AsyncPhone extends FormsPhone {
    readonly observed = Promise.withResolvers<void>()
    override async *run(): AsyncGenerator<PhoneEvent> {
      yield* new Projection().consume(view(this.form))
      yield { type: 'end', reason: 'end_turn' }
    }
    async *observe(_id: string, signal: AbortSignal): AsyncGenerator<PhoneEvent> {
      this.observed.resolve()
      const abort = () => this.wake.resolve()
      signal.addEventListener('abort', abort, { once: true })
      try {
        while (!signal.aborted) {
          yield* this.extra.splice(0)
          await this.wake.promise
          this.wake = Promise.withResolvers<void>()
        }
      } finally { signal.removeEventListener('abort', abort) }
    }
  }
  const phone = new AsyncPhone()
  const asked = Promise.withResolvers<void>()
  const answer = Promise.withResolvers<acp.CreateElicitationResponse>()
  const h = await harness(phone, async (_params, signal) => {
    asked.resolve()
    const cancelled = new Promise<acp.CreateElicitationResponse>(resolve => signal.addEventListener('abort', () => resolve({ action: 'cancel' }), { once: true }))
    return Promise.race([answer.promise, cancelled])
  })
  let finished = false
  void h.result.then(() => { finished = true })
  try {
    await asked.promise
    await tick()
    assert.equal(finished, false)
    if (completion === 'answer') answer.resolve({ action: 'accept', content: { destination: 'demo' } })
    else if (completion === 'withdraw') phone.withdraw()
    else await h.agent.notify(acp.methods.agent.session.cancel, { sessionId: '1' })
    const result = await h.result
    assert.deepEqual(result, { stopReason: completion === 'cancel' ? 'cancelled' : 'end_turn' })
    assert.equal(phone.answers.length, completion === 'answer' ? 1 : 0)
    assert.equal(phone.stops, 0)
  } finally { h.connection.close() }
})

test('invalid interview choice is rejected before any note question or native answer', async () => {
  const phone = new FormsPhone(interviewForm)
  const responses = [{ route: 'options' }, { value: 'NOT_AN_OPTION' }]
  const h = await harness(phone, queued(responses))
  try {
    await settleFallback(h, phone)
    assert.equal(h.requests.length, 2)
    assert.deepEqual(phone.answers, [])
  } finally { h.connection.close() }
})

test('strong recommendations are shown but never silently submitted as answers', async () => {
  const phone = new FormsPhone({ ...interviewForm, count: 1 })
  phone.source = { questions: { questions: [{ id: 'q', type: 'single', question: 'Choose', options: ['A', 'B'], recommended: 'B', conviction: 'strong' }] }, draft: [{ id: 'q', value: { option: 'B' } }], status: 'waiting', createdAt: 1 }
  const h = await harness(phone, queued([{ route: 'skip' }, { submit: true }]))
  try { await h.result; assert.deepEqual((phone.answers[0] as { draft: unknown }).draft, []); assert.match(h.requests[0]!.message, /Not selected automatically/) } finally { h.connection.close() }
})

test('declining after local answers cancels without replacing the phone draft', async () => {
  const phone = new FormsPhone(interviewForm)
  const answers = [{ action: 'accept', content: { route: 'other' } }, { action: 'accept', content: { value: 'local-only' } }, { action: 'decline' }]
  const h = await harness(phone, () => answers.shift())
  try { await h.result; assert.deepEqual(phone.answers, [{ kind: 'interview', id: '1', callId: 'call/1', action: 'cancel' }]); assert.doesNotMatch(JSON.stringify(h.updates), /local-only/) } finally { h.connection.close() }
})

test('false final confirmation does not complete an interview', async () => {
  const phone = new FormsPhone(interviewForm)
  const h = await harness(phone, queued([{ route: 'skip' }, { route: 'skip' }, { route: 'skip' }, { submit: false }]))
  try { await settleFallback(h, phone); assert.deepEqual(phone.answers, []) } finally { h.connection.close() }
})

test('portable Markdown and code with password identifiers are context, not secret-entry questions', () => {
  const source = { questions: { questions: [{ id: 'review', type: 'text', question: 'Review this implementation', content: { source: 'const password = "example-only";\n```\n<img src="example">', lang: 'html' } }, { id: 'info', type: 'info', question: 'Context', content: { source: '**Portable** markdown with `code`.', lang: 'md' } }] }, draft: [], status: 'waiting', createdAt: 1 }
  assert.equal(supportedInterview(source, 1).questions.questions.length, 2)
})

test('unknown top-level interview sensitivity markers fail closed before opening any form', async () => {
  const phone = new FormsPhone(interviewForm)
  phone.source = { ...questions, private: true, secretValue: 'DO_NOT_LEAK' }
  const h = await harness(phone, () => { assert.fail('Unknown interview fields were ignored') })
  try { await settleFallback(h, phone); assert.equal(h.requests.length, 0); assert.deepEqual(phone.answers, []); assert.doesNotMatch(JSON.stringify(h.updates), /DO_NOT_LEAK/) } finally { h.connection.close() }
})

test('a client that advertises but rejects elicitation never causes a phone answer or retry', async () => {
  const phone = new FormsPhone()
  const h = await harness(phone, () => { throw new acp.RequestError(-32601, 'DO_NOT_LEAK') })
  try { await settleFallback(h, phone); assert.equal(h.requests.length, 1); assert.deepEqual(phone.answers, []); assert.doesNotMatch(JSON.stringify(h.updates), /DO_NOT_LEAK/) } finally { h.connection.close() }
})

test('rich context survives route, choice and note steps with exact native IDs and explicit submission', async () => {
  const phone = new FormsPhone({ ...interviewForm, count: 1 })
  const source = 'const password = "dummy-only";\n`````\n<img src="local">'
  const literalMarkdown = '![literal example](local.png)\n~~~mermaid\ngraph LR; A-->B\n~~~'
  const title = 'Rich **literal title** <example>'
  phone.source = { questions: { title, description: '**Review** without running anything.', questions: [
    { id: 'intro', type: 'info', question: 'Intro context.', content: { title: 'Source example', file: 'demo.ts', lang: 'ts', source } },
    { id: 'native/review.1', type: 'single', question: 'Compare **both** approaches.', context: '[Public reference](https://example.invalid/reference)',
      content: { source: literalMarkdown, lang: 'md', showSource: true }, options: [
        { label: 'First', content: { source: '**Portable** option details.', lang: 'markdown' } },
        { label: 'Second_[literal]', recommended: true, conviction: 'slight', content: { source: 'return 2', lang: 'ts' } },
      ], recommended: 'Second_[literal]', conviction: 'slight', weight: 'critical' },
    { id: 'outro', type: 'info', question: 'Final context.', content: { source: '| Check | Result |\n| --- | --- |\n| demo | ready |', lang: 'md' } },
  ] }, draft: [], status: 'waiting', createdAt: 1 }
  const replies = [{ route: 'options' }, { value: 'Second_[literal]' }, { addNote: true }, { note: 'demo-note' }, { submit: true }]
  const respond = queued(replies)
  const h = await harness(phone, params => {
    if (!params.message.includes('Review answers (unlisted')) {
      for (const block of [markdownLabel(title), '**Review** without running anything.', 'Intro context.', literalSource(source),
        literalSource(literalMarkdown), '**Portable** option details.', literalSource('return 2'), 'Weight: critical']) {
        assert.ok(params.message.includes(block), `Missing rich context: ${block}`)
      }
    } else {
      assert.match(params.message, /Final context/)
      assert.match(params.message, /\| demo \| ready \|/)
    }
    assert.deepEqual(phone.answers, [], 'No answer is sent before final confirmation')
    return respond(params)
  })
  try {
    await h.result
    assert.equal(replies.length, 0)
    assert.equal(h.requests.length, 5)
    assert.deepEqual(phone.answers, [{ kind: 'interview', id: '1', callId: 'call/1', action: 'submit', draft: [
      { id: 'native/review.1', value: { option: 'Second_[literal]', note: 'demo-note' } },
    ] }])
    assert.equal(phone.getCount, 2)
    assert.doesNotMatch(JSON.stringify(h.updates), /demo-note/)
    assert.equal(phone.stops, 0)
  } finally { h.connection.close() }
})

test('unsupported rich content anywhere refuses the whole interview before any local form', async () => {
  const unsupported = [
    { description: '<details>DO_NOT_LEAK</details>' },
    { question: '~~~mermaid\nDO_NOT_LEAK\n~~~' },
    { context: '```html\nDO_NOT_LEAK\n```' },
    { question: '![DO_NOT_LEAK][picture]', context: '[picture]: local.png' },
    { content: { source: '> ![DO_NOT_LEAK](local.png)', lang: 'md' } },
    { content: { source: 'DO_NOT_LEAK', lang: 'ts', lines: '1-2' } },
    { options: [{ label: 'A', content: { source: '[DO_NOT_LEAK](file:///phone/file)', lang: 'markdown' } }] },
    { media: { type: 'table', table: { headers: ['DO_NOT_LEAK'], rows: [] } } },
  ]
  for (const { description, ...change } of unsupported) {
    const phone = new FormsPhone({ ...interviewForm, count: 2 })
    phone.source = { questions: { ...(description ? { description } : {}), questions: [
      { id: 'first', type: 'text', question: 'An otherwise supported question.' },
      { id: 'last', type: 'single', question: 'Review?', options: ['A'], ...change },
    ] }, draft: [], status: 'waiting', createdAt: 1 }
    const h = await harness(phone, () => { assert.fail('Partially forwarded unsupported rich interview') })
    try {
      await settleFallback(h, phone)
      assert.equal(h.requests.length, 0)
      assert.deepEqual(phone.answers, [])
      assert.equal(phone.stops, 0)
      assert.match(JSON.stringify(h.updates), /phone-only media, Markdown rendering|unsupported or malformed questions, fields or rich content/)
      assert.doesNotMatch(JSON.stringify(h.updates), /DO_NOT_LEAK/)
    } finally { h.connection.close() }
  }
})

const credentialSource = {
  questions: { title: 'Account details', questions: [
    { id: 'name', type: 'text', question: 'Demo name?' },
    { id: 'credential', type: 'text', question: 'Enter the verification code.' },
  ] }, draft: [], status: 'waiting', createdAt: 123,
}
function credentialPhone(source: unknown = credentialSource, count = 2) {
  const phone = new FormsPhone({ ...interviewForm, count })
  phone.source = structuredClone(source)
  return phone
}
async function sensitiveHarness(
  phone: FormsPhone, controls: Parameters<typeof harness>[1],
  answers: (index: number, save: (value: string) => Promise<unknown>) => unknown | Promise<unknown>,
  options: { backend?: PhoneBackend, server?: boolean, directory?: string, support?: boolean, version?: string } = {},
) {
  const base = await mkdtemp(join(tmpdir(), 'interview-private-'))
  const directory = join(base, 'files')
  await mkdir(directory, { mode: 0o700 })
  const privateRequests: { method: string, params: Record<string, unknown> }[] = []
  let cards = 0, disconnects = 0
  const save = async (value: string) => {
    const file = join(directory, randomBytes(16).toString('hex'))
    await writeFile(file, value, { mode: 0o600, flag: 'wx' })
    const result = { status: 'saved', file }
    return { isError: false, structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }
  }
  const h = await harness(phone, controls, options.support ?? true, true, {
    files: new SecretFiles(options.directory ?? directory), server: options.server ?? true,
    ...(options.backend ? { backend: options.backend } : {}),
    respond: async (method, params) => {
      privateRequests.push({ method, params })
      assert.equal(Object.hasOwn(params, 'sessionId'), false)
      if (method === 'mcp/connect') return { connectionId: 'interview-private' }
      if (method === 'mcp/disconnect') { disconnects++; return {} }
      assert.equal(method, 'mcp/message')
      if (params.method === 'initialize') return { protocolVersion: options.version ?? '2025-06-18', capabilities: {}, serverInfo: { name: 'Offline', version: '0' } }
      assert.equal(params.method, 'tools/call')
      const call = params.params as { name: string, arguments: Record<string, unknown> }
      assert.equal(call.name, 'request_secret')
      assert.equal(call.arguments.delivery, 'file')
      assert.ok(typeof call.arguments.label === 'string' && call.arguments.label.trim().length > 0)
      assert.equal(Object.hasOwn(call.arguments, 'value'), false)
      assert.match(String(call.arguments.reason), /saved in pi-phone and returned to the phone model/)
      return answers(cards++, save)
    },
  })
  void h.result.catch(() => {})
  return { ...h, directory, privateRequests, save, cards: () => cards, disconnects: () => disconnects,
    close: async () => { h.connection.close(); await rm(base, { recursive: true, force: true }) } }
}
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  assert.fail('Sensitive interview did not settle')
}

test('credential interviews privately collect text, Other and choice notes while preserving rich context, choices, skips and explicit final submission', async () => {
  const source = { questions: { title: 'Account details', description: '**Dummy-only** interview.', questions: [
    { id: 'intro', type: 'info', question: 'Review first.', content: { source: 'const example = "code"', lang: 'ts' } },
    ...credentialSource.questions.questions,
    { id: 'checks', type: 'multi', question: 'Choose checks.', options: ['Build', { label: 'Tests', content: { source: '**Test context**', lang: 'md' } }] },
    { id: 'other', type: 'single', question: 'Choose region.', options: ['A', 'B'] },
    { id: 'skip', type: 'text', question: 'Optional comment?' },
    { id: 'outro', type: 'info', question: 'End of review.' },
  ] }, draft: [], status: 'waiting', createdAt: 123 }
  const phone = credentialPhone(source, 5)
  const controls = [{ route: 'answer' }, { route: 'answer' }, { route: 'options' }, { value: ['Build', 'Tests'] }, { addNote: true }, { addNote: false }, { route: 'other' }, { route: 'skip' }, { submit: true }]
  const values = ['CANARY_name', '001234', 'CANARY_note', 'CANARY_other']
  const respond = queued(controls)
  const h = await sensitiveHarness(phone, params => {
    assert.deepEqual(phone.answers, [])
    if (!params.message.includes('Review answers')) {
      assert.match(params.message, /Dummy-only/)
      if (params.message.includes('Choose checks')) assert.match(params.message, /Test context/)
    }
    return respond(params)
  }, async (index, save) => {
    assert.deepEqual(phone.answers, [])
    assert.deepEqual(await readdir(h.directory), [])
    return save(values[index]!)
  })
  try {
    await h.result
    assert.equal(controls.length, 0)
    assert.equal(h.cards(), 4)
    assert.equal(h.disconnects(), 1)
    assert.equal(phone.sensitiveChecks, 2)
    assert.equal(phone.getCount, 3)
    assert.deepEqual(phone.answers, [{ kind: 'interview', id: '1', callId: 'call/1', action: 'submit', draft: [
      { id: 'name', value: 'CANARY_name' }, { id: 'credential', value: '001234' },
      { id: 'checks', value: [{ option: 'Build', note: 'CANARY_note' }, { option: 'Tests' }] }, { id: 'other', value: { option: 'CANARY_other' } },
    ] }])
    assert.match(h.requests.at(-1)!.message, /Answer entered/)
    assert.match(h.requests.at(-1)!.message, /End of review/)
    assert.deepEqual(await readdir(h.directory), [])
    assert.doesNotMatch(JSON.stringify(h.requests) + JSON.stringify(h.privateRequests) + JSON.stringify(h.updates), /CANARY_|001234/)
  } finally { await h.close() }
})

for (const status of ['declined', 'cancelled', 'timed_out']) test(`credential interview ${status} after partial collection sends no partial draft`, async () => {
  const phone = credentialPhone()
  const h = await sensitiveHarness(phone, queued([{ route: 'answer' }, { route: 'answer' }]), (index, save) => index === 0 ? save('CANARY_partial') : {
    isError: false, structuredContent: { status }, content: [{ type: 'text', text: JSON.stringify({ status }) }],
  })
  try {
    if (status === 'declined') await h.result
    else { await until(() => h.updates.length > 0); await settleFallback(h, phone) }
    assert.deepEqual(phone.answers, status === 'declined' ? [{ kind: 'interview', id: '1', callId: 'call/1', action: 'cancel' }] : [])
    assert.equal(phone.stops, 0)
    assert.equal(h.disconnects(), 1)
    assert.deepEqual(await readdir(h.directory), [])
    assert.doesNotMatch(JSON.stringify(h.requests) + JSON.stringify(h.privateRequests) + JSON.stringify(h.updates), /CANARY_/)
  } finally { await h.close() }
})

for (const submit of [true, false]) test(`credential interview final confirmation ${submit} never copies entered values into the review`, async () => {
  const phone = credentialPhone()
  const h = await sensitiveHarness(phone, queued([{ route: 'answer' }, { route: 'skip' }, { submit }]), (_index, save) => save(' CANARY_exact\nvalue '))
  try {
    if (submit) await h.result
    else { await until(() => h.updates.length > 0); await settleFallback(h, phone) }
    assert.deepEqual(phone.answers, submit ? [{ kind: 'interview', id: '1', callId: 'call/1', action: 'submit', draft: [{ id: 'name', value: ' CANARY_exact\nvalue ' }] }] : [])
    assert.match(h.requests.at(-1)!.message, /Answer entered/)
    assert.doesNotMatch(JSON.stringify(h.requests) + JSON.stringify(h.privateRequests) + JSON.stringify(h.updates), /CANARY_/)
    assert.deepEqual(await readdir(h.directory), [])
  } finally { await h.close() }
})

for (const mode of ['forms', 'directory', 'handler', 'owner', 'approval']) test(`credential interview missing/changed ${mode} blocks the entire interview before entry`, async () => {
  const phone = credentialPhone()
  phone.ownerChanged = mode === 'owner'
  phone.approvalChanged = mode === 'approval'
  if (mode === 'handler') Object.defineProperty(phone, 'answerSensitiveInterview', { value: undefined })
  const h = await sensitiveHarness(phone, () => { assert.fail('Blocked interview opened a form') }, () => { assert.fail('Blocked interview opened a card') }, {
    server: mode !== 'helper', support: mode !== 'forms', ...(mode === 'directory' ? { directory: 'relative/not-allowed' } : {}),
  })
  try {
    await until(() => h.updates.length > 0)
    await settleFallback(h, phone)
    assert.equal(h.requests.length, 0)
    assert.equal(h.privateRequests.length, 0)
    assert.deepEqual(phone.answers, [])
  } finally { await h.close() }
})

for (const mode of ['owner', 'approval', 'questions', 'draft']) test(`credential interview ${mode} changes before final submission prevent a write`, async () => {
  const phone = credentialPhone()
  const replies = queued([{ route: 'answer' }, { route: 'skip' }, { submit: true }])
  const h = await sensitiveHarness(phone, params => {
    if (params.message.includes('Review answers')) {
      if (mode === 'owner') phone.ownerChanged = true
      else if (mode === 'approval') phone.approvalChanged = true
      else if (mode === 'questions') phone.source = { ...credentialSource, createdAt: 456 }
      else phone.source = { ...credentialSource, draft: [{ id: 'name', value: 'phone-edited' }] }
    }
    return replies(params)
  }, (_index, save) => save('CANARY_changed'))
  try {
    await until(() => h.updates.length > 0)
    await settleFallback(h, phone)
    assert.deepEqual(phone.answers, [])
    assert.equal(h.cards(), 1)
    assert.equal(h.disconnects(), 1)
    assert.deepEqual(await readdir(h.directory), [])
    assert.doesNotMatch(JSON.stringify(h.requests) + JSON.stringify(h.updates), /CANARY_|DO_NOT_LEAK|phone-edited/)
  } finally { await h.close() }
})

for (const action of ['submit', 'cancel']) test(`uncertain credential interview ${action} POST is attempted once without replaying collected values`, async () => {
  const phone = credentialPhone(); phone.failAnswer = true
  const controls = action === 'submit' ? queued([{ route: 'answer' }, { route: 'skip' }, { submit: true }]) : queued([{ route: 'answer' }, { route: 'answer' }])
  const h = await sensitiveHarness(phone, controls, (index, save) => action === 'cancel' && index === 1
    ? { isError: false, structuredContent: { status: 'declined' }, content: [{ type: 'text', text: '{"status":"declined"}' }] }
    : save('CANARY_uncertain'))
  try {
    await until(() => h.updates.length > 0)
    await settleFallback(h, phone)
    assert.equal(phone.answers.length, 1)
    assert.equal((phone.answers[0] as { action: string }).action, action)
    assert.equal(h.cards(), action === 'submit' ? 1 : 2)
    assert.equal(h.disconnects(), 1)
    assert.deepEqual(await readdir(h.directory), [])
    assert.doesNotMatch(JSON.stringify(h.requests) + JSON.stringify(h.privateRequests) + JSON.stringify(h.updates), /CANARY_|DO_NOT_LEAK/)
  } finally { await h.close() }
})

for (const action of ['withdraw', 'stop', 'disconnect']) test(`credential interview ${action} stops private collection without submitting local answers`, async () => {
  const phone = credentialPhone()
  const waiting = Promise.withResolvers<void>()
  const answer = Promise.withResolvers<unknown>()
  const h = await sensitiveHarness(phone, queued([{ route: 'answer' }, { route: 'answer' }]), (index, save) => {
    if (index === 0) return save('CANARY_partial')
    waiting.resolve(); return answer.promise
  })
  try {
    await waiting.promise
    assert.deepEqual(await readdir(h.directory), [])
    if (action === 'withdraw') { phone.withdraw(); await until(() => h.disconnects() === 1); phone.ended.resolve() }
    else if (action === 'stop') await h.agent.notify(acp.methods.agent.session.cancel, { sessionId: '1' })
    else h.connection.close()
    await h.result.catch(error => { if (action !== 'disconnect') throw error })
    if (action === 'disconnect') answer.resolve({ isError: true, content: [] })
    else answer.resolve(await h.save('CANARY_late'))
    await until(async () => (await readdir(h.directory)).length === 0)
    assert.deepEqual(phone.answers, [])
    assert.equal(phone.stops, action === 'stop' ? 1 : 0)
    assert.doesNotMatch(JSON.stringify(h.requests) + JSON.stringify(h.privateRequests) + JSON.stringify(h.updates), /CANARY_/)
  } finally { await h.close() }
})

for (const mode of ['error', 'mismatch', 'permissions', 'empty']) test(`credential interview ${mode} delivery stops collection without ordinary sensitive entry`, async () => {
  const phone = credentialPhone()
  const h = await sensitiveHarness(phone, queued([{ route: 'answer' }]), async (_index, save) => {
    const reply = await save(mode === 'empty' ? '' : 'CANARY_invalid') as { isError: boolean, structuredContent: { file: string }, content: { text: string }[] }
    if (mode === 'error') reply.isError = true
    if (mode === 'mismatch') reply.content[0]!.text = '{"status":"declined"}'
    if (mode === 'permissions') await chmod(reply.structuredContent.file, 0o644)
    return reply
  })
  try {
    await until(() => h.updates.length > 0)
    await settleFallback(h, phone)
    assert.deepEqual(phone.answers, [])
    assert.equal(h.requests.length, 1)
    assert.equal(h.cards(), 1)
    assert.deepEqual(await readdir(h.directory), [])
    assert.doesNotMatch(JSON.stringify(h.requests) + JSON.stringify(h.privateRequests) + JSON.stringify(h.updates), /CANARY_|ZodError|ENOENT/)
  } finally { await h.close() }
})

test('sensitive classification does not relax schema, rich-content or saved-draft validation', async () => {
  for (const source of [
    { ...credentialSource, private: true },
    { ...credentialSource, draft: [{ id: 'name', value: 'CANARY_draft' }] },
    { ...credentialSource, asked: { credential: ['CANARY_helper'] } },
    { ...credentialSource, questions: { questions: [...credentialSource.questions.questions, { id: 'info', type: 'info', question: '![CANARY_media](local.png)' }] } },
  ]) {
    const phone = credentialPhone(source)
    const h = await sensitiveHarness(phone, () => { assert.fail('Unsupported interview opened a form') }, () => { assert.fail('Unsupported interview opened a card') })
    try {
      await until(() => h.updates.length > 0)
      await settleFallback(h, phone)
      assert.equal(h.requests.length, 0)
      assert.equal(h.privateRequests.length, 0)
      assert.deepEqual(phone.answers, [])
      assert.doesNotMatch(JSON.stringify(h.updates), /CANARY_/)
    } finally { await h.close() }
  }
})

test('credential classification uses question intent and metadata, not literal source-code identifiers', () => {
  assert.equal(sensitiveInterview(supportedInterview(credentialSource, 2, true)), true)
  const source = { ...credentialSource, questions: { questions: [{ id: 'review', type: 'text', question: 'Review the code.', content: { source: 'const password = "literal";', lang: 'ts' } }] } }
  assert.equal(sensitiveInterview(supportedInterview(source, 1, true)), false)
})

for (const uncertain of [false, true]) test(`credential interview real ACP + HTTP ${uncertain ? 'lost acknowledgement' : 'completion'} posts only the final native draft`, async () => {
  const fixture = await new PhoneFixture().start()
  const writes: { path: string, body: unknown }[] = []
  let ownerChecks = 0, interviewReads = 0
  let directory = ''
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/me') ownerChecks++
    if (url.pathname === '/api/c/1/interviews/call%2F1') {
      if (init?.method !== 'POST') { interviewReads++; return Response.json(credentialSource) }
      assert.deepEqual(await readdir(directory), [])
      writes.push({ path: url.pathname, body: JSON.parse(String(init.body)) })
      if (uncertain) throw new Error('DO_NOT_LEAK uncertain CANARY_http_interview')
      fixture.conversations.get(1)!.approvals = []
      fixture.finish(1, 'Interview completed.')
      return Response.json({ ...credentialSource, status: 'completed' })
    }
    return fetch(input, init)
  }
  const backend = new HttpPhoneBackend(new PhoneHttp(fixture.url, fixture.token, request), '/phone/work', 0)
  const h = await sensitiveHarness(credentialPhone(), queued([{ route: 'answer' }, { route: 'answer' }, { submit: true }]), (index, save) => save(index ? '001234' : 'CANARY_http_interview'), { backend })
  directory = h.directory
  try {
    await fixture.submitted.promise
    const native = view({ ...interviewForm, count: 2 }).approvals![0]!
    native.tool = 'interview'
    fixture.conversations.get(1)!.approvals = [native]
    fixture.publish(1)
    if (uncertain) {
      await until(() => h.updates.some(update => JSON.stringify(update).includes('no automatic retry')))
      fixture.conversations.get(1)!.approvals = []
      fixture.finish(1, 'Completed after phone inspection.')
    }
    await h.result
    assert.equal(ownerChecks, 2)
    assert.equal(interviewReads, 3)
    assert.deepEqual(writes, [{ path: '/api/c/1/interviews/call%2F1', body: { action: 'submit', draft: [{ id: 'name', value: 'CANARY_http_interview' }, { id: 'credential', value: '001234' }] } }])
    assert.deepEqual(fixture.answers, [])
    assert.deepEqual(fixture.privateAnswers, [])
    assert.equal(fixture.aborts, 0)
    assert.deepEqual(await readdir(h.directory), [])
    assert.doesNotMatch(JSON.stringify(h.requests) + JSON.stringify(h.privateRequests) + JSON.stringify(h.updates), /CANARY_|001234|DO_NOT_LEAK/)
  } finally { await h.close(); await fixture.close() }
})

test('private interview entry does not suppress the native phone result that can contain submitted answers', async () => {
  class ResultPhone extends FormsPhone {
    override async *run(): AsyncGenerator<PhoneEvent> {
      yield* new Projection().consume(view(this.form))
      await this.ended.promise
      yield { type: 'tool', id: 'call/1', name: 'interview', status: 'completed', output: 'Native result includes CANARY_native_result.' }
      yield { type: 'text', text: 'Native result includes CANARY_native_result.' }
      yield { type: 'end', reason: 'end_turn' }
    }
  }
  const phone = new ResultPhone({ ...interviewForm, count: 2 }); phone.source = structuredClone(credentialSource)
  const h = await sensitiveHarness(phone, queued([{ route: 'answer' }, { route: 'skip' }, { submit: true }]), (_index, save) => save('CANARY_native_result'))
  try {
    await h.result
    assert.doesNotMatch(JSON.stringify(h.requests) + JSON.stringify(h.privateRequests), /CANARY_native_result/)
    assert.ok(h.updates.some(item => item.update.sessionUpdate === 'agent_message_chunk' && item.update.content.type === 'text' && item.update.content.text === 'Native result includes CANARY_native_result.'))
  } finally { await h.close() }
})

test('a mismatched private-helper protocol leaves a credential interview on the phone before any entry', async () => {
  const phone = credentialPhone()
  const h = await sensitiveHarness(phone, () => { assert.fail('No controls after failed private setup') }, () => { assert.fail('No card after failed private setup') }, { version: 'future' })
  try {
    await until(() => h.updates.length > 0)
    await settleFallback(h, phone)
    assert.deepEqual(phone.answers, [])
    assert.equal(h.requests.length, 0)
    assert.equal(h.cards(), 0)
    assert.equal(h.disconnects(), 1)
  } finally { await h.close() }
})

test('credential interview replay outside an active prompt does not open controls or password cards', async () => {
  const phone = credentialPhone()
  const h = await sensitiveHarness(phone, queued([{ route: 'skip' }, { route: 'skip' }, { submit: true }]), () => { assert.fail('Skipped questions need no card') })
  try {
    await h.result
    const count = h.requests.length + h.privateRequests.length
    await h.agent.request(acp.methods.agent.session.load, { ...workspace, mcpServers: [{ type: 'acp', name: 't3-code', serverId: 't3-code' }], sessionId: '1' })
    assert.equal(h.requests.length + h.privateRequests.length, count)
    assert.equal(phone.answers.length, 1)
    assert.deepEqual(phone.answers[0], { kind: 'interview', id: '1', callId: 'call/1', action: 'submit', draft: [] })
    assert.match(JSON.stringify(h.updates), /active prompt turn/)
  } finally { await h.close() }
})

for (const completion of ['answer', 'cancel']) test(`asynchronous credential interview keeps the ACP turn open until ${completion} without restarting phone work`, async () => {
  class AsyncCredentialPhone extends FormsPhone {
    override async *run(): AsyncGenerator<PhoneEvent> {
      yield* new Projection().consume(view(this.form))
      yield { type: 'end', reason: 'end_turn' }
    }
    async *observe(_id: string, signal: AbortSignal): AsyncGenerator<PhoneEvent> {
      const abort = () => this.wake.resolve()
      signal.addEventListener('abort', abort, { once: true })
      try {
        while (!signal.aborted) {
          yield* this.extra.splice(0)
          await this.wake.promise
          this.wake = Promise.withResolvers<void>()
        }
      } finally { signal.removeEventListener('abort', abort) }
    }
  }
  const phone = new AsyncCredentialPhone({ ...interviewForm, count: 2 }); phone.source = structuredClone(credentialSource)
  const waiting = Promise.withResolvers<void>()
  const answer = Promise.withResolvers<unknown>()
  const h = await sensitiveHarness(phone, queued([{ route: 'answer' }, { route: 'skip' }, { submit: true }]), () => { waiting.resolve(); return answer.promise })
  let finished = false
  void h.result.then(() => { finished = true })
  try {
    await waiting.promise
    assert.equal(finished, false)
    if (completion === 'answer') answer.resolve(await h.save('CANARY_async'))
    else await h.agent.notify(acp.methods.agent.session.cancel, { sessionId: '1' })
    assert.deepEqual(await h.result, { stopReason: completion === 'answer' ? 'end_turn' : 'cancelled' })
    if (completion === 'cancel') {
      answer.resolve(await h.save('CANARY_late_async'))
      await until(async () => (await readdir(h.directory)).length === 0)
    }
    assert.equal(phone.answers.length, completion === 'answer' ? 1 : 0)
    assert.equal(phone.stops, 0)
    assert.equal(h.disconnects(), 1)
    assert.doesNotMatch(JSON.stringify(h.requests) + JSON.stringify(h.privateRequests) + JSON.stringify(h.updates), /CANARY_/)
  } finally { await h.close() }
})

test('credential questions without a visible title still have a nonempty password-card label', async () => {
  const phone = credentialPhone({ ...credentialSource, questions: { questions: [{ id: 'password', type: 'text', question: '' }] } }, 1)
  const h = await sensitiveHarness(phone, queued([{ route: 'answer' }, { submit: true }]), (_index, save) => save('CANARY_empty_title'))
  try {
    await h.result
    const card = h.privateRequests.find(request => request.params.method === 'tools/call')!
    assert.equal((card.params.params as { arguments: { label: string } }).arguments.label, 'Interview answer')
    assert.equal(phone.answers.length, 1)
  } finally { await h.close() }
})

const ordinaryConsent = { collection: 'Continue with ordinary input' }
function ordinaryProperties(params: acp.CreateElicitationRequest) {
  assert.equal(params.mode, 'form')
  assert.ok('requestedSchema' in params)
  return (params.requestedSchema as { properties: Record<string, acp.ElicitationPropertySchema> }).properties
}

test('ordinary credential interviews warn before any answer and collect text, Other and choice notes without a private helper', async () => {
  const source = { questions: { title: 'Account details', description: '**Dummy-only** interview.', questions: [
    ...credentialSource.questions.questions,
    { id: 'checks', type: 'multi', question: 'Choose checks.', options: ['Build', { label: 'Tests', content: { source: '**Test context**', lang: 'md' } }] },
    { id: 'other', type: 'single', question: 'Choose region.', options: ['A', 'B'] },
    { id: 'skip', type: 'text', question: 'Optional comment?' },
    { id: 'outro', type: 'info', question: 'End of review.' },
  ] }, draft: [], status: 'waiting', createdAt: 123 }
  const phone = credentialPhone(source, 5)
  const replies = [ordinaryConsent, { route: 'answer' }, { value: 'CANARY_name' }, { route: 'answer' }, { value: '001234' },
    { route: 'options' }, { value: ['Build', 'Tests'] }, { addNote: true }, { note: 'CANARY_note' }, { addNote: false },
    { route: 'other' }, { value: 'CANARY_other' }, { route: 'skip' }, { submit: true }]
  const respond = queued(replies)
  const h = await harness(phone, params => {
    const properties = ordinaryProperties(params)
    assert.deepEqual(phone.answers, [])
    assert.match(params.message, /saved in pi-phone and returned to the phone model/)
    assert.match(params.message, /Masking depends on the ADE/)
    if ('collection' in properties) {
      assert.equal(phone.sensitiveChecks, 1)
      assert.deepEqual(Object.keys(properties), ['collection'])
      assert.match(String(properties.collection!.description), /visible and retained in ADE history or logs/)
    } else if ((properties.value?.type === 'string' && !('enum' in properties.value)) || 'note' in properties) {
      assert.match(String((properties.value ?? properties.note)!.description), /not private delivery/)
    }
    return respond(params)
  })
  try {
    await h.result
    assert.deepEqual(replies, [])
    assert.equal(phone.sensitiveChecks, 3)
    assert.equal(phone.getCount, 4)
    assert.deepEqual(phone.answers, [{ kind: 'interview', id: '1', callId: 'call/1', action: 'submit', draft: [
      { id: 'name', value: 'CANARY_name' }, { id: 'credential', value: '001234' },
      { id: 'checks', value: [{ option: 'Build', note: 'CANARY_note' }, { option: 'Tests' }] }, { id: 'other', value: { option: 'CANARY_other' } },
    ] }])
    assert.match(h.requests.at(-1)!.message, /Answer entered/)
    assert.match(h.requests.at(-1)!.message, /End of review/)
    assert.doesNotMatch(JSON.stringify(h.requests) + JSON.stringify(h.updates), /CANARY_|001234/)
  } finally { h.connection.close() }
})

for (const outcome of ['phone', 'cancel', 'decline', 'malformed', 'unsupported', 'owner', 'interview']) test(`ordinary interview warning ${outcome} does not open answer fields`, async () => {
  const phone = credentialPhone()
  const h = await harness(phone, params => {
    assert.deepEqual(Object.keys(ordinaryProperties(params)), ['collection'])
    if (outcome === 'phone') return { action: 'accept', content: { collection: 'Complete in pi-phone' } }
    if (outcome === 'unsupported') throw new acp.RequestError(-32601, 'DO_NOT_LEAK CANARY_error')
    if (outcome === 'malformed') return { action: 'accept', content: { collection: 'Continue with ordinary input', value: 'CANARY_value' } }
    if (outcome === 'owner' || outcome === 'interview') {
      if (outcome === 'owner') phone.ownerChanged = true
      else phone.source = { ...credentialSource, createdAt: 456 }
      return { action: 'accept', content: ordinaryConsent }
    }
    return { action: outcome }
  }, true, true)
  try {
    if (outcome === 'decline') await h.result
    else { await until(() => h.updates.length > 0); await settleFallback(h, phone) }
    assert.equal(h.requests.length, 1)
    assert.deepEqual(phone.answers, outcome === 'decline' ? [{ kind: 'interview', id: '1', callId: 'call/1', action: 'cancel' }] : [])
    assert.equal(phone.stops, 0)
    assert.doesNotMatch(JSON.stringify(h.updates), /CANARY_|DO_NOT_LEAK/)
  } finally { h.connection.close() }
})

for (const outcome of ['decline', 'cancel', 'malformed']) test(`ordinary interview ${outcome} after partial answers never sends a draft`, async () => {
  const phone = credentialPhone()
  const initial = queued([ordinaryConsent, { route: 'answer' }, { value: 'CANARY_partial' }, { route: 'answer' }])
  let responses = 0
  const h = await harness(phone, params => {
    if (++responses <= 4) return initial(params)
    return outcome === 'malformed' ? { action: 'accept', content: { value: 1234 } } : { action: outcome }
  }, true, true)
  try {
    if (outcome === 'decline') await h.result
    else { await until(() => h.updates.length > 0); await settleFallback(h, phone) }
    assert.deepEqual(phone.answers, outcome === 'decline' ? [{ kind: 'interview', id: '1', callId: 'call/1', action: 'cancel' }] : [])
    assert.equal(h.requests.length, 5)
    assert.doesNotMatch(JSON.stringify(h.requests) + JSON.stringify(h.updates), /CANARY_|1234/)
  } finally { h.connection.close() }
})

for (const outcome of ['false', 'owner', 'approval', 'interview', 'uncertain']) test(`ordinary interview final ${outcome} preserves checked submission and never retries`, async () => {
  const phone = credentialPhone()
  phone.failAnswer = outcome === 'uncertain'
  const initial = queued([ordinaryConsent, { route: 'answer' }, { value: 'CANARY_partial' }, { route: 'skip' }])
  const h = await harness(phone, params => {
    if (!('submit' in ordinaryProperties(params))) return initial(params)
    assert.match(params.message, /Answer entered/)
    assert.doesNotMatch(params.message, /CANARY_/)
    if (outcome === 'owner') phone.ownerChanged = true
    if (outcome === 'approval') phone.approvalChanged = true
    if (outcome === 'interview') phone.source = { ...credentialSource, createdAt: 456 }
    return { action: 'accept', content: { submit: outcome !== 'false' } }
  }, true, true)
  try {
    await until(() => h.updates.length > 0)
    await settleFallback(h, phone)
    assert.equal(h.requests.length, 5)
    assert.deepEqual(phone.answers, outcome === 'uncertain' ? [{ kind: 'interview', id: '1', callId: 'call/1', action: 'submit', draft: [{ id: 'name', value: 'CANARY_partial' }] }] : [])
    assert.doesNotMatch(JSON.stringify(h.requests) + JSON.stringify(h.updates), /CANARY_|DO_NOT_LEAK/)
  } finally { h.connection.close() }
})

for (const stage of ['warning', 'entry']) for (const action of ['withdraw', 'cancel', 'disconnect']) test(`ordinary interview ${action} during ${stage} ignores late answers`, async () => {
  const phone = credentialPhone()
  const asked = Promise.withResolvers<void>(), released = Promise.withResolvers<void>()
  const initial = queued([ordinaryConsent, { route: 'answer' }, { value: 'CANARY_partial' }, { route: 'answer' }])
  let responses = 0
  const h = await harness(phone, async (params, signal) => {
    if (stage === 'entry' && ++responses <= 4) return initial(params)
    asked.resolve()
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    released.resolve()
    return { action: 'accept', content: stage === 'warning' ? ordinaryConsent : { value: '001234' } }
  })
  try {
    const rejected = action === 'disconnect' ? assert.rejects(h.result) : undefined
    await asked.promise
    if (action === 'withdraw') phone.withdraw()
    else if (action === 'cancel') await h.agent.notify(acp.methods.agent.session.cancel, { sessionId: '1' })
    else { h.connection.close(); await rejected }
    await released.promise
    phone.ended.resolve()
    if (action !== 'disconnect') await h.result
    await tick()
    assert.deepEqual(phone.answers, [])
    assert.equal(phone.stops, action === 'cancel' ? 1 : 0)
    assert.doesNotMatch(JSON.stringify(h.requests) + JSON.stringify(h.updates), /CANARY_|001234/)
  } finally { h.connection.close() }
})

test('ordinary credential interviews without form support remain on the phone before fetching questions', async () => {
  const phone = credentialPhone()
  const h = await harness(phone, () => { assert.fail('No form capability') }, false, true)
  try { await settleFallback(h, phone); assert.equal(phone.getCount, 0); assert.deepEqual(phone.answers, []) } finally { h.connection.close() }
})

for (const source of [
  { ...credentialSource, draft: [{ id: 'name', value: 'CANARY_phone_draft' }] },
  { ...credentialSource, questions: { questions: [...credentialSource.questions.questions, { id: 'extra', type: 'info', question: '![CANARY_image](local.png)' }] } },
]) test('ordinary sensitive interviews validate the entire source before the warning or answer collection', async () => {
  const phone = credentialPhone(source)
  const h = await harness(phone, () => { assert.fail('Unsupported source opened a warning') }, true, true)
  try { await settleFallback(h, phone); assert.deepEqual(h.requests, []); assert.deepEqual(phone.answers, []); assert.doesNotMatch(JSON.stringify(h.updates), /CANARY_/) } finally { h.connection.close() }
})

for (const completion of ['submit', 'decline', 'uncertain']) test(`ordinary credential interview real ACP + HTTP ${completion} writes only one checked final decision`, async () => {
  const fixture = await new PhoneFixture().start()
  const writes: { path: string, body: unknown }[] = []
  let ownerChecks = 0, reads = 0
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/me') ownerChecks++
    if (url.pathname === '/api/c/1/interviews/call%2F1') {
      if (init?.method !== 'POST') { reads++; return Response.json(credentialSource) }
      writes.push({ path: url.pathname, body: JSON.parse(String(init.body)) })
      if (completion === 'uncertain') throw new Error('DO_NOT_LEAK CANARY_uncertain')
      fixture.conversations.get(1)!.approvals = []
      fixture.finish(1, 'Interview completed.')
      return Response.json({ ...credentialSource, status: completion === 'decline' ? 'cancelled' : 'completed' })
    }
    return fetch(input, init)
  }
  const backend = new HttpPhoneBackend(new PhoneHttp(fixture.url, fixture.token, request), '/phone/work', 0)
  const values = queued([ordinaryConsent, { route: 'answer' }, { value: 'CANARY_http_ordinary' }, { route: 'answer' }, { value: '001234' }, { submit: true }])
  let responses = 0
  const h = await sensitiveHarness(credentialPhone(), params => completion === 'decline' && ++responses === 5 ? { action: 'decline' } : values(params),
    () => { assert.fail('No private helper was advertised') }, { backend, server: false })
  try {
    await fixture.submitted.promise
    const native = view({ ...interviewForm, count: 2 }).approvals![0]!
    native.tool = 'interview'
    fixture.conversations.get(1)!.approvals = [native]
    fixture.publish(1)
    if (completion === 'uncertain') {
      await until(() => h.updates.some(update => JSON.stringify(update).includes('no automatic retry')))
      fixture.conversations.get(1)!.approvals = []
      fixture.finish(1, 'Completed after phone inspection.')
    }
    await h.result
    assert.deepEqual(writes, [{ path: '/api/c/1/interviews/call%2F1', body: completion === 'decline' ? { action: 'cancel' } : {
      action: 'submit', draft: [{ id: 'name', value: 'CANARY_http_ordinary' }, { id: 'credential', value: '001234' }],
    } }])
    assert.equal(ownerChecks, 3)
    assert.equal(reads, 4)
    assert.deepEqual(h.privateRequests, [])
    assert.deepEqual(fixture.answers, [])
    assert.deepEqual(fixture.privateAnswers, [])
    assert.equal(fixture.aborts, 0)
    assert.doesNotMatch(JSON.stringify(h.requests) + JSON.stringify(h.updates), /CANARY_|001234|DO_NOT_LEAK/)
  } finally { await h.close(); await fixture.close() }
})
