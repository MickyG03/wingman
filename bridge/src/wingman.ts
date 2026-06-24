// The bridge's brain: caches calendar + inbox, runs AI triage and briefings,
// turns voice requests into drafts/invites, and executes approved actions.

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import type {
  Briefing,
  CardItem,
  ChatContext,
  ChatReply,
  ChatTurn,
  PendingRef,
  DoneKind,
  DraftAction,
  EmailDetail,
  ErrorCode,
  HomeData,
  InboxItem,
  InviteAction,
  Meeting,
  Person,
  VoiceContext,
  VoiceExchange,
  VoiceResult,
} from '../../shared/protocol.ts'
import type { ToolHost } from './agent/types.ts'
import { firstName } from './ai/prompts.ts'
import type { Ai, EmailText, TriageResult, UserContext } from './ai/types.ts'
import { config } from './config.ts'
import { ContactIndex } from './contacts.ts'
import type { DraftMeta, DraftStore } from './drafts.ts'
import { runAuthFlow, type GoogleAuth } from './google/auth.ts'
import { buildMime, replySubject } from './google/mime.ts'
import { AuthNeededError, type CalendarPort, type ContactsPort, type MailPort, type RawEmail } from './google/ports.ts'

export class WingmanError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'WingmanError'
  }
}

interface PendingResolution {
  id: string
  kind: 'email' | 'invite' | 'redo'
  draftId?: string // for redo: the pending draft being revised
  transcript: string
  names: string[] // still to resolve, in order
  resolved: Person[]
  candidates: Person[] // for the name currently being asked about
  expires: number
  email?: { subject: string; body: string }
  invite?: { title: string; start: string; end: string; location?: string }
}

export interface WingmanDeps {
  mail: MailPort
  calendar: CalendarPort
  ai: Ai
  drafts: DraftStore
  googleAuth: GoogleAuth | null // null in fake mode
  people: ContactsPort | null // null in fake mode
  contactsFile: string | null
}

/** Pieces of Wingman the chat agent's tools reuse. */
export interface AgentLike {
  ask(text: string, ctx: ChatContext, pick: CardItem | undefined, progress: (label: string) => void): Promise<ChatReply>
  act(id: string, approve: boolean): Promise<{ kind: DoneKind; message: string }>
  history(): ChatTurn[]
  reset(): void
  pendingActions(): PendingRef[]
  note(text: string): void
}

const PENDING_TTL_MS = 10 * 60_000
const INBOX_FETCH = 25
const INBOX_SHOW = 20
const CONTACTS_MAX_AGE_MS = 12 * 3_600_000
const RECENT_KEEP = 6

export class Wingman extends EventEmitter {
  private readonly contacts = new ContactIndex()

  /** Shared with the chat agent for name resolution. */
  get contactIndex(): ContactIndex {
    return this.contacts
  }
  private self: Person = { name: config.userName || 'Me', email: '' }
  private events: Meeting[] = []
  private inbox: RawEmail[] = []
  private readonly triage = new Map<string, TriageResult>()
  private readonly briefings = new Map<string, Briefing>()
  private readonly pending = new Map<string, PendingResolution>()
  private readonly history: VoiceExchange[] = []
  private loaded: Promise<void> | null = null
  private signature = ''
  private triaging = false

  constructor(private readonly d: WingmanDeps) {
    super()
    d.googleAuth?.on('needed', () => this.emit('auth.needed'))
    d.googleAuth?.on('restored', () => {
      this.loaded = this.load()
      // A new sign-in may have granted the contacts scope: rebuild the index.
      this.loaded.then(() => {
        this.emit('changed', 'home')
        void this.loadContacts()
      }).catch(() => {})
    })
  }

  get authNeeded(): boolean {
    return this.d.googleAuth?.needed ?? false
  }

  userContext = (): UserContext => ({ name: this.self.name, email: this.self.email })

  start() {
    this.loaded = this.load()
    this.loaded.catch(() => {})
    // AuthNeededError is already surfaced via googleAuth's 'needed' event.
    setInterval(() => this.refresh().catch(() => {}), config.pollMs).unref()
  }

  /** Profile + contacts + first refresh. Rejects with AuthNeededError when signed out. */
  private async load() {
    if (this.authNeeded) throw new AuthNeededError()
    const profile = await this.d.mail.profile()
    this.self = { name: config.userName || profile.name || profile.email.split('@')[0], email: profile.email }
    this.contacts.setSelf(profile.email)
    const cachedAt = this.loadContactsCache()
    await this.refresh()
    if (Date.now() - cachedAt > CONTACTS_MAX_AGE_MS) void this.loadContacts()
  }

  /** Loads the saved contact index; returns when it was saved (0 if none). */
  private loadContactsCache(): number {
    const file = this.d.contactsFile
    if (!file || !fs.existsSync(file)) return 0
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { savedAt: number; entries: Parameters<ContactIndex['load']>[0] }
      this.contacts.load(data.entries ?? [])
      console.log(`[wingman] contact index: ${this.contacts.size} people (cached)`)
      return data.savedAt ?? 0
    } catch {
      return 0
    }
  }

  private saveContactsCache() {
    const file = this.d.contactsFile
    if (!file) return
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ savedAt: Date.now(), entries: this.contacts.toJSON() }))
  }

  private async ready() {
    if (!this.loaded) this.start()
    try {
      await this.loaded
    } catch (err) {
      // Retry on the next request rather than caching the failure forever.
      this.loaded = null
      throw err
    }
  }

  /**
   * Builds the contact index: Google Contacts + "Other contacts" when that
   * scope was granted, else (or additionally) headers of recent mail.
   */
  private async loadContacts(attempt = 1) {
    if (this.d.people) {
      try {
        const now = Date.now()
        for (const p of await this.d.people.list()) this.contacts.add(p, now - 30 * 86_400_000)
        this.saveContactsCache()
        console.log(`[wingman] contact index: ${this.contacts.size} people (Google Contacts)`)
        return
      } catch (err) {
        if (err instanceof AuthNeededError) return
        const msg = (err as Error).message
        console.warn(
          /insufficient|scope|permission/i.test(msg)
            ? '[wingman] contacts permission not granted yet: run `npm run auth` again to allow it. Using recent mail instead.'
            : `[wingman] Google Contacts failed (${msg}); using recent mail instead.`,
        )
      }
    }
    try {
      const headers = await this.d.mail.recentHeaders(150)
      for (const m of headers) this.contacts.addMessage(m.id, [m.from, ...m.to, ...m.cc], Date.parse(m.date))
      this.saveContactsCache()
      console.log(`[wingman] contact index: ${this.contacts.size} people (recent mail)`)
    } catch (err) {
      const msg = (err as Error).message
      if (/quota|rate limit/i.test(msg) && attempt < 4) {
        console.warn(`[wingman] Gmail quota hit while indexing contacts; retrying in ${90 * attempt}s`)
        setTimeout(() => void this.loadContacts(attempt + 1), 90_000 * attempt).unref()
      } else {
        console.warn(`[wingman] contacts failed: ${msg}`)
      }
    }
  }

  /** Learns correspondents from data we already fetched (no extra API calls). */
  private learnContacts() {
    let added = false
    for (const m of this.inbox) added = this.contacts.addMessage(m.id, [m.from, ...m.to, ...m.cc], Date.parse(m.date)) || added
    for (const e of this.events) added = this.contacts.addMessage(`event:${e.id}`, e.attendees, Date.parse(e.start)) || added
    if (added) this.saveContactsCache()
  }

  async refresh() {
    if (this.authNeeded) return
    try {
      const [events, inbox] = await Promise.all([this.d.calendar.upcoming(7), this.d.mail.listInbox(INBOX_FETCH)])
      this.events = events
      this.inbox = inbox
      this.learnContacts()
      const sig = JSON.stringify([events.map(e => [e.id, e.start]), inbox.map(m => [m.id, m.unread])])
      if (sig !== this.signature) {
        this.signature = sig
        this.emit('changed', 'home')
        this.emit('changed', 'inbox')
      }
      void this.triageMissing()
    } catch (err) {
      if (err instanceof AuthNeededError) throw err
      console.warn(`[wingman] refresh failed: ${(err as Error).message}`)
    }
  }

  private async triageMissing() {
    if (this.triaging) return
    const todo = this.inbox.filter(m => !this.triage.has(m.id)).slice(0, 20)
    if (todo.length === 0) return
    this.triaging = true
    try {
      const results = await this.d.ai.triage(
        todo.map(m => ({ id: m.id, from: m.from, subject: m.subject, snippet: m.snippet, date: m.date })),
      )
      for (const r of results) this.triage.set(r.id, r)
      this.emit('changed', 'inbox')
      this.emit('changed', 'home')
    } catch (err) {
      console.warn(`[wingman] triage failed: ${(err as Error).message}`)
    } finally {
      this.triaging = false
    }
  }

  private triageOf(m: RawEmail): TriageResult {
    return (
      this.triage.get(m.id) ?? {
        id: m.id,
        important: false,
        category: 'fyi',
        summary: m.snippet.slice(0, 70),
        suggestions: [],
      }
    )
  }

  private toItem(m: RawEmail): InboxItem {
    const t = this.triageOf(m)
    return {
      id: m.id,
      threadId: m.threadId,
      from: m.from,
      subject: m.subject,
      summary: t.summary,
      category: t.category,
      important: t.important,
      unread: m.unread,
      receivedAt: m.date,
    }
  }

  // ── Reads ──────────────────────────────────────────────────────────────

  async home(): Promise<HomeData> {
    await this.ready()
    const now = Date.now()
    const timed = this.events.filter(e => !e.allDay && Date.parse(e.end) > now)
    return {
      nextMeeting: timed[0] && this.present(timed[0]),
      upcoming: timed.slice(1, 4).map(m => this.present(m)),
      unread: this.inbox.filter(m => m.unread).length,
      importantUnread: this.inbox.filter(m => m.unread && this.triage.get(m.id)?.important).length,
      pendingDrafts: this.d.drafts.pendingDrafts().slice(0, 3),
      pendingInvites: this.d.drafts.pendingInvites().slice(0, 3),
      pendingActions: this.agent?.pendingActions() ?? [],
      recent: this.recentExchanges(),
    }
  }

  async inboxItems(): Promise<InboxItem[]> {
    await this.ready()
    const rank = (m: RawEmail) => (m.unread ? (this.triage.get(m.id)?.important ? 0 : 1) : 2)
    return [...this.inbox]
      .sort((a, b) => rank(a) - rank(b) || b.date.localeCompare(a.date))
      .slice(0, INBOX_SHOW)
      .map(m => this.toItem(m))
  }

  async email(id: string): Promise<EmailDetail> {
    await this.ready()
    const raw = await this.d.mail.getEmail(id)
    if (!this.triage.has(id)) {
      try {
        const [t] = await this.d.ai.triage([{ id, from: raw.from, subject: raw.subject, snippet: raw.snippet, date: raw.date }])
        if (t) this.triage.set(id, t)
      } catch (err) {
        console.warn(`[wingman] triage of ${id} failed: ${(err as Error).message}`)
      }
    }
    if (raw.unread) {
      const cached = this.inbox.find(m => m.id === id)
      if (cached) cached.unread = false
      this.d.mail.markRead(id).then(
        () => this.emit('changed', 'home'),
        err => console.warn(`[wingman] markRead failed: ${(err as Error).message}`),
      )
    }
    const t = this.triageOf(raw)
    return { ...this.toItem(raw), unread: false, to: raw.to, cc: raw.cc, bodyText: raw.bodyText, suggestions: t.suggestions }
  }

  private async findMeeting(id: string): Promise<Meeting> {
    const m = this.events.find(e => e.id === id) ?? (await this.d.calendar.get(id))
    if (!m) throw new WingmanError('NOT_FOUND', 'Meeting not found')
    return m
  }

  private others(people: Person[]): Person[] {
    const self = this.self.email.toLowerCase()
    return people.filter(p => p.email.toLowerCase() !== self)
  }

  /** Meetings as shown on the glasses: without the user in the attendee list. */
  private present(m: Meeting): Meeting {
    return { ...m, attendees: this.others(m.attendees) }
  }

  async meeting(eventId: string): Promise<{ meeting: Meeting; briefing: Briefing }> {
    await this.ready()
    const meeting = await this.findMeeting(eventId)
    let briefing = this.briefings.get(eventId)
    if (!briefing) {
      try {
        const related = await this.d.mail.searchWith(this.others(meeting.attendees).map(p => p.email), 5)
        briefing = await this.d.ai.briefing(meeting, related)
        this.briefings.set(eventId, briefing)
      } catch (err) {
        if (err instanceof AuthNeededError) throw err
        console.warn(`[wingman] briefing failed: ${(err as Error).message}`)
        briefing = { purpose: meeting.description?.slice(0, 100) || meeting.title, lastThread: '', points: [] }
      }
    }
    return { meeting: this.present(meeting), briefing }
  }

  // ── Chat agent ─────────────────────────────────────────────────────────

  private agent: AgentLike | null = null

  attachAgent(agent: AgentLike) {
    this.agent = agent
  }

  private requireAgent(): AgentLike {
    if (!this.agent) throw new WingmanError('INTERNAL', 'Chat agent is not configured')
    return this.agent
  }

  /** What the agent's tools borrow from Wingman. */
  readonly host: ToolHost = {
    emailDetail: async id => {
      const e = await this.email(id)
      return { subject: e.subject, from: e.from, bodyText: e.bodyText, suggestions: e.suggestions }
    },
    replyDraft: async (emailId, body) => {
      await this.ready()
      const raw = await this.d.mail.getEmail(emailId)
      const d = this.replyDraft(raw, { subject: '', body })
      return { id: d.id, to: d.to, subject: d.subject }
    },
    meetingBriefing: async eventId => {
      const { meeting, briefing } = await this.meeting(eventId)
      return { title: meeting.title, ...briefing }
    },
  }

  async chat(text: string, ctx: ChatContext, pick: CardItem | undefined, progress: (label: string) => void): Promise<ChatReply> {
    await this.ready()
    const agent = this.requireAgent()
    const heard = text.trim()
    if (!heard) {
      return { turnId: randomUUID(), text: 'No speech was heard. Check the Even app has microphone permission, then hold and speak.' }
    }
    try {
      const reply = await agent.ask(heard, ctx, pick, progress)
      this.record({ kind: 'chat', ctx }, heard, reply.pending ? `chat:${reply.pending.kind}` : 'chat', reply.text)
      this.emit('changed', 'home')
      return reply
    } catch (err) {
      this.record({ kind: 'chat', ctx }, heard, 'error', (err as Error).message)
      throw err
    }
  }

  chatHistory(): ChatTurn[] {
    return this.requireAgent().history()
  }

  chatReset() {
    this.requireAgent().reset()
  }

  async actionAct(id: string, approve: boolean): Promise<{ kind: DoneKind; message: string }> {
    const result = await this.requireAgent().act(id, approve)
    this.emit('changed', 'home')
    return result
  }

  // ── Voice → drafts / invites ───────────────────────────────────────────

  /** Last few voice interactions, newest first, for the glasses "Recent" screen and as AI context. */
  recentExchanges(limit = RECENT_KEEP): VoiceExchange[] {
    return this.history.slice(0, limit)
  }

  private record(ctx: VoiceContext, heard: string, outcome: string, detail: string) {
    this.history.unshift({ id: randomUUID(), at: new Date().toISOString(), ctx: ctx.kind, heard, outcome, detail })
    this.history.length = Math.min(this.history.length, RECENT_KEEP)
    this.emit('changed', 'home')
  }

  async processVoice(ctx: VoiceContext, transcript: string): Promise<VoiceResult> {
    const text = transcript.trim()
    try {
      const result = await this.processVoiceInner(ctx, text)
      const detail =
        result.kind === 'draft'
          ? `Draft: ${result.draft.subject}`
          : result.kind === 'invite'
            ? `Invite: ${result.invite.title}`
            : result.kind === 'contacts'
              ? `Which "${result.query}"?`
              : result.hint
      this.record(ctx, text, result.kind, detail)
      if (result.kind === 'unknown') console.log(`[voice] unknown: ${result.hint}`)
      return result
    } catch (err) {
      this.record(ctx, text, 'error', (err as Error).message)
      throw err
    }
  }

  private async processVoiceInner(ctx: VoiceContext, text: string): Promise<VoiceResult> {
    await this.ready()
    if (!text) {
      return {
        kind: 'unknown',
        hint: 'No speech was heard. Check the Even app has microphone permission, then hold and speak.',
        transcript: text,
      }
    }

    switch (ctx.kind) {
      case 'chat':
        throw new WingmanError('BAD_REQUEST', 'Chat requests go through chat()')
      case 'home':
        return this.fromIntent(text)
      case 'reply': {
        const raw = await this.d.mail.getEmail(ctx.emailId)
        const thread = await this.d.mail.getThread(raw.threadId).catch(() => [raw])
        return { kind: 'draft', draft: this.replyDraft(raw, await this.d.ai.reply(thread.length ? thread : [raw], text)) }
      }
      case 'followup': {
        const meeting = await this.findMeeting(ctx.eventId)
        const to = this.others(meeting.attendees)
        if (to.length === 0) return { kind: 'unknown', hint: 'This meeting has no other attendees to email.', transcript: text }
        const t = await this.d.ai.followup(meeting, text)
        return { kind: 'draft', draft: this.d.drafts.createDraft({ kind: 'followup', to, cc: [], subject: t.subject, body: t.body }) }
      }
      case 'redo': {
        const stored = this.d.drafts.getDraft(ctx.draftId)
        if (!stored || stored.draft.status !== 'pending') throw new WingmanError('NOT_FOUND', 'That draft is no longer open')
        const t = await this.d.ai.redo(stored.draft, text)
        const revised = this.d.drafts.revise(ctx.draftId, stored.draft.kind === 'new' ? t.subject : stored.draft.subject, t.body)
        if (!revised) throw new WingmanError('NOT_FOUND', 'That draft is no longer open')
        return { kind: 'draft', draft: revised }
      }
    }
  }

  private replyDraft(raw: RawEmail, t: EmailText) {
    const fromSelf = raw.from.email.toLowerCase() === this.self.email.toLowerCase()
    const meta: DraftMeta = { threadId: raw.threadId, inReplyTo: raw.messageId, references: raw.references }
    return this.d.drafts.createDraft(
      { kind: 'reply', to: fromSelf ? raw.to : [raw.from], cc: [], subject: replySubject(raw.subject), body: t.body, replyToId: raw.id },
      meta,
    )
  }

  private async fromIntent(transcript: string): Promise<VoiceResult> {
    const intent = await this.d.ai.homeIntent(transcript, this.contacts.topNames(60))
    if (intent.intent === 'unknown') return { kind: 'unknown', hint: intent.hint, transcript }
    const base = { id: randomUUID(), transcript, resolved: [], candidates: [], expires: Date.now() + PENDING_TTL_MS }
    if (intent.intent === 'email') {
      return this.resolve({ ...base, kind: 'email', names: intent.recipients, email: { subject: intent.subject, body: intent.body } })
    }
    const start = new Date(intent.startISO)
    return this.resolve({
      ...base,
      kind: 'invite',
      names: intent.attendees,
      invite: {
        title: intent.title,
        start: start.toISOString(),
        end: new Date(start.getTime() + intent.durationMin * 60_000).toISOString(),
        location: intent.location,
      },
    })
  }

  /** Resolves spoken names one at a time, asking the user when a name is ambiguous. */
  private resolve(p: PendingResolution): VoiceResult {
    while (p.names.length > 0) {
      const name = p.names[0]
      const m = this.contacts.match(name)
      if (m.kind === 'many') {
        p.candidates = m.candidates
        this.pending.set(p.id, p)
        return { kind: 'contacts', pendingId: p.id, query: name, candidates: m.candidates }
      }
      if (m.kind === 'none') {
        this.pending.delete(p.id)
        return { kind: 'unknown', hint: `No contact named "${name}" in recent email. Try saying their email address.`, transcript: p.transcript }
      }
      if (!p.resolved.some(r => r.email === m.person.email)) p.resolved.push(m.person)
      p.names.shift()
    }
    this.pending.delete(p.id)
    if (p.kind === 'email' && p.email) {
      return {
        kind: 'draft',
        draft: this.d.drafts.createDraft({ kind: 'new', to: p.resolved, cc: [], subject: p.email.subject, body: p.email.body }),
      }
    }
    const inv = p.invite!
    return { kind: 'invite', invite: this.d.drafts.createInvite({ ...inv, attendees: p.resolved }) }
  }

  pickContact(pendingId: string, index: number): VoiceResult {
    for (const [id, p] of this.pending) if (p.expires < Date.now()) this.pending.delete(id)
    const p = this.pending.get(pendingId)
    const person = p?.candidates[index]
    if (!p || !person) throw new WingmanError('NOT_FOUND', 'That choice expired. Try again.')
    if (!p.resolved.some(r => r.email === person.email)) p.resolved.push(person)
    p.names.shift()
    return this.resolve(p)
  }

  async fromSuggestion(emailId: string, index: number): Promise<VoiceResult> {
    const detail = await this.email(emailId)
    const s = detail.suggestions[index]
    if (!s) throw new WingmanError('NOT_FOUND', 'That suggestion is gone')
    const raw = await this.d.mail.getEmail(emailId)
    return { kind: 'draft', draft: this.replyDraft(raw, { subject: '', body: s.text }) }
  }

  draftResult(draftId: string): VoiceResult {
    const d = this.d.drafts.getDraft(draftId)
    if (d?.draft.status === 'pending') return { kind: 'draft', draft: d.draft }
    const i = this.d.drafts.getInvite(draftId)
    if (i?.status === 'pending') return { kind: 'invite', invite: i }
    throw new WingmanError('NOT_FOUND', 'That draft is no longer open')
  }

  // ── Approved actions ───────────────────────────────────────────────────

  async draftAct(draftId: string, action: DraftAction): Promise<{ kind: DoneKind; message: string }> {
    const done = action === 'send' ? 'sent' : action === 'save' ? 'saved' : 'discarded'
    const outcome = await this.d.drafts.completeDraft(draftId, done, async ({ draft, meta }) => {
      if (action === 'discard') return
      const raw = buildMime({
        to: draft.to,
        cc: draft.cc,
        subject: draft.subject,
        body: draft.body,
        inReplyTo: meta.inReplyTo,
        references: meta.references,
      })
      if (action === 'send') await this.d.mail.send(raw, meta.threadId)
      else await this.d.mail.createDraft(raw, meta.threadId)
    })
    if (!outcome.ok) throw new WingmanError('NOT_FOUND', outcome.reason)
    this.emit('changed', 'home')
    const d = outcome.item
    const kind = d.status as DoneKind
    if (outcome.already) return { kind, message: `Already ${d.status}` }
    const names = d.to.map(p => firstName(p.name)).join(', ')
    console.log(`[wingman] draft ${d.id} ${d.status}${d.status === 'sent' ? ` to ${d.to.length} recipient(s)` : ''}`)
    return {
      kind,
      message: kind === 'sent' ? `Sent to ${names}` : kind === 'saved' ? 'Saved to Gmail drafts' : 'Draft discarded',
    }
  }

  async inviteAct(inviteId: string, action: InviteAction): Promise<{ kind: DoneKind; message: string }> {
    const outcome = await this.d.drafts.completeInvite(inviteId, action === 'create' ? 'created' : 'discarded', async i => {
      if (action === 'create') await this.d.calendar.create(i)
    })
    if (!outcome.ok) throw new WingmanError('NOT_FOUND', outcome.reason)
    this.emit('changed', 'home')
    const i = outcome.item
    const kind = i.status as DoneKind
    if (outcome.already) return { kind, message: `Already ${i.status}` }
    if (kind === 'created') void this.refresh()
    return {
      kind,
      message: kind === 'created' ? `Invite sent: ${i.title}` : 'Invite discarded',
    }
  }

  startAuth() {
    if (!this.d.googleAuth) throw new WingmanError('BAD_REQUEST', 'Running with fake Google data')
    runAuthFlow().then(
      email => console.log(`[google] signed in as ${email}`),
      err => console.warn(`[google] sign-in failed: ${(err as Error).message}`),
    )
  }
}
