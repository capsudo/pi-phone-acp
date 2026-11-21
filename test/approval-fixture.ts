// Native approveFor card shape from pi-phone build-508's risky.ts.
export const riskyForm = {
  type: 'risky',
  control: 'Delete',
  word: 'delete',
  found: 'name',
  where: 'Add/Remove Elements — https://the-internet.herokuapp.com/add_remove_elements/',
  place: 'browser',
} as const

export const riskyApproval = {
  id: 'risky-17-call-1',
  conversationId: 1,
  taskId: 17,
  callId: 'call',
  createdAt: 1,
  tool: 'browser_click',
  subject: 'Delete',
  reason: 'It may pay, send, book or delete (delete). Approve once lets this one action go ahead; Deny stops it.',
  form: riskyForm,
}

export const approvalView = (form: unknown = riskyForm) => ({
  full: true,
  conversation: { id: 1, cwd: '/phone/work' },
  entries: [],
  live: { busy: true },
  inbox: [],
  approvals: [{ ...riskyApproval, form }],
})
