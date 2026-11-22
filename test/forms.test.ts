import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as acp from '@agentclientprotocol/sdk/unstable'
import { createAdapter } from '../src/adapter.js'
import { viewSchema } from '../src/contract.js'
import { askFormSchema, askValues, questionAnswer, supportedInterview, type ResponseItem } from '../src/forms.js'
import type { PhoneBackend, PhoneEvent } from '../src/phone.js'
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
  withdraw() { this.extra.push({ type: 'approval_withdrawn', id: 'form/1' }); this.wake.resolve() }
}
const workspace = { cwd: '/t3/project', mcpServers: [] }
async function harness(phone: FormsPhone, responses: (params: acp.CreateElicitationRequest, signal: AbortSignal) => unknown | Promise<unknown>, support = true, notices = false) {
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
  const connection = client.connect(createAdapter(phone))
  const agent = connection.agent
  await agent.request(acp.methods.agent.initialize, { protocolVersion: 2, clientCapabilities: {
    ...(support ? { elicitation: { form: {} } } : {}),
    ...(notices ? { session: { notices: {} } } : {}),
  } })
  const { sessionId } = await agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, workspace)
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

test('mixed ordinary and private interviews are refused before collecting any answer', async () => {
  for (const question of ['Enter your password', 'Enter the verification code', 'Enter your API key']) {
    const phone = new FormsPhone({ ...interviewForm, count: 2 })
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
      assert.match(JSON.stringify(h.updates), /phone interviews save answers and return them to the model/)
      assert.match(JSON.stringify(h.updates), /do not enter credentials in this interview/)
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

test('unsupported rich content, images, saved drafts, helpers and sensitive interviews are not partially forwarded', async () => {
  const cases = [
    { ...questions, questions: { questions: [{ id: 'photo', type: 'image', question: 'Photo?' }] } },
    { ...questions, questions: { questions: [{ id: 'x', type: 'text', question: 'Answer?', media: { type: 'html', html: '<b>DO_NOT_LEAK</b>' } }] } },
    { ...questions, questions: { questions: [{ id: 'x', type: 'text', question: 'Enter the one-time code' }] } },
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
