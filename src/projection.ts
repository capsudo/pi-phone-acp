import { riskyApprovalFormSchema, type Entry, type View } from './contract.js'
import type { PhoneEvent } from './phone.js'
import { askFormSchema, privateAsk } from './forms.js'

/** Deduplicates committed entries and tool snapshots, not unreliable SSE cursors. */
export class Projection {
  private readonly entries = new Set<number>()
  private readonly tools = new Map<string, string>()
  private readonly done = new Set<string>()
  private approvals = new Map<string, string>()
  lastEntry = 0

  consume(view: View, history: readonly Entry[] = []): PhoneEvent[] {
    const events: PhoneEvent[] = []
    const all = new Map([...history, ...view.entries].map(entry => [entry.id, entry]))
    // Entry IDs increase even across inherited history. The order supplied by
    // the phone remains authoritative for the current context.
    const order = view.order ?? view.entries.map(entry => entry.id)
    const ordered = [...history.filter(entry => !order.includes(entry.id)), ...order.map(id => all.get(id)).filter(entry => entry !== undefined)]
    for (const entry of ordered) {
      if (this.entries.has(entry.id)) continue
      this.entries.add(entry.id)
      this.lastEntry = Math.max(this.lastEntry, entry.id)
      if (entry.kind === 'user') {
        events.push({ type: 'user', text: entry.text ?? '' })
        if (entry.images) events.push({ type: 'notice', text: '[Phone message includes images. View them in pi-phone.]' })
      } else if (entry.kind === 'assistant') {
        for (const block of entry.blocks ?? []) {
          if (block.type === 'text') events.push({ type: 'text', text: block.text })
          if (block.type === 'thinking' && !block.redacted) events.push({ type: 'thought', text: block.text })
          if (block.type === 'toolCall') {
            this.tool(events, { type: 'tool', id: block.id, name: block.name, status: 'in_progress', input: block.args })
            if (block.clipped) events.push({ type: 'notice', text: '[Phone clipped tool arguments. View full details in pi-phone.]' })
          }
        }
        if (entry.error) events.push({ type: 'notice', text: '[Phone reported an agent error. Check the conversation in pi-phone.]' })
      } else if (entry.kind === 'toolResult') {
        const callId = entry.callId ?? `entry-${entry.id}`
        this.tool(events, { type: 'tool', id: callId, name: entry.name ?? 'phone tool', status: entry.isError ? 'failed' : 'completed', output: (entry.text ?? '') + (entry.images ? '\n[Phone tool returned images. View them in pi-phone.]' : '') })
        this.done.add(callId)
      } else if (entry.kind === 'compaction') {
        events.push({ type: 'notice', text: '[Phone compacted the conversation.]' })
      } else if (entry.kind === 'reset') {
        events.push({ type: 'notice', text: '[Phone reset the model context.]' })
      } else {
        events.push({ type: 'notice', text: `[Phone ${entry.kind} entry. View its full content in pi-phone.]` })
      }
    }
    // Text appears when committed. Live generations have no stable message ID,
    // so forwarding their partial text would duplicate it after reconnect/commit.
    for (const slot of view.live.tools ?? []) {
      if (this.done.has(slot.callId) || slot.status === 'done') continue
      this.tool(events, {
        type: 'tool', id: slot.callId, name: slot.name,
        status: slot.status === 'pending' ? 'pending' : 'in_progress',
        ...(slot.output === undefined ? {} : { output: slot.output }),
      })
    }
    const present = new Map((view.approvals ?? []).map(approval => [approval.id, JSON.stringify(approval)]))
    for (const [id, previous] of this.approvals) if (present.get(id) !== previous) events.push({ type: 'approval_withdrawn', id })
    this.approvals = present
    for (const approval of view.approvals ?? []) {
      const ask = askFormSchema.safeParse(approval.form)
      const form = ask.success && !privateAsk(ask.data) ? ask.data : undefined
      const risky = riskyApprovalFormSchema.safeParse(approval.form)
      const reason = risky.success
        ? `${approval.reason}\nAction: ${risky.data.control}\nTrigger: ${risky.data.word} (${risky.data.found})\nWhere: ${risky.data.where}\nInterface: ${risky.data.place}`
        : approval.reason
      events.push({
        type: 'approval', id: approval.id, callId: approval.callId ?? approval.id,
        tool: approval.tool, subject: approval.subject, reason,
        interactive: approval.form !== undefined && !risky.success,
        ...(form ? { form } : {}),
      })
    }
    return events
  }

  private tool(events: PhoneEvent[], event: Extract<PhoneEvent, { type: 'tool' }>) {
    const serialized = JSON.stringify(event)
    if (this.tools.get(event.id) === serialized) return
    this.tools.set(event.id, serialized)
    events.push(event)
  }
}
