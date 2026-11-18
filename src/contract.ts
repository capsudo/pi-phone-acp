import { z } from 'zod'

// Source-checked against pi-phone build-508, c59e0ceb993dc0ded331eeb6758f86bbaed75cec.
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const block = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('thinking'), text: z.string(), redacted: z.boolean().optional() }),
  z.object({ type: z.literal('toolCall'), id: z.string(), name: z.string(), args: z.record(z.string(), z.unknown()), clipped: z.record(z.string(), z.number()).optional() }),
])
export const entrySchema = z.object({
  id,
  kind: z.string(),
  text: z.string().optional(),
  from: z.string().optional(),
  blocks: z.array(block).optional(),
  stopReason: z.string().optional(),
  error: z.string().optional(),
  callId: z.string().optional(),
  name: z.string().optional(),
  isError: z.boolean().optional(),
  images: z.number().optional(),
}).passthrough()
export type Entry = z.infer<typeof entrySchema>

export const viewSchema = z.object({
  full: z.boolean(),
  conversation: z.object({ id, cwd: z.string() }).passthrough(),
  entries: z.array(entrySchema),
  order: z.array(id).optional(),
  live: z.object({
    busy: z.boolean(),
    tools: z.array(z.object({
      callId: z.string(), name: z.string(), status: z.enum(['pending', 'running', 'done']), output: z.string().optional(),
    })).optional(),
  }).passthrough(),
  inbox: z.array(z.object({ id }).passthrough()).optional(),
  approvals: z.array(z.object({
    id: z.string(), conversationId: id, callId: z.string().optional(), tool: z.string(),
    subject: z.string(), reason: z.string(), form: z.unknown().optional(),
  })).optional(),
}).passthrough()
export type View = z.infer<typeof viewSchema>

export const pollSchema = z.object({
  session: z.string().min(1),
  events: z.array(z.object({ seq: id, event: z.string(), data: z.unknown() })),
})
export const createdSchema = z.object({ id })
export const submittedSchema = z.object({ submissionId: id, requestId: z.string() })
export const historySchema = z.array(entrySchema)
export const helloSchema = z.object({
  user: z.object({ id: z.string(), role: z.enum(['owner', 'guest', 'viewer']) }),
  server: z.object({ home: z.string(), defaultCwd: z.string() }).passthrough(),
}).passthrough()
