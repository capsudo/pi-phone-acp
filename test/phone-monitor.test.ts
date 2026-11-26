import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { PhoneUnavailable } from '../src/availability.js'
import { PhoneHttpError } from '../src/http.js'
import { PhoneMonitor } from '../src/phone-monitor.js'
import type { PhoneBackend } from '../src/phone.js'

const options = { timeoutMs: 100, intervalMs: 80, retryDelayMs: 10 }
async function until(condition: () => boolean) {
  const deadline = Date.now() + 2000
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'Condition did not settle')
    await delay(5)
  }
}
function connection() {
  const controller = new AbortController()
  return { signal: controller.signal, close: (error?: unknown) => controller.abort(error) }
}
function phone(doctor: PhoneBackend['doctor']): PhoneBackend {
  return {
    doctor,
    async create() { throw new Error('Health checks must not create conversations') },
    async load() { throw new Error('Health checks must not load conversations') },
    async *run() { throw new Error('Health checks must not submit prompts') },
    async cancel() { throw new Error('Health checks must not cancel phone work') },
  }
}
const healthy = { role: 'owner', compatibleShape: true, runtimeVersionVerified: false }

test('concurrent relay startups share one authenticated read without sharing connection lifetime', async () => {
  let requests = 0
  const release = Promise.withResolvers<void>()
  const monitor = new PhoneMonitor(phone(async () => { requests++; await release.promise; return healthy }), options)
  const first = connection(), second = connection()
  try {
    const firstReady = monitor.attach(first)
    const secondReady = monitor.attach(second)
    const rejected = assert.rejects(firstReady)
    first.close()
    release.resolve()
    await rejected
    await secondReady
    assert.equal(requests, 1)
    assert.equal(second.signal.aborted, false)
  } finally { release.resolve(); await monitor.stop() }
})

test('successful phone traffic postpones idle checks, but monitoring continues after traffic stops', async () => {
  let requests = 0
  const monitor = new PhoneMonitor(phone(async () => { requests++; return healthy }), options)
  try {
    monitor.start()
    await until(() => requests === 1)
    const heartbeat = setInterval(() => monitor.contact(), 15)
    try {
      await delay(250)
      assert.equal(requests, 1)
    } finally { clearInterval(heartbeat) }
    await until(() => requests >= 2)
  } finally { await monitor.stop() }
})

test('repeated conversation errors coalesce and cannot create a verification storm', async () => {
  let requests = 0
  const monitor = new PhoneMonitor(phone(async () => { requests++; await delay(10); return healthy }), { ...options, intervalMs: 1000 })
  const client = connection()
  try {
    await monitor.attach(client)
    for (let index = 0; index < 50; index++) { monitor.suspect() }
    await until(() => requests === 2)
    await delay(20)
    for (let index = 0; index < 50; index++) { monitor.suspect() }
    await delay(50)
    assert.equal(requests, 2)
    assert.equal(client.signal.aborted, false)
  } finally { await monitor.stop() }
})

test('one failed read followed by successful confirmation does not disconnect clients', async () => {
  let requests = 0
  const monitor = new PhoneMonitor(phone(async () => {
    requests++
    if (requests === 2) { throw new PhoneHttpError(503) }
    return healthy
  }), options)
  const client = connection()
  try {
    await monitor.attach(client)
    monitor.suspect()
    await until(() => requests === 3)
    assert.equal(client.signal.aborted, false)
  } finally { await monitor.stop() }
})

test('stop aborts an outstanding authenticated read without reporting phone loss or leaving timers', async () => {
  const status: unknown[] = []
  let requests = 0, active = false
  const monitor = new PhoneMonitor(phone(async signal => {
    requests++
    active = true
    try {
      await delay(10000, undefined, { signal })
      return healthy
    } finally { active = false }
  }), options, failure => status.push(failure))
  monitor.start()
  const client = connection()
  const rejected = assert.rejects(monitor.attach(client), error => !(error instanceof PhoneUnavailable))
  await until(() => active)
  await monitor.stop()
  await rejected
  await delay(150)
  assert.equal(active, false)
  assert.equal(requests, 1)
  assert.equal(client.signal.aborted, true)
  assert.deepEqual(status, [])
})

test('a recovered phone can trigger a new loss check without waiting for the previous outage cooldown', async () => {
  let broken = false, requests = 0
  const monitor = new PhoneMonitor(phone(async () => {
    requests++
    if (broken) { throw new PhoneHttpError(401) }
    return healthy
  }), { ...options, intervalMs: 1000 })
  const first = connection()
  try {
    await monitor.attach(first)
    broken = true
    monitor.suspect()
    await until(() => first.signal.aborted)
    assert.ok(first.signal.reason instanceof PhoneUnavailable)
    broken = false
    const second = connection()
    await monitor.attach(second)
    broken = true
    monitor.suspect()
    await until(() => second.signal.aborted)
    assert.equal(requests, 4)
    assert.ok(second.signal.reason instanceof PhoneUnavailable)
  } finally { await monitor.stop() }
})
