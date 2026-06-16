import type { Card, CardItem, Person } from '../../../../shared/protocol.ts'
import { firstName } from '../../ai/prompts.ts'
import type { RawEmail } from '../../google/ports.ts'
import { emailBody, emailRow, LIST_MAX } from '../summarize.ts'
import { num, str, strs, ToolError, type AgentTool, type ToolContext } from '../types.ts'

const when = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })

export function emailItem(m: RawEmail): CardItem {
  return { id: m.id, kind: 'email', title: `${firstName(m.from.name)}: ${m.subject}`, detail: `${when(m.date)}${m.unread ? ' - unread' : ''}` }
}

/** Resolves spoken names/addresses; returns candidates when one is ambiguous. */
export function resolvePeople(names: string[], ctx: ToolContext): { people: Person[] } | { ambiguous: string; candidates: Person[] } | { unknown: string } {
  const people: Person[] = []
  for (const name of names) {
    const m = ctx.contacts.match(name)
    if (m.kind === 'many') return { ambiguous: name, candidates: m.candidates }
    if (m.kind === 'none') return { unknown: name }
    if (!people.some(p => p.email === m.person.email)) people.push(m.person)
  }
  return { people }
}

function draftCard(d: { id: string; to: Person[]; subject: string; body: string }): Card {
  return { kind: 'draft', draft: { id: d.id, kind: 'new', to: d.to, cc: [], subject: d.subject, body: d.body, status: 'pending', createdAt: new Date().toISOString() } }
}

export const emailTools: AgentTool[] = [
  {
    name: 'search_emails',
    description: 'Search the inbox. Returns up to 10 emails with ids. Use for "unread", "from X", "about Y", "last week".',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search syntax, e.g. "from:sam", "subject:invoice", "newer_than:7d". Empty = recent inbox.' },
        unreadOnly: { type: 'boolean' },
        max: { type: 'integer', description: '1-10' },
      },
    },
    progress: 'Searching email...',
    async run(args, ctx) {
      const q = [str(args.query), args.unreadOnly ? 'is:unread' : '', 'in:inbox'].filter(Boolean).join(' ')
      const max = Math.min(LIST_MAX, Math.max(1, num(args.max, 10)))
      const emails = await ctx.mail.search(q, max)
      return {
        forModel: { count: emails.length, emails: emails.map(emailRow) },
        card: { kind: 'list', title: args.unreadOnly ? 'Unread' : str(args.query) ? `Emails: ${str(args.query)}` : 'Recent emails', items: emails.map(emailItem) },
      }
    },
  },
  {
    name: 'read_email',
    description: 'Read one email in full (marks it read). Use an id from search_emails or the shown list.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    progress: 'Opening email...',
    async run(args, ctx) {
      const id = str(args.id)
      if (!ctx.known(id)) throw new ToolError('Unknown email id. Search first.')
      const raw = await ctx.mail.getEmail(id)
      if (raw.unread) await ctx.mail.markRead(id)
      const detail = await ctx.host.emailDetail(id)
      return {
        forModel: { ...emailBody({ ...raw, bodyText: detail.bodyText }), suggestedReplies: detail.suggestions.map(s => s.label) },
        card: { kind: 'list', title: 'Email', items: [emailItem({ ...raw, unread: false })] },
      }
    },
  },
  {
    name: 'draft_email',
    description: 'Prepare a NEW email for the user to approve. Recipients are names from contacts or full addresses. You write the subject and the complete body.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'array', items: { type: 'string' } },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['to', 'subject', 'body'],
    },
    progress: 'Drafting email...',
    async prepare(args, ctx) {
      const r = resolvePeople(strs(args.to), ctx)
      if ('ambiguous' in r) {
        return {
          forModel: { needsChoice: r.ambiguous, candidates: r.candidates },
          card: { kind: 'list', title: `Which "${r.ambiguous}"?`, items: r.candidates.map(c => ({ id: c.email, kind: 'contact', title: c.name, detail: c.email })) },
        }
      }
      if ('unknown' in r) return { forModel: { error: `No contact named "${r.unknown}". Ask the user for the address, or use search_contacts.` } }
      const body = str(args.body)
      if (!body) throw new ToolError('body is required')
      const draft = ctx.drafts.createDraft({ kind: 'new', to: r.people, cc: [], subject: str(args.subject, '(no subject)'), body })
      return {
        forModel: { status: 'awaiting_approval', draftId: draft.id, to: r.people.map(p => p.email) },
        card: { kind: 'draft', draft },
        pending: { id: draft.id, kind: 'draft', label: `Send to ${r.people.map(p => firstName(p.name)).join(', ')}` },
      }
    },
    async run() {
      throw new ToolError('Drafts are sent through approval')
    },
  },
  {
    name: 'draft_reply',
    description: 'Prepare a reply to an email for the user to approve. You write the complete reply body based on the email and what the user asked.',
    parameters: { type: 'object', properties: { emailId: { type: 'string' }, body: { type: 'string' } }, required: ['emailId', 'body'] },
    progress: 'Drafting reply...',
    async prepare(args, ctx) {
      const id = str(args.emailId)
      if (!ctx.known(id)) throw new ToolError('Unknown email id. Open or search the email first.')
      const body = str(args.body)
      if (!body) throw new ToolError('body is required')
      const d = await ctx.host.replyDraft(id, body)
      return {
        forModel: { status: 'awaiting_approval', draftId: d.id, to: d.to.map(p => p.email), subject: d.subject },
        card: draftCard({ ...d, body }),
        pending: { id: d.id, kind: 'draft', label: `Send to ${d.to.map(p => firstName(p.name)).join(', ')}` },
      }
    },
    async run() {
      throw new ToolError('Drafts are sent through approval')
    },
  },
]
