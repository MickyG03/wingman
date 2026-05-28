// In-memory Gmail/Calendar for FAKE_GOOGLE=1. Nothing leaves the machine:
// sends, drafts and invites are only logged.

import type { InviteDraft, Meeting } from '../../../shared/protocol.ts'
import { buildEmails, buildMeetings, SELF } from './fixtures.ts'
import { MIME, type CalendarPort, type DocsPort, type DriveFile, type DrivePort, type EventPatch, type MailPort, type RawEmail, type SheetsPort } from './ports.ts'

function decodeSubject(raw: string): string {
  const text = Buffer.from(raw, 'base64url').toString('utf8')
  return /^Subject: (.*)$/m.exec(text)?.[1] ?? '(no subject)'
}

export class FakeMail implements MailPort {
  private readonly inbox: RawEmail[]
  private readonly all: RawEmail[]
  private seq = 0

  constructor(now = Date.now()) {
    const { inbox, other } = buildEmails(now)
    this.inbox = inbox
    this.all = [...inbox, ...other]
  }

  async profile() {
    return { email: SELF.email, name: SELF.name }
  }

  async listInbox(max: number) {
    return this.inbox.slice(0, max).map(m => ({ ...m, bodyText: '' }))
  }

  async getEmail(id: string) {
    const m = this.all.find(e => e.id === id)
    if (!m) throw new Error(`No message ${id}`)
    return { ...m }
  }

  async getThread(threadId: string) {
    return this.all
      .filter(e => e.threadId === threadId)
      .sort((a, b) => a.date.localeCompare(b.date))
  }

  /** Supports the Gmail operators the agent uses: from:, to:, subject:, is:unread, plain words. */
  async search(query: string, max: number) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const matches = (m: RawEmail) =>
      terms.every(t => {
        if (t === 'is:unread') return m.unread
        if (t.startsWith('from:')) return `${m.from.name} ${m.from.email}`.toLowerCase().includes(t.slice(5))
        if (t.startsWith('to:')) return m.to.some(p => `${p.name} ${p.email}`.toLowerCase().includes(t.slice(3)))
        if (t.startsWith('subject:')) return m.subject.toLowerCase().includes(t.slice(8))
        if (t.startsWith('newer_than:') || t.startsWith('in:') || t.startsWith('-')) return true
        return `${m.subject} ${m.snippet} ${m.from.name}`.toLowerCase().includes(t.replace(/^"|"$/g, ''))
      })
    return this.all
      .filter(matches)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, max)
      .map(m => ({ ...m, bodyText: '' }))
  }

  async searchWith(emails: string[], max: number) {
    const set = new Set(emails.map(e => e.toLowerCase()))
    return this.all
      .filter(e => [e.from, ...e.to, ...e.cc].some(p => set.has(p.email.toLowerCase())))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, max)
  }

  async recentHeaders(max: number) {
    return this.all.slice(0, max).map(m => ({ ...m, bodyText: '' }))
  }

  async markRead(id: string) {
    const m = this.all.find(e => e.id === id)
    if (m) m.unread = false
  }

  async send(raw: string, threadId?: string) {
    console.log(`[fake-mail] SEND (not really) subject="${decodeSubject(raw)}" thread=${threadId ?? '-'}`)
    return { id: `fake-sent-${++this.seq}` }
  }

  async createDraft(raw: string, threadId?: string) {
    console.log(`[fake-mail] DRAFT saved (not really) subject="${decodeSubject(raw)}" thread=${threadId ?? '-'}`)
    return { id: `fake-draft-${++this.seq}` }
  }
}

export class FakeCalendar implements CalendarPort {
  private readonly events: Meeting[]

  constructor(now = Date.now()) {
    this.events = buildMeetings(now)
  }

  async upcoming(days: number) {
    const now = Date.now()
    const until = now + days * 86_400_000
    return this.events
      .filter(e => new Date(e.end).getTime() > now && new Date(e.start).getTime() < until)
      .sort((a, b) => a.start.localeCompare(b.start))
  }

  async between(fromIso: string, toIso: string, max: number) {
    return this.events
      .filter(e => e.end > fromIso && e.start < toIso)
      .sort((a, b) => a.start.localeCompare(b.start))
      .slice(0, max)
  }

  async get(id: string) {
    return this.events.find(e => e.id === id) ?? null
  }

  async create(invite: InviteDraft) {
    console.log(
      `[fake-calendar] CREATE (not really) "${invite.title}" ${invite.start} -> ${invite.end} ` +
        `with ${invite.attendees.map(a => a.email).join(', ') || 'nobody'}`,
    )
    return { id: `fake-evt-${invite.id}` }
  }
}
