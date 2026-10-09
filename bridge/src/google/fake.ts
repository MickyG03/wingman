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

  async update(id: string, patch: EventPatch) {
    const e = this.events.find(x => x.id === id)
    if (!e) throw new Error('Event not found')
    if (patch.title) e.title = patch.title
    if (patch.start) e.start = patch.start
    if (patch.end) e.end = patch.end
    if (patch.location !== undefined) e.location = patch.location
    for (const a of patch.addAttendees ?? []) if (!e.attendees.some(x => x.email === a.email)) e.attendees.push(a)
    console.log(`[fake-calendar] UPDATE (not really) "${e.title}"`)
    return { ...e }
  }

  async remove(id: string) {
    const i = this.events.findIndex(x => x.id === id)
    if (i < 0) throw new Error('Event not found')
    console.log(`[fake-calendar] DELETE (not really) "${this.events[i].title}"`)
    this.events.splice(i, 1)
  }
}

// ── Drive / Docs / Sheets ───────────────────────────────────────────────

interface FakeDoc {
  file: DriveFile
  text: string
}
interface FakeSheet {
  file: DriveFile
  tabs: Record<string, string[][]>
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()

export class FakeWorkspace implements DrivePort, DocsPort, SheetsPort {
  private readonly docs = new Map<string, FakeDoc>()
  private readonly sheets = new Map<string, FakeSheet>()
  private readonly others: DriveFile[] = []
  private seq = 0

  constructor() {
    this.docs.set('doc-onboarding', {
      file: { id: 'doc-onboarding', name: 'Onboarding v2 - launch plan', mimeType: MIME.doc, modifiedAt: daysAgo(1), owner: 'Priya Sharma' },
      text: [
        'Onboarding v2 launch plan',
        '',
        'Goal: ship the redesigned onboarding flow to all new users.',
        'Options: launch Oct 20 without analytics hooks, or Oct 27 with them.',
        'Open questions',
        '- Who owns the launch checklist?',
        '- Do we need a support macro for the new flow?',
        'Decision: TBD at the design review.',
      ].join('\n'),
    })
    this.docs.set('doc-vendor', {
      file: { id: 'doc-vendor', name: 'VendorCo contract notes', mimeType: MIME.doc, modifiedAt: daysAgo(6), owner: 'Me' },
      text: 'Renewal due Oct 31. Current: $45,000/yr. Proposed: $48,000/yr (+6%) or $46,500/yr on a 2-year term.',
    })
    this.sheets.set('sheet-offsite', {
      file: { id: 'sheet-offsite', name: 'Offsite budget', mimeType: MIME.sheet, modifiedAt: daysAgo(2), owner: 'Jordan Kim' },
      tabs: {
        Venues: [
          ['Venue', 'Cost', 'Distance', 'Notes'],
          ['Lakeside lodge', '18000', '2h drive', 'Great views'],
          ['Downtown loft', '9000', 'walkable', 'Cheapest'],
        ],
        Totals: [['Item', 'Amount'], ['Venue', '9000'], ['Travel', '3200']],
      },
    })
    this.others.push({ id: 'pdf-q3', name: 'Q3 board deck.pdf', mimeType: 'application/pdf', modifiedAt: daysAgo(10), owner: 'Sam Lee' })
  }

  private all(): DriveFile[] {
    return [...[...this.docs.values()].map(d => d.file), ...[...this.sheets.values()].map(s => s.file), ...this.others]
  }

  // DrivePort
  async search(query: string, mimeType: string | undefined, max: number) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const text = (f: DriveFile) => `${f.name} ${this.docs.get(f.id)?.text ?? ''}`.toLowerCase()
    return this.all()
      .filter(f => (!mimeType || f.mimeType === mimeType) && words.every(w => text(f).includes(w)))
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
      .slice(0, max)
  }
  async recent(max: number) {
    return this.all().sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, max)
  }
  async get(id: string) {
    return this.all().find(f => f.id === id) ?? null
  }
  async exportText(id: string) {
    const d = this.docs.get(id)
    if (d) return d.text
    const s = this.sheets.get(id)
    if (s) return Object.values(s.tabs)[0].map(r => r.join('\t')).join('\n')
    return '(application/pdf file; no text preview available)'
  }
  async createDoc(name: string, content: string) {
    const id = `doc-new-${++this.seq}`
    const file = { id, name, mimeType: MIME.doc, modifiedAt: new Date().toISOString(), owner: 'Me' }
    this.docs.set(id, { file, text: content })
    console.log(`[fake-drive] CREATE DOC (not really) "${name}"`)
    return file
  }
  async createSheet(name: string, rows: string[][]) {
    const id = `sheet-new-${++this.seq}`
    const file = { id, name, mimeType: MIME.sheet, modifiedAt: new Date().toISOString(), owner: 'Me' }
    this.sheets.set(id, { file, tabs: { Sheet1: rows } })
    console.log(`[fake-drive] CREATE SHEET (not really) "${name}"`)
    return file
  }

  // DocsPort
  async readText(docId: string) {
    const d = this.docs.get(docId)
    if (!d) throw new Error('Document not found')
    return { title: d.file.name, text: d.text }
  }
  async appendText(docId: string, text: string) {
    const d = this.docs.get(docId)
    if (!d) throw new Error('Document not found')
    d.text += `\n${text}`
    console.log(`[fake-docs] APPEND (not really) to "${d.file.name}"`)
  }
  async replaceText(docId: string, find: string, replace: string) {
    const d = this.docs.get(docId)
    if (!d) throw new Error('Document not found')
    const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    const n = (d.text.match(re) ?? []).length
    d.text = d.text.replace(re, replace)
    console.log(`[fake-docs] REPLACE (not really) ${n}x in "${d.file.name}"`)
    return n
  }

  // SheetsPort
  async info(sheetId: string) {
    const s = this.sheets.get(sheetId)
    if (!s) throw new Error('Spreadsheet not found')
    return { title: s.file.name, sheets: Object.keys(s.tabs) }
  }
  async readRange(sheetId: string, range?: string) {
    const s = this.sheets.get(sheetId)
    if (!s) throw new Error('Spreadsheet not found')
    const tab = range?.split('!')[0]?.replace(/^'|'$/g, '') ?? Object.keys(s.tabs)[0]
    const values = s.tabs[tab] ?? Object.values(s.tabs)[0]
    return { range: `${tab}!A1:${String.fromCharCode(64 + Math.max(1, values[0]?.length ?? 1))}${values.length}`, values }
  }
  async appendRows(sheetId: string, sheet: string | undefined, rows: string[][]) {
    const s = this.sheets.get(sheetId)
    if (!s) throw new Error('Spreadsheet not found')
    const tab = sheet ?? Object.keys(s.tabs)[0]
    s.tabs[tab] = [...(s.tabs[tab] ?? []), ...rows]
    console.log(`[fake-sheets] APPEND (not really) ${rows.length} row(s) to "${s.file.name}"/${tab}`)
    return { range: `${tab}!A${s.tabs[tab].length - rows.length + 1}` }
  }
  async updateRange(sheetId: string, range: string, values: string[][]) {
    const s = this.sheets.get(sheetId)
    if (!s) throw new Error('Spreadsheet not found')
    const tab = range.split('!')[0]?.replace(/^'|'$/g, '')
    if (s.tabs[tab]) values.forEach((row, i) => (s.tabs[tab][i] = row))
    console.log(`[fake-sheets] UPDATE (not really) ${range} in "${s.file.name}"`)
    return { range }
  }
}
