import type { CardItem, Meeting } from '../../../../shared/protocol.ts'
import { firstName } from '../../ai/prompts.ts'
import type { EventPatch } from '../../google/ports.ts'
import { eventRow } from '../summarize.ts'
import { num, str, strs, ToolError, type AgentTool, type ToolContext } from '../types.ts'
import { resolvePeople } from './email.ts'

const MIN = 60_000

function fmt(iso: string, allDay = false): string {
  const d = new Date(iso)
  return allDay
    ? d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
    : d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function eventItem(e: Meeting): CardItem {
  return { id: e.id, kind: 'event', title: e.title, detail: fmt(e.start, e.allDay) }
}

function parseIso(v: unknown, what: string): Date {
  const t = Date.parse(str(v))
  if (Number.isNaN(t)) throw new ToolError(`${what} must be an ISO 8601 date-time`)
  return new Date(t)
}

async function requireEvent(ctx: ToolContext, id: string): Promise<Meeting> {
  if (!ctx.known(id)) throw new ToolError('Unknown event id. List events first.')
  const e = await ctx.calendar.get(id)
  if (!e) throw new ToolError('Event not found')
  return e
}

export const calendarTools: AgentTool[] = [
  {
    name: 'list_events',
    description: 'Calendar events in a window. Use for "today", "tomorrow", "this week", "next meeting".',
    parameters: {
      type: 'object',
      properties: {
        fromISO: { type: 'string', description: 'Start of window (default now)' },
        toISO: { type: 'string', description: 'End of window' },
        days: { type: 'integer', description: 'Alternative to toISO: number of days from fromISO (default 1)' },
      },
    },
    progress: 'Checking calendar...',
    async run(args, ctx) {
      const from = str(args.fromISO) ? parseIso(args.fromISO, 'fromISO') : new Date()
      const to = str(args.toISO) ? parseIso(args.toISO, 'toISO') : new Date(from.getTime() + Math.max(1, num(args.days, 1)) * 86_400_000)
      const events = await ctx.calendar.between(from.toISOString(), to.toISOString(), 10)
      return {
        forModel: { count: events.length, events: events.map(eventRow) },
        card: { kind: 'list', title: events.length ? 'Events' : 'No events', items: events.map(eventItem) },
      }
    },
  },
  {
    name: 'find_free_time',
    description: 'Free slots on a day during working hours (9-18), for scheduling.',
    parameters: {
      type: 'object',
      properties: { dateISO: { type: 'string', description: 'YYYY-MM-DD' }, durationMin: { type: 'integer' } },
      required: ['dateISO'],
    },
    progress: 'Checking free time...',
    async run(args, ctx) {
      const day = parseIso(`${str(args.dateISO).slice(0, 10)}T12:00:00`, 'dateISO')
      const dur = Math.max(15, num(args.durationMin, 30)) * MIN
      const start = new Date(day)
      start.setHours(9, 0, 0, 0)
      const end = new Date(day)
      end.setHours(18, 0, 0, 0)
      const busy = (await ctx.calendar.between(start.toISOString(), end.toISOString(), 25))
        .filter(e => !e.allDay)
        .map(e => [Date.parse(e.start), Date.parse(e.end)] as const)
        .sort((a, b) => a[0] - b[0])
      const slots: { start: string; end: string }[] = []
      let cursor = Math.max(start.getTime(), Date.now())
      for (const [s, e] of busy) {
        if (s - cursor >= dur) slots.push({ start: new Date(cursor).toISOString(), end: new Date(s).toISOString() })
        cursor = Math.max(cursor, e)
      }
      if (end.getTime() - cursor >= dur) slots.push({ start: new Date(cursor).toISOString(), end: end.toISOString() })
      const items: CardItem[] = slots.slice(0, 6).map((s, i) => ({ id: `slot-${i}`, kind: 'text', title: `${fmt(s.start)} - ${new Date(s.end).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` }))
      return { forModel: { date: str(args.dateISO), freeSlots: slots.slice(0, 6) }, card: { kind: 'list', title: 'Free', items } }
    },
  },
  {
    name: 'create_event',
    description: 'Prepare a calendar event / invite for the user to approve. Attendees are contact names or addresses.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        startISO: { type: 'string' },
        durationMin: { type: 'integer', description: 'default 30, meals 60' },
        attendees: { type: 'array', items: { type: 'string' } },
        location: { type: 'string' },
      },
      required: ['title', 'startISO'],
    },
    progress: 'Preparing invite...',
    async prepare(args, ctx) {
      const start = parseIso(args.startISO, 'startISO')
      if (start.getTime() < Date.now() - 5 * MIN) return { forModel: { error: 'That time is in the past. Ask for a future date.' } }
      const r = resolvePeople(strs(args.attendees), ctx)
      if ('ambiguous' in r) {
        return {
          forModel: { needsChoice: r.ambiguous, candidates: r.candidates },
          card: { kind: 'list', title: `Which "${r.ambiguous}"?`, items: r.candidates.map(c => ({ id: c.email, kind: 'contact', title: c.name, detail: c.email })) },
        }
      }
      if ('unknown' in r) return { forModel: { error: `No contact named "${r.unknown}". Ask for their address or use search_contacts.` } }
      const end = new Date(start.getTime() + Math.max(5, num(args.durationMin, 30)) * MIN)
      const invite = ctx.drafts.createInvite({
        title: str(args.title, 'Meeting'),
        start: start.toISOString(),
        end: end.toISOString(),
        attendees: r.people,
        location: str(args.location) || undefined,
      })
      return {
        forModel: { status: 'awaiting_approval', inviteId: invite.id, start: invite.start, attendees: r.people.map(p => p.email) },
        card: { kind: 'invite', invite },
        pending: { id: invite.id, kind: 'invite', label: r.people.length ? `Send invite to ${r.people.map(p => firstName(p.name)).join(', ')}` : 'Add to calendar' },
      }
    },
    async run() {
      throw new ToolError('Invites are created through approval')
    },
  },
  {
    name: 'update_event',
    description: 'Prepare a change to an existing event (time, title, location, add attendees) for approval.',
    parameters: {
      type: 'object',
      properties: {
        eventId: { type: 'string' },
        title: { type: 'string' },
        startISO: { type: 'string' },
        endISO: { type: 'string' },
        location: { type: 'string' },
        addAttendees: { type: 'array', items: { type: 'string' } },
      },
      required: ['eventId'],
    },
    progress: 'Preparing change...',
    async prepare(args, ctx) {
      const e = await requireEvent(ctx, str(args.eventId))
      const patch: EventPatch = {}
      const lines: string[] = [e.title]
      if (str(args.title)) (patch.title = str(args.title)), lines.push(`Rename to: ${patch.title}`)
      if (str(args.startISO)) {
        const s = parseIso(args.startISO, 'startISO')
        const len = Date.parse(e.end) - Date.parse(e.start)
        patch.start = s.toISOString()
        patch.end = str(args.endISO) ? parseIso(args.endISO, 'endISO').toISOString() : new Date(s.getTime() + len).toISOString()
        lines.push(`Move to: ${fmt(patch.start)}`)
      }
      if (str(args.location)) (patch.location = str(args.location)), lines.push(`Location: ${patch.location}`)
      const add = strs(args.addAttendees)
      if (add.length) {
        const r = resolvePeople(add, ctx)
        if ('ambiguous' in r) return { forModel: { needsChoice: r.ambiguous, candidates: r.candidates } }
        if ('unknown' in r) return { forModel: { error: `No contact named "${r.unknown}".` } }
        patch.addAttendees = r.people
        lines.push(`Add: ${r.people.map(p => p.name).join(', ')}`)
      }
      if (lines.length === 1) return { forModel: { error: 'Nothing to change. Specify a new time, title, location or attendees.' } }
      const a = ctx.pending.create('update_event', { eventId: e.id, patch }, `Update "${e.title}"`, { kind: 'edit', title: 'Update event', lines })
      return { forModel: { status: 'awaiting_approval', actionId: a.id, changes: lines.slice(1) }, card: a.preview, pending: { id: a.id, kind: 'action', label: a.label } }
    },
    async run(args, ctx) {
      const updated = await ctx.calendar.update(str(args.eventId), args.patch as EventPatch)
      return { forModel: eventRow(updated) }
    },
  },
  {
    name: 'delete_event',
    description: 'Prepare deleting an event (attendees are notified) for approval.',
    parameters: { type: 'object', properties: { eventId: { type: 'string' } }, required: ['eventId'] },
    async prepare(args, ctx) {
      const e = await requireEvent(ctx, str(args.eventId))
      const a = ctx.pending.create('delete_event', { eventId: e.id }, `Delete "${e.title}"`, { kind: 'edit', title: 'Delete event', lines: [e.title, fmt(e.start, e.allDay), 'Attendees will be notified.'] })
      return { forModel: { status: 'awaiting_approval', actionId: a.id }, card: a.preview, pending: { id: a.id, kind: 'action', label: a.label } }
    },
    async run(args, ctx) {
      await ctx.calendar.remove(str(args.eventId))
      return { forModel: { deleted: true } }
    },
  },
]
