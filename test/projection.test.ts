import assert from 'node:assert/strict'
import { test } from 'node:test'
import { viewSchema } from '../src/contract.js'
import { Projection } from '../src/projection.js'
import { approvalView, riskyApproval, riskyForm } from './approval-fixture.js'

const snapshot = () => ({
  full: true, conversation: { id: 1, cwd: '/phone/work' }, entries: [],
  live: { busy: true }, inbox: [], approvals: [],
})

test('projects committed tool calls, progress and results without duplicate history', () => {
  const projection = new Projection()
  const first = viewSchema.parse({ ...snapshot(), entries: [{
    id: 1, kind: 'assistant', blocks: [{ type: 'toolCall', id: 'tool-1', name: 'bash', args: { command: 'pwd' } }], stopReason: 'toolUse',
  }] })
  assert.deepEqual(projection.consume(first), [{ type: 'tool', id: 'tool-1', name: 'bash', status: 'in_progress', input: { command: 'pwd' } }])
  assert.deepEqual(projection.consume(first), [])
  const second = viewSchema.parse({ ...snapshot(), entries: [{ id: 2, kind: 'toolResult', callId: 'tool-1', name: 'bash', text: '/phone/work', isError: false }],
    live: { busy: true, tools: [{ callId: 'tool-1', name: 'bash', status: 'running' }] },
  })
  assert.deepEqual(projection.consume(second), [{ type: 'tool', id: 'tool-1', name: 'bash', status: 'completed', output: '/phone/work' }])
  assert.deepEqual(projection.consume(second), [])
})

test('does not duplicate uncommitted live text after a reconnect or commit', () => {
  const projection = new Projection()
  assert.deepEqual(projection.consume(viewSchema.parse({ ...snapshot(), live: { busy: true, generation: { message: { blocks: [{ type: 'text', text: 'partial' }] } } } })), [])
  const committed = viewSchema.parse({ ...snapshot(), entries: [{ id: 1, kind: 'assistant', blocks: [{ type: 'text', text: 'partial and final' }], stopReason: 'stop' }] })
  assert.deepEqual(projection.consume(committed), [{ type: 'text', text: 'partial and final' }])
  assert.deepEqual(projection.consume(committed), [])
})

test('does not reveal redacted thoughts and keeps unsupported image content visible as a placeholder', () => {
  const projection = new Projection()
  const view = viewSchema.parse({ ...snapshot(), entries: [
    { id: 1, kind: 'user', text: 'picture', images: 1 },
    { id: 2, kind: 'assistant', blocks: [{ type: 'thinking', text: 'hidden', redacted: true }, { type: 'text', text: 'answer' }] },
  ] })
  const events = projection.consume(view)
  assert.ok(events.some(event => event.type === 'notice'))
  assert.equal(events.some(event => event.type === 'thought'), false)
})

test('projects native risky cards as simple approvals with the action and site context', () => {
  for (const place of ['browser', 'computer'] as const) {
    for (const found of ['name', 'button', 'address'] as const) {
      const [event] = new Projection().consume(viewSchema.parse(approvalView({ ...riskyForm, place, found })))
      assert.ok(event?.type === 'approval')
      assert.equal(event.interactive, false)
      assert.equal(event.id, riskyApproval.id)
      assert.equal(event.callId, riskyApproval.callId)
      assert.equal(event.subject, 'Delete')
      assert.ok(event.reason.startsWith(riskyApproval.reason))
      assert.ok(event.reason.includes(`Action: ${riskyForm.control}`))
      assert.ok(event.reason.includes(`Trigger: delete (${found})`))
      assert.ok(event.reason.includes(`Where: ${riskyForm.where}`))
      assert.ok(event.reason.includes(`Interface: ${place}`))
    }
  }
})

test('does not treat unknown, malformed or input-bearing forms as simple risky approvals', () => {
  const { where: _where, ...incomplete } = riskyForm
  for (const form of [
    null, 'risky', [], {},
    { type: 'secret', value: 'DO_NOT_LEAK' },
    { type: 'interview', fields: [{ value: 'DO_NOT_LEAK' }] },
    { type: 'future', ...{ value: 'DO_NOT_LEAK' } },
    incomplete,
    { ...riskyForm, control: '' },
    { ...riskyForm, where: '' },
    { ...riskyForm, place: 'terminal' },
    { ...riskyForm, found: 'future' },
    { ...riskyForm, fields: [{ value: 'DO_NOT_LEAK' }] },
  ]) {
    const [event] = new Projection().consume(viewSchema.parse(approvalView(form)))
    assert.ok(event?.type === 'approval')
    assert.equal(event.interactive, true)
    assert.equal(event.reason, riskyApproval.reason)
    assert.doesNotMatch(JSON.stringify(event), /DO_NOT_LEAK/)
  }
})

test('retains support for form-less simple approvals', () => {
  const view = approvalView()
  const { form: _form, ...approval } = view.approvals[0]!
  const [event] = new Projection().consume(viewSchema.parse({ ...view, approvals: [approval] }))
  assert.ok(event?.type === 'approval')
  assert.equal(event.interactive, false)
  assert.equal(event.reason, riskyApproval.reason)
})

test('withdrawal or replacement invalidates an outstanding form without repeating the form contents', () => {
  const projection = new Projection()
  const original = viewSchema.parse(approvalView({ type: 'ask', title: 'Question', fields: [{ name: 'answer', label: 'Answer' }], submit: 'Send' }))
  projection.consume(original)
  const changed = structuredClone(original)
  changed.approvals![0]!.form = { type: 'secret', name: 'DO_NOT_LEAK', description: 'Secret' }
  const replacement = projection.consume(changed)
  assert.deepEqual(replacement[0], { type: 'approval_withdrawn', id: riskyApproval.id })
  assert.doesNotMatch(JSON.stringify(replacement), /DO_NOT_LEAK/)
  const ended = projection.consume({ ...changed, approvals: [] })
  assert.deepEqual(ended, [{ type: 'approval_withdrawn', id: riskyApproval.id }])
})
