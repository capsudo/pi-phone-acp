import assert from 'node:assert/strict'
import { test } from 'node:test'
import { privateFields, privateValues, supportedPrivateForm } from '../src/private-forms.js'
import { Projection } from '../src/projection.js'
import { browserCode, browserLogin, computerLogin, storeSecret, privateCases, privateView, privateApproval } from './private-fixture.js'
import { HttpPhoneBackend } from '../src/backend.js'
import { PhoneHttp } from '../src/http.js'

function httpFixture(form: unknown = browserCode, tool = 'browser_ask_code') {
  const state = { view: privateView(form, tool), role: 'owner', team: false, fail: false, posts: [] as { path: string, body: unknown }[] }
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/me') return Response.json({ user: { id: 'owner', role: state.role, team: state.team }, server: { home: '/phone/home', defaultCwd: '/phone/home/work' } })
    if (url.pathname === '/api/poll') return Response.json(url.searchParams.has('close') ? { ok: true } : {
      session: 'private-test-poll', events: [{ seq: 1, event: 'view', data: state.view }],
    })
    assert.equal(init?.method, 'POST')
    state.posts.push({ path: url.pathname, body: JSON.parse(String(init?.body)) })
    if (state.fail) throw new Error('DO_NOT_LEAK native result or request')
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
    [{ type: 'ask', title: 'Password', fields: [{ name: 'password', label: 'Password', secret: true }], submit: 'Send' }, 'ask'],
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
