import assert from 'node:assert/strict'
import { test } from 'node:test'
import { askValues, supportedSecretAsk } from '../src/forms.js'
import type { SecretAskApproval, InterviewApproval, InterviewAnswer } from '../src/phone.js'
import { privateFields, privateValues, supportedPrivateForm } from '../src/private-forms.js'
import { Projection } from '../src/projection.js'
import { browserCode, browserLogin, computerLogin, storeSecret, privateCases, privateView, privateApproval } from './private-fixture.js'
import { HttpPhoneBackend } from '../src/backend.js'
import { PhoneHttp } from '../src/http.js'

function httpFixture(form: unknown = browserCode, tool = 'browser_ask_code') {
  const state = { view: privateView(form, tool), role: 'owner', team: false, fail: false, interview: undefined as unknown, posts: [] as { path: string, body: unknown }[] }
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/me') return Response.json({ user: { id: 'owner', role: state.role, team: state.team }, server: { home: '/phone/home', defaultCwd: '/phone/home/work' } })
    if (url.pathname === '/api/poll') return Response.json(url.searchParams.has('close') ? { ok: true } : {
      session: 'private-test-poll', events: [{ seq: 1, event: 'view', data: state.view }],
    })
    if (url.pathname.includes('/interviews/') && init?.method !== 'POST') return Response.json(state.interview)
    assert.equal(init?.method, 'POST')
    state.posts.push({ path: url.pathname, body: JSON.parse(String(init?.body)) })
    if (state.fail) throw new Error('DO_NOT_LEAK native result or request')
    if (url.pathname.includes('/interviews/')) return Response.json({ status: JSON.parse(String(init?.body)).action === 'cancel' ? 'cancelled' : 'completed' })
    return Response.json({ ok: true })
  }
  const phone = new HttpPhoneBackend(new PhoneHttp(new URL('http://fixture.invalid'), 'dummy-only-token', request), '~/work')
  return { state, phone }
}

test('posts complete private answers once to the matching native consumer, never ordinary ask/interview routes', async () => {
  const cases = [
    [browserCode, 'browser_ask_code', { code: '001234' }, '/api/browser/asks/'],
    [browserLogin, 'browser_sign_in', { username: 'demo', password: ' dummy-only ' }, '/api/browser/asks/'],
    [computerLogin, 'computer_sign_in', { password: 'dummy-only', code: '000123' }, '/api/computer/asks/'],
    [storeSecret, 'secret_request', { value: 'dummy-only-store' }, '/api/secrets/requests/'],
  ] as const
  for (const [form, tool, values, route] of cases) {
    const { state, phone } = httpFixture(form, tool)
    const item = privateApproval(form, tool)
    assert.equal(await phone.privateFormCurrent('1', item, new AbortController().signal), true)
    await phone.answerPrivate('1', item, values as Record<string, string>, new AbortController().signal)
    assert.deepEqual(state.posts, [{ path: `${route}${item.id}`, body: form.type === 'secret'
      ? { value: (values as Record<string, string>).value } : { values, remember: false, useSaved: false } }])
  }
})

test('refuses private delivery after withdrawal, native ID/form changes or loss of owner access', async () => {
  for (const change of ['withdraw', 'field', 'call', 'role', 'team']) {
    const { state, phone } = httpFixture()
    const item = privateApproval()
    if (change === 'withdraw') state.view.approvals = []
    else if (change === 'field') state.view.approvals![0]!.form = { ...browserCode, site: 'changed.invalid' }
    else if (change === 'call') state.view.approvals![0]!.callId = 'replaced-call'
    else if (change === 'role') state.role = 'guest'
    else state.team = true
    assert.equal(await phone.privateFormCurrent('1', item, new AbortController().signal), false)
    await assert.rejects(phone.answerPrivate('1', item, { code: '001234' }, new AbortController().signal))
    assert.deepEqual(state.posts, [])
  }
})

test('does not retry an uncertain private answer POST', async () => {
  const { state, phone } = httpFixture()
  state.fail = true
  await assert.rejects(phone.answerPrivate('1', privateApproval(), { code: '001234' }, new AbortController().signal))
  assert.equal(state.posts.length, 1)
})

test('projects dedicated private consumers separately from ordinary elicitation, preserving native IDs', () => {
  for (const [form, tool] of privateCases) {
    const item = privateApproval(form, tool)
    assert.equal(item.interactive, true)
    assert.equal(item.form, undefined)
    assert.equal(item.id, 'risky-17-call-1')
    assert.equal(item.callId, 'call')
    assert.deepEqual(item.privateForm, form)
    assert.ok(privateFields(item.privateForm).length)
  }
})

test('keeps saved sign-ins, generic sensitive asks, malformed and unknown private forms phone-only', () => {
  for (const [form, tool] of [
    [{ ...browserLogin, saved: true }, 'browser_sign_in'],
    [{ ...computerLogin, saved: true }, 'computer_sign_in'],
    [{ ...browserCode, fields: [...browserCode.fields, ...browserCode.fields] }, 'browser_ask_code'],
    [{ ...browserCode, fields: browserLogin.fields }, 'browser_ask_code'],
    [{ ...browserCode, value: 'DO_NOT_LEAK' }, 'browser_ask_code'],
    [{ ...browserLogin, fields: [...browserLogin.fields, ...browserCode.fields] }, 'browser_sign_in'],
    [{ ...storeSecret, name: 'not-valid' }, 'secret_request'],
    [browserCode, 'ask'],
    [{ type: 'ask', title: 'Password', fields: [{ name: 'password', label: 'Password' }], submit: 'Send' }, 'ask'],
  ] as const) {
    const [item] = new Projection().consume(privateView(form, tool))
    assert.ok(item?.type === 'approval')
    assert.equal(item.form, undefined)
    assert.equal(item.privateForm, undefined)
    assert.doesNotMatch(JSON.stringify(item), /DO_NOT_LEAK/)
  }
})

test('validates complete named private values without trimming, number conversion or secret-bearing errors in updates', () => {
  const form = supportedPrivateForm(browserLogin, 'browser_sign_in')!
  assert.deepEqual(privateValues(form, { username: ' dummy ', password: '\t012345\t' }), { username: ' dummy ', password: '\t012345\t' })
  assert.deepEqual(privateValues(supportedPrivateForm(browserCode, 'browser_ask_code')!, { code: '001234' }), { code: '001234' })
  for (const values of [{ password: 'dummy-only' }, { username: 'demo', password: '' }, { username: 'demo', password: 'x\n' }, { username: 'demo', password: 'x', extra: 'x' }]) {
    assert.throws(() => privateValues(form, values as Record<string, string>))
  }
  assert.throws(() => privateValues(supportedPrivateForm(storeSecret, 'secret_request')!, { value: '001234' }))
})

test('explicit private Decline sends one identity-checked native rejection and no values', async () => {
  for (const [form, tool] of privateCases) {
    const { state, phone } = httpFixture(form, tool)
    const native = state.view.approvals![0]!
    native.id = 'private/decline'
    const item = privateApproval(form, tool); item.id = native.id
    await phone.declinePrivate('1', item, new AbortController().signal)
    assert.deepEqual(state.posts, [{ path: '/api/approvals/private%2Fdecline', body: { allow: false } }])
  }
})

test('private Decline is refused for changed identity/ownership and never retried after an uncertain write', async () => {
  for (const change of ['withdraw', 'field', 'call', 'role', 'team']) {
    const { state, phone } = httpFixture()
    const item = privateApproval()
    if (change === 'withdraw') state.view.approvals = []
    else if (change === 'field') state.view.approvals![0]!.form = { ...browserCode, site: 'changed.invalid' }
    else if (change === 'call') state.view.approvals![0]!.callId = 'replacement'
    else if (change === 'role') state.role = 'guest'
    else state.team = true
    await assert.rejects(phone.declinePrivate('1', item, new AbortController().signal))
    assert.deepEqual(state.posts, [])
  }
  const { state, phone } = httpFixture(); state.fail = true
  await assert.rejects(phone.declinePrivate('1', privateApproval(), new AbortController().signal))
  assert.equal(state.posts.length, 1)
  assert.deepEqual(state.posts[0]!.body, { allow: false })
})

const secretAsk = {
  type: 'ask', title: 'Extension details', submit: 'Send', fields: [
    { name: 'account', label: 'Account' }, { name: 'key', label: 'Access key', secret: true },
  ],
}
function secretAskApproval(): SecretAskApproval {
  const item = new Projection().consume(privateView(secretAsk, 'extension_question'))[0]
  assert.ok(item?.type === 'approval' && item.form?.type === 'ask')
  return { ...item, form: item.form }
}

test('secret:true selects private extension collection without treating the extension as a dedicated private consumer', () => {
  const item = secretAskApproval()
  assert.deepEqual(item.form, secretAsk)
  assert.equal(item.privateForm, undefined)
  assert.equal(item.interactive, true)
  assert.equal(item.tool, 'extension_question')
  assert.deepEqual(supportedSecretAsk(secretAsk), secretAsk)
  assert.deepEqual(askValues(item.form, { account: ' dummy ', key: '001234' }), { account: ' dummy ', key: '001234' })
  for (const raw of [
    { ...secretAsk, fields: [{ name: 'key', label: 'Key', secret: false }] },
    { ...secretAsk, fields: [] },
    { ...secretAsk, fields: [...secretAsk.fields, secretAsk.fields[0]] },
    { ...secretAsk, fields: [{ name: 'key', label: 'Key', secret: 'true' }] },
    { ...secretAsk, unknown: true },
    { ...secretAsk, fields: Array.from({ length: 7 }, (_, index) => ({ name: `field${index}`, label: 'Field', secret: true })) },
  ]) assert.equal(supportedSecretAsk(raw), undefined)
})

test('secret extension answers use the native ask route and exact named strings, not secret storage or sign-in routes', async () => {
  const { state, phone } = httpFixture(secretAsk, 'extension_question')
  const item = secretAskApproval()
  const signal = new AbortController().signal
  assert.equal(await phone.secretAskCurrent('1', item, signal), true)
  await phone.answerSecretAsk('1', item, { account: ' dummy ', key: '001234' }, signal)
  assert.deepEqual(state.posts, [{ path: `/api/asks/${item.id}`, body: { values: { account: ' dummy ', key: '001234' } } }])
})

for (const change of ['withdraw', 'id', 'conversation', 'tool', 'call', 'form', 'secret-flag', 'role', 'team']) {
  test(`secret extension ${change} revalidation blocks both submission and Decline`, async () => {
    const { state, phone } = httpFixture(secretAsk, 'extension_question')
    const item = secretAskApproval()
    const current = state.view.approvals![0]!
    if (change === 'withdraw') state.view.approvals = []
    else if (change === 'id') current.id = 'replacement'
    else if (change === 'conversation') current.conversationId = 2
    else if (change === 'tool') current.tool = 'replacement'
    else if (change === 'call') current.callId = 'replacement'
    else if (change === 'form') current.form = { ...secretAsk, title: 'Changed' }
    else if (change === 'secret-flag') current.form = { ...secretAsk, fields: secretAsk.fields.map(field => ({ ...field, secret: false })) }
    else if (change === 'role') state.role = 'guest'
    else state.team = true
    const signal = new AbortController().signal
    assert.equal(await phone.secretAskCurrent('1', item, signal), false)
    await assert.rejects(phone.answerSecretAsk('1', item, { account: 'dummy', key: 'CANARY_key' }, signal))
    await assert.rejects(phone.declineSecretAsk('1', item, signal))
    assert.deepEqual(state.posts, [])
  })
}

test('secret extension backend rejects missing, extra and oversized values before attempting a write', async () => {
  const { state, phone } = httpFixture(secretAsk, 'extension_question')
  const item = secretAskApproval()
  for (const values of [{ key: 'dummy' }, { account: 'dummy', key: '' }, { account: 'dummy', key: 'x'.repeat(4097) }, { account: 'dummy', key: 'dummy', extra: 'dummy' }]) {
    await assert.rejects(phone.answerSecretAsk('1', item, values as Record<string, string>, new AbortController().signal))
  }
  assert.deepEqual(state.posts, [])
})

for (const decline of [false, true]) test(`secret extension ${decline ? 'Decline' : 'answer'} is attempted once and keeps slashes inside the request ID`, async () => {
  const { state, phone } = httpFixture(secretAsk, 'extension_question')
  const item = secretAskApproval()
  item.id = state.view.approvals![0]!.id = 'extension/request/1'
  state.fail = true
  const signal = new AbortController().signal
  await assert.rejects(decline ? phone.declineSecretAsk('1', item, signal) : phone.answerSecretAsk('1', item, { account: 'dummy', key: '001234' }, signal))
  assert.deepEqual(state.posts, [{ path: `/api/${decline ? 'approvals' : 'asks'}/extension%2Frequest%2F1`, body: decline ? { allow: false } : { values: { account: 'dummy', key: '001234' } } }])
})

const sensitiveSource = {
  questions: { questions: [{ id: 'code', type: 'text', question: 'Enter the verification code.' }] },
  draft: [], status: 'waiting', createdAt: 123,
}
const sensitiveForm = { type: 'interview', callId: 'call', title: 'Code confirmation', count: 1 }
function sensitiveApproval(): InterviewApproval {
  const item = new Projection().consume(privateView(sensitiveForm, 'interview'))[0]
  assert.ok(item?.type === 'approval' && item.form?.type === 'interview')
  return { ...item, form: item.form }
}

for (const action of ['submit', 'cancel'] as const) test(`credential interview ${action} uses the native interview route without a partial-draft write`, async () => {
  const { state, phone } = httpFixture(sensitiveForm, 'interview')
  state.interview = structuredClone(sensitiveSource)
  const item = sensitiveApproval()
  const signal = new AbortController().signal
  assert.equal(await phone.sensitiveInterviewCurrent('1', item, sensitiveSource, signal), true)
  const answer = action === 'submit' ? { action, draft: [{ id: 'code', value: '001234' }] } : { action }
  await phone.answerSensitiveInterview('1', item, sensitiveSource, answer, signal)
  assert.deepEqual(state.posts, [{ path: '/api/c/1/interviews/call', body: answer }])
})

for (const change of ['withdraw', 'id', 'conversation', 'tool', 'call', 'form-call', 'form-count', 'form-title', 'questions', 'draft', 'ended', 'role', 'team']) {
  test(`credential interview ${change} invalidates both submission and explicit skip`, async () => {
    const { state, phone } = httpFixture(sensitiveForm, 'interview')
    state.interview = structuredClone(sensitiveSource)
    const item = sensitiveApproval()
    const current = state.view.approvals![0]!
    if (change === 'withdraw') state.view.approvals = []
    else if (change === 'id') current.id = 'replacement'
    else if (change === 'conversation') current.conversationId = 2
    else if (change === 'tool') current.tool = 'replacement'
    else if (change === 'call') current.callId = 'replacement'
    else if (change === 'form-call') current.form = { ...sensitiveForm, callId: 'replacement' }
    else if (change === 'form-count') current.form = { ...sensitiveForm, count: 2 }
    else if (change === 'form-title') current.form = { ...sensitiveForm, title: 'replacement' }
    else if (change === 'questions') state.interview = { ...sensitiveSource, createdAt: 456 }
    else if (change === 'draft') state.interview = { ...sensitiveSource, draft: [{ id: 'code', value: 'phone-edited' }] }
    else if (change === 'ended') state.interview = { ...sensitiveSource, status: 'completed' }
    else if (change === 'role') state.role = 'guest'
    else state.team = true
    const signal = new AbortController().signal
    assert.equal(await phone.sensitiveInterviewCurrent('1', item, sensitiveSource, signal), false)
    await assert.rejects(phone.answerSensitiveInterview('1', item, sensitiveSource, { action: 'submit', draft: [{ id: 'code', value: '001234' }] }, signal))
    await assert.rejects(phone.answerSensitiveInterview('1', item, sensitiveSource, { action: 'cancel' }, signal))
    assert.deepEqual(state.posts, [])
  })
}

for (const action of ['submit', 'cancel'] as const) test(`an uncertain credential interview ${action} acknowledgement never causes a second POST`, async () => {
  const { state, phone } = httpFixture(sensitiveForm, 'interview')
  state.interview = structuredClone(sensitiveSource); state.fail = true
  const item = sensitiveApproval()
  const answer = action === 'submit' ? { action, draft: [{ id: 'code', value: '001234' }] } : { action }
  await assert.rejects(phone.answerSensitiveInterview('1', item, sensitiveSource, answer, new AbortController().signal))
  assert.equal(state.posts.length, 1)
  assert.deepEqual(state.posts[0], { path: '/api/c/1/interviews/call', body: answer })
})

test('credential interview submission rejects malformed drafts and never attaches local answers to cancellation', async () => {
  const { state, phone } = httpFixture(sensitiveForm, 'interview')
  state.interview = structuredClone(sensitiveSource)
  const item = sensitiveApproval()
  for (const answer of [
    { action: 'cancel', draft: [{ id: 'code', value: '001234' }] },
    { action: 'submit' },
    { action: 'submit', draft: [{ id: 'code', value: '' }] },
    { action: 'submit', draft: [{ id: 'code', value: ['001234'] }] },
    { action: 'submit', draft: [{ id: 'unknown', value: '001234' }] },
    { action: 'submit', draft: [{ id: 'code', value: '001234', attachments: [] }] },
    { action: 'submit', draft: [{ id: 'code', value: '001234' }, { id: 'code', value: '001234' }] },
  ]) await assert.rejects(phone.answerSensitiveInterview('1', item, sensitiveSource, answer as InterviewAnswer, new AbortController().signal))
  assert.deepEqual(state.posts, [])
})

test('credential interview choice answers retain native Other/notes shapes and reject malformed selections', async () => {
  const form = { ...sensitiveForm, count: 2 }
  const original = { ...sensitiveSource, questions: { title: 'Credential confirmation', questions: [
    { id: 'single', type: 'single', question: 'Choose.', options: ['A', 'B'] },
    { id: 'multi', type: 'multi', question: 'Choose.', options: ['A', 'B'] },
  ] } }
  const { state, phone } = httpFixture(form, 'interview'); state.interview = original
  const item = { ...sensitiveApproval(), form: { ...sensitiveApproval().form, count: 2 } }
  for (const draft of [
    [{ id: 'single', value: 'A' }], [{ id: 'single', value: { option: '' } }],
    [{ id: 'multi', value: [] }], [{ id: 'multi', value: [{ option: 'A' }, { option: 'A' }] }],
    [{ id: 'multi', value: [{ option: 'A', note: '' }] }],
  ]) await assert.rejects(phone.answerSensitiveInterview('1', item, original, { action: 'submit', draft }, new AbortController().signal))
  assert.deepEqual(state.posts, [])
  const answer = { action: 'submit' as const, draft: [
    { id: 'single', value: { option: 'Other label' } },
    { id: 'multi', value: [{ option: 'B', note: 'CANARY_note' }, { option: 'A' }] },
  ] }
  await phone.answerSensitiveInterview('1', item, original, answer, new AbortController().signal)
  assert.deepEqual(state.posts, [{ path: '/api/c/1/interviews/call', body: answer }])
})
