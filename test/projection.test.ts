import assert from 'node:assert/strict'
import { test } from 'node:test'
import { viewSchema } from '../src/contract.js'
import { Projection } from '../src/projection.js'

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
