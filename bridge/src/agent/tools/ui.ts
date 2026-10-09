// Tools with no side effects that put something on the glasses.

import type { CardItem } from '../../../../shared/protocol.ts'
import { str, strs, ToolError, type AgentTool } from '../types.ts'
import { eventItem } from './calendar.ts'
import { emailItem } from './email.ts'

const KINDS = new Set<CardItem['kind']>(['email', 'event', 'file', 'contact', 'row', 'text'])

export const uiTools: AgentTool[] = [
  {
    name: 'show_inbox',
    description: 'Show the inbox list on the glasses (recent emails, unread first).',
    parameters: { type: 'object', properties: {} },
    async run(_args, ctx) {
      const emails = await ctx.mail.listInbox(10)
      const sorted = [...emails].sort((a, b) => Number(b.unread) - Number(a.unread) || b.date.localeCompare(a.date))
      return { forModel: { count: sorted.length, emails: sorted.map(m => ({ id: m.id, from: m.from.name, subject: m.subject, unread: m.unread })) }, card: { kind: 'list', title: 'Inbox', items: sorted.map(emailItem) } }
    },
  },
  {
    name: 'show_meeting',
    description: 'Show a meeting with its briefing (purpose, last email thread, open points).',
    parameters: { type: 'object', properties: { eventId: { type: 'string' } }, required: ['eventId'] },
    progress: 'Preparing briefing...',
    async run(args, ctx) {
      const id = str(args.eventId)
      if (!ctx.known(id)) throw new ToolError('Unknown event id. List events first.')
      const e = await ctx.calendar.get(id)
      if (!e) throw new ToolError('Event not found')
      const b = await ctx.host.meetingBriefing(id)
      return { forModel: { id, title: e.title, start: e.start, briefing: b }, card: { kind: 'list', title: 'Meeting', items: [eventItem(e)] } }
    },
  },
  {
    name: 'show_list',
    description: 'Show a short list on the glasses (e.g. options, steps, action items). Items are plain text unless they refer to known ids.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        items: { type: 'array', items: { type: 'string' }, description: 'Up to 8 short lines' },
      },
      required: ['title', 'items'],
    },
    async run(args) {
      const items = strs(args.items).slice(0, 8)
      return { forModel: { shown: items.length }, card: { kind: 'list', title: str(args.title, 'List'), items: items.map((t, i) => ({ id: `text-${i}`, kind: 'text', title: t })) } }
    },
  },
  {
    name: 'show_text',
    description: 'Show a longer text on the glasses (a summary, a quote from a document, directions). The user swipes through pages.',
    parameters: { type: 'object', properties: { title: { type: 'string' }, text: { type: 'string' } }, required: ['title', 'text'] },
    async run(args) {
      const text = str(args.text)
      if (!text) throw new ToolError('text is required')
      return { forModel: { shown: true }, card: { kind: 'text', title: str(args.title, 'Note'), text: text.slice(0, 4000) } }
    },
  },
]

export const isCardKind = (k: string): k is CardItem['kind'] => KINDS.has(k as CardItem['kind'])
