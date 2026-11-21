import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HttpPhoneBackend } from '../src/backend.js'
import { PhoneHttp } from '../src/http.js'
import type { PhoneEvent } from '../src/phone.js'
import { PhoneFixture } from './fixture.js'

function backend(fixture: PhoneFixture) {
  return new HttpPhoneBackend(new PhoneHttp(fixture.url, fixture.token, fetch, 3000), '~/work', 1)
}
async function collect(source: AsyncIterable<PhoneEvent>) {
  const events = []
  for await (const event of source) events.push(event)
  return events
}

test('authenticates with a device Bearer token, creates in the phone cwd, and reads compatibility only', async () => {
  const fixture = await new PhoneFixture().start()
  try {
    const phone = backend(fixture)
    assert.deepEqual(await phone.doctor(AbortSignal.timeout(3000)), { role: 'owner', compatibleShape: true, runtimeVersionVerified: false })
    const session = await phone.create(AbortSignal.timeout(3000))
    assert.equal(session.id, '1')
    assert.equal(fixture.conversations.get(1)!.cwd, '~/work')
    assert.equal(fixture.submissions.length, 0)
  } finally { await fixture.close() }
})

test('submits once, acknowledges poll events, streams committed text, and closes observation without Stop', async () => {
  const fixture = await new PhoneFixture().start()
  fixture.create()
  try {
    const result = collect(backend(fixture).run('1', 'hello', 'request-1', AbortSignal.timeout(3000)))
    await fixture.submitted.promise
    fixture.finish(1)
    const events = await result
    assert.deepEqual(events.filter(event => event.type === 'text'), [{ type: 'text', text: 'phone result' }])
    assert.deepEqual(events.at(-1), { type: 'end', reason: 'end_turn' })
    assert.equal(fixture.submissions.length, 1)
    assert.equal(fixture.submissions[0]!.requestId, 'request-1')
    assert.ok(fixture.acks.some(entry => entry.ack >= 2))
    assert.equal(fixture.aborts, 0)
    assert.equal(fixture.closes, 1)
  } finally { await fixture.close() }
})

test('a lost submit response fails without retrying, while accepted phone work continues', async () => {
  const fixture = await new PhoneFixture().start()
  fixture.create()
  fixture.loseSubmitResponse = true
  try {
    await assert.rejects(collect(backend(fixture).run('1', 'work', 'uncertain', AbortSignal.timeout(3000))))
    assert.equal(fixture.submissions.length, 1)
    assert.equal(fixture.conversations.get(1)!.busy, true)
    assert.equal(fixture.aborts, 0)
    fixture.finish(1)
    const loaded = await backend(fixture).load('1', AbortSignal.timeout(3000))
    assert.ok(loaded.replay?.some(event => event.type === 'text' && event.text === 'phone result'))
    assert.equal(fixture.submissions.length, 1)
  } finally { await fixture.close() }
})

test('observer loss does not stop a task, and a fresh adapter reloads its result', async () => {
  const fixture = await new PhoneFixture().start()
  fixture.create()
  const detached = new AbortController()
  try {
    const result = collect(backend(fixture).run('1', 'keep working', 'disconnect', detached.signal))
    const rejection = assert.rejects(result)
    await fixture.submitted.promise
    detached.abort()
    await rejection
    assert.equal(fixture.aborts, 0)
    assert.equal(fixture.conversations.get(1)!.busy, true)
    fixture.finish(1, 'finished after T3 left')
    const loaded = await backend(fixture).load('1', AbortSignal.timeout(3000))
    assert.ok(loaded.replay?.some(event => event.type === 'text' && event.text === 'finished after T3 left'))
    assert.equal(fixture.submissions.length, 1)
  } finally { await fixture.close() }
})

test('retries a failed poll using its existing session and does not duplicate entries', async () => {
  const fixture = await new PhoneFixture().start()
  fixture.create()
  try {
    const phone = backend(fixture)
    const result = collect(phone.run('1', 'hello', 'poll-retry', AbortSignal.timeout(3000)))
    await fixture.submitted.promise
    fixture.failNextPoll = true
    fixture.finish(1)
    const events = await result
    assert.equal(events.filter(event => event.type === 'text' && event.text === 'phone result').length, 1)
    assert.equal(fixture.submissions.length, 1)
    assert.ok(fixture.pollCount >= 3)
  } finally { await fixture.close() }
})

test('explicit cancellation invokes phone Stop exactly once and waits for phone idle', async () => {
  const fixture = await new PhoneFixture().start()
  fixture.create()
  try {
    const phone = backend(fixture)
    const result = collect(phone.run('1', 'stop me', 'cancel', AbortSignal.timeout(3000)))
    await fixture.submitted.promise
    await phone.cancel('1', 'cancel')
    await phone.cancel('1', 'cancel')
    assert.deepEqual((await result).at(-1), { type: 'end', reason: 'cancelled' })
    assert.equal(fixture.aborts, 1)
  } finally { await fixture.close() }
})

test('refuses a new prompt when the phone already owns running work', async () => {
  const fixture = await new PhoneFixture().start()
  fixture.create().busy = true
  try {
    await assert.rejects(collect(backend(fixture).run('1', 'unwanted followup', 'busy', AbortSignal.timeout(3000))))
    assert.equal(fixture.submissions.length, 0)
    assert.equal(fixture.aborts, 0)
    assert.equal(fixture.conversations.get(1)!.busy, true)
  } finally { await fixture.close() }
})

test('refuses to attribute a concurrent phone writer to the ACP prompt', async () => {
  const fixture = await new PhoneFixture().start()
  fixture.create()
  try {
    const result = collect(backend(fixture).run('1', 'first', 'one-writer', AbortSignal.timeout(3000)))
    const rejection = assert.rejects(result)
    await fixture.submitted.promise
    fixture.append(1, { kind: 'user', text: 'other browser', images: 0 })
    fixture.finish(1)
    await rejection
    assert.equal(fixture.submissions.length, 1)
    assert.equal(fixture.aborts, 0)
  } finally { await fixture.close() }
})

test('loads pre-compaction history in pages and does not duplicate active entries', async () => {
  const fixture = await new PhoneFixture().start()
  const native = fixture.create()
  for (let i = 0; i < 450; i++) fixture.append(1, { kind: 'user', text: `history ${i}`, images: 0 })
  fixture.finish(1, 'current')
  native.contextFrom = 450
  try {
    const loaded = await backend(fixture).load('1', AbortSignal.timeout(3000))
    assert.equal(loaded.replay?.filter(event => event.type === 'user').length, 450)
    assert.equal(loaded.replay?.filter(event => event.type === 'text').length, 1)
  } finally { await fixture.close() }
})

test('authorization failure is not retried as a temporary poll failure', async () => {
  const fixture = await new PhoneFixture().start()
  fixture.create()
  fixture.rejectPollStatus = 403
  try {
    await assert.rejects(backend(fixture).load('1', AbortSignal.timeout(3000)))
    assert.equal(fixture.pollCount, 1)
    assert.equal(fixture.submissions.length, 0)
  } finally { await fixture.close() }
})

test('validates native session IDs before making a request', async () => {
  const fixture = await new PhoneFixture().start()
  try {
    await assert.rejects(backend(fixture).load('../me', AbortSignal.timeout(3000)))
    assert.equal(fixture.pollCount, 0)
  } finally { await fixture.close() }
})

test('a new polling session recovers a full snapshot after the server expires the old one', async () => {
  const fixture = await new PhoneFixture().start()
  fixture.create()
  try {
    const result = collect(backend(fixture).run('1', 'continue', 'expire', AbortSignal.timeout(3000)))
    await fixture.submitted.promise
    fixture.expirePollers()
    fixture.finish(1, 'after poll expiry')
    const events = await result
    assert.equal(events.filter(event => event.type === 'text' && event.text === 'after poll expiry').length, 1)
    assert.equal(fixture.submissions.length, 1)
    assert.equal(fixture.aborts, 0)
  } finally { await fixture.close() }
})

test('fills a compaction gap after reconnect instead of losing the submitted user boundary', async () => {
  const fixture = await new PhoneFixture().start()
  const native = fixture.create()
  try {
    const result = collect(backend(fixture).run('1', 'compact', 'compact', AbortSignal.timeout(3000)))
    await fixture.submitted.promise
    fixture.expirePollers()
    const marker = fixture.append(1, { kind: 'compaction', summary: 'older messages' })
    native.contextFrom = marker.id
    fixture.finish(1, 'after compaction')
    const events = await result
    assert.ok(events.some(event => event.type === 'text' && event.text === 'after compaction'))
    assert.deepEqual(events.at(-1), { type: 'end', reason: 'end_turn' })
  } finally { await fixture.close() }
})

test('does not treat an internal subagent report as a second human writer', async () => {
  const fixture = await new PhoneFixture().start()
  fixture.create()
  try {
    const result = collect(backend(fixture).run('1', 'use an agent', 'report', AbortSignal.timeout(3000)))
    await fixture.submitted.promise
    fixture.append(1, { kind: 'user', text: 'subagent result', from: 'helper', images: 0 })
    fixture.finish(1)
    assert.deepEqual((await result).at(-1), { type: 'end', reason: 'end_turn' })
  } finally { await fixture.close() }
})

test('reloading ongoing work permits observation but never submits a replacement task', async () => {
  const fixture = await new PhoneFixture().start()
  const native = fixture.create()
  native.busy = true
  fixture.append(1, { kind: 'user', text: 'existing work', images: 0 })
  const controller = new AbortController()
  try {
    const phone = backend(fixture)
    await phone.load('1', AbortSignal.timeout(3000))
    const updates = phone.observe('1', controller.signal)
    const next = updates.next()
    fixture.finish(1, 'existing work finished')
    assert.deepEqual((await next).value, { type: 'text', text: 'existing work finished' })
    controller.abort()
    await updates.return(undefined)
    assert.equal(fixture.submissions.length, 0)
    assert.equal(fixture.aborts, 0)
  } finally { controller.abort(); await fixture.close() }
})


test('an uncertain submission blocks another prompt until an explicit reload', async () => {
  const fixture = await new PhoneFixture().start()
  fixture.create()
  fixture.loseSubmitResponse = true
  try {
    const phone = backend(fixture)
    await assert.rejects(collect(phone.run('1', 'do once', 'uncertain-first', AbortSignal.timeout(3000))))
    fixture.finish(1)
    await assert.rejects(collect(phone.run('1', 'do once', 'unwanted-retry', AbortSignal.timeout(3000))))
    assert.equal(fixture.submissions.length, 1)
    await phone.load('1', AbortSignal.timeout(3000))
    fixture.loseSubmitResponse = false
    // A new explicit request after inspecting history is a different turn.
    const next = collect(phone.run('1', 'next task', 'new-turn', AbortSignal.timeout(3000)))
    const completion = new Promise<void>(resolve => {
      const original = fixture.publish.bind(fixture)
      fixture.publish = (id, view) => {
        original(id, view)
        if (fixture.submissions.length === 2) {
          fixture.publish = original
          queueMicrotask(() => { fixture.finish(id, 'next result'); resolve() })
        }
      }
    })
    await completion
    assert.deepEqual((await next).at(-1), { type: 'end', reason: 'end_turn' })
    assert.equal(fixture.submissions.length, 2)
  } finally { await fixture.close() }
})

test('merges delta views without requiring the phone to repeat unchanged fields', async () => {
  const fixture = await new PhoneFixture().start()
  fixture.create()
  const publish = fixture.publish.bind(fixture)
  fixture.publish = (id, supplied) => {
    const view = supplied ?? fixture.view(id)
    const { inbox: _inbox, approvals: _approvals, ...patch } = view
    publish(id, { ...patch, full: false })
  }
  try {
    const result = collect(backend(fixture).run('1', 'delta updates', 'delta', AbortSignal.timeout(3000)))
    await fixture.submitted.promise
    fixture.finish(1, 'delta result')
    const events = await result
    assert.equal(events.filter(event => event.type === 'text' && event.text === 'delta result').length, 1)
    assert.deepEqual(events.at(-1), { type: 'end', reason: 'end_turn' })
  } finally { await fixture.close() }
})

test('approval IDs containing slashes stay within the authenticated API route', async () => {
  const fixture = await new PhoneFixture().start()
  try {
    await backend(fixture).answerApproval('call/1', true, AbortSignal.timeout(3000))
    assert.deepEqual(fixture.answers, [{ id: 'call/1', allow: true }])
    assert.equal(fixture.submissions.length, 0)
  } finally { await fixture.close() }
})

for (const allow of [false, true]) test(`structured ask acceptance uses /asks, refusal uses /approvals (${allow})`, async () => {
  const requests: { path: string, body: unknown }[] = []
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    requests.push({ path: url.pathname, body: JSON.parse(String(init?.body)) })
    return Response.json({ ok: true })
  }
  const phone = new HttpPhoneBackend(new PhoneHttp(new URL('http://phone.test'), 'test-only', request), '~/work')
  if (allow) await phone.answerAsk('ask/task/call', { name: 'demo' }, AbortSignal.timeout(1000))
  else await phone.answerApproval('ask/task/call', false, AbortSignal.timeout(1000))
  assert.deepEqual(requests, [{ path: `/api/${allow ? 'asks' : 'approvals'}/ask%2Ftask%2Fcall`, body: allow ? { values: { name: 'demo' } } : { allow: false } }])
})

test('fetches separate interview questions and posts native draft/completion rather than boolean approval', async () => {
  const requests: { path: string, body: unknown }[] = []
  const source = { questions: { questions: [{ id: 'x', type: 'text', question: 'Feedback?' }] }, draft: [], status: 'waiting', createdAt: 1 }
  const request: typeof fetch = async (input, init) => {
    requests.push({ path: new URL(String(input)).pathname, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
    return Response.json(init?.body === undefined ? source : { ...source, status: JSON.parse(String(init.body)).action === 'submit' ? 'completed' : 'cancelled' })
  }
  const phone = new HttpPhoneBackend(new PhoneHttp(new URL('http://phone.test'), 'test-only', request), '~/work')
  const signal = AbortSignal.timeout(1000)
  assert.deepEqual(await phone.getInterview('392', 'call/with/slashes', signal), source)
  await phone.answerInterview('392', 'call/with/slashes', { action: 'submit', draft: [{ id: 'x', value: 'demo' }] }, signal)
  await phone.answerInterview('392', 'call/with/slashes', { action: 'cancel' }, signal)
  assert.deepEqual(requests, [
    { path: '/api/c/392/interviews/call%2Fwith%2Fslashes', body: undefined },
    { path: '/api/c/392/interviews/call%2Fwith%2Fslashes', body: { action: 'submit', draft: [{ id: 'x', value: 'demo' }] } },
    { path: '/api/c/392/interviews/call%2Fwith%2Fslashes', body: { action: 'cancel' } },
  ])
})

test('lost structured answer responses are not retried by the backend', async () => {
  let requests = 0
  const request: typeof fetch = async () => { requests++; throw new Error('test-only lost response') }
  const phone = new HttpPhoneBackend(new PhoneHttp(new URL('http://phone.test'), 'test-only', request), '~/work')
  await assert.rejects(phone.answerAsk('ask/1', { field: 'demo' }, AbortSignal.timeout(1000)))
  assert.equal(requests, 1)
  await assert.rejects(phone.answerInterview('392', 'call/1', { action: 'submit', draft: [] }, AbortSignal.timeout(1000)))
  assert.equal(requests, 2)
})

test('structured answer acknowledgements must confirm the expected outcome', async () => {
  for (const result of [{ ok: false }, { status: 'cancelled' }]) {
    const request: typeof fetch = async () => Response.json(result)
    const phone = new HttpPhoneBackend(new PhoneHttp(new URL('http://phone.test'), 'test-only', request), '~/work')
    if ('ok' in result) await assert.rejects(phone.answerAsk('ask/1', { field: 'demo' }, AbortSignal.timeout(1000)))
    else await assert.rejects(phone.answerInterview('392', 'call/1', { action: 'submit', draft: [] }, AbortSignal.timeout(1000)))
  }
})
