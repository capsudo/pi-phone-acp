import assert from 'node:assert/strict'
import { Projection } from '../src/projection.js'
import { viewSchema } from '../src/contract.js'
import { approvalView } from './approval-fixture.js'

export const browserCode = { type: 'browser', kind: 'code', site: 'example.invalid', fields: [{ name: 'code', index: 7, label: 'Code' }], instruction: 'Enter a dummy code.', place: 'phone' } as const
export const browserLogin = { type: 'browser', kind: 'sign-in', site: 'example.invalid', fields: [{ name: 'username', index: 2, label: 'Username or email' }, { name: 'password', index: 5, label: 'Password' }], saved: false, secret: 'LOGIN_EXAMPLE', place: 'phone' } as const
export const computerLogin = { type: 'computer-sign-in', machine: 'machine-1', machineName: 'Dummy laptop', app: { name: 'demo', label: 'Demo' }, fields: [{ name: 'password', index: 4, label: 'Password' }, { name: 'code', index: 8, label: 'Code' }], saved: false } as const
export const storeSecret = { type: 'secret', name: 'DUMMY_ONLY', description: 'Dummy only, save in phone Settings > Secrets.' } as const
export const privateCases = [
  [browserCode, 'browser_ask_code'], [browserLogin, 'browser_sign_in'], [computerLogin, 'computer_sign_in'], [storeSecret, 'secret_request'],
] as const

export function privateView(form: unknown = browserCode, tool = 'browser_ask_code') {
  const view = approvalView(form)
  view.approvals[0]!.tool = tool
  return viewSchema.parse(view)
}

export function privateApproval(form: unknown = browserCode, tool = 'browser_ask_code') {
  const event = new Projection().consume(privateView(form, tool))[0]
  assert.ok(event?.type === 'approval' && event.privateForm)
  return { ...event, privateForm: event.privateForm }
}
