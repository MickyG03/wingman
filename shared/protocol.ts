// Messages exchanged between the glasses plugin and the bridge over one
// WebSocket. JSON text frames carry these messages; binary frames carry mic
// PCM (s16le, 16 kHz, mono) and are only sent between voice.start and
// voice.stop.
//
// Imported by both packages, so this file must stay dependency-free.

export const PROTOCOL_VERSION = '0.3.0'

// ── Data ────────────────────────────────────────────────────────────────

export interface Person {
  name: string
  email: string
}

export interface Meeting {
  id: string
  title: string
  start: string // ISO 8601
  end: string
  allDay: boolean
  location?: string
  description?: string
  attendees: Person[]
}

export interface Briefing {
  purpose: string
  lastThread: string
  points: string[]
}

export type EmailCategory = 'action' | 'fyi' | 'newsletter' | 'notification'

export interface Suggestion {
  label: string
  text: string
}

export interface InboxItem {
  id: string
  threadId: string
  from: Person
  subject: string
  summary: string
  category: EmailCategory
  important: boolean
  unread: boolean
  receivedAt: string
}

export interface EmailDetail extends InboxItem {
  to: Person[]
  cc: Person[]
  bodyText: string
  suggestions: Suggestion[]
}

export type DraftKind = 'reply' | 'new' | 'followup'
export type ItemStatus = 'pending' | 'sending' | 'sent' | 'saved' | 'created' | 'discarded'

export interface Draft {
  id: string
  kind: DraftKind
  to: Person[]
  cc: Person[]
  subject: string
  body: string
  replyToId?: string
  status: ItemStatus
  createdAt: string
}

export interface InviteDraft {
  id: string
  title: string
  start: string
  end: string
  attendees: Person[]
  location?: string
  status: ItemStatus
  createdAt: string
}

/** One voice interaction, kept so the user can see what was heard and what came of it. */
export interface VoiceExchange {
  id: string
  at: string
  ctx: VoiceContext['kind']
  heard: string
  /** 'draft' | 'invite' | 'contacts' | 'unknown' | 'error' */
  outcome: string
  /** Short human-readable result: draft subject, invite title, hint or error. */
  detail: string
}

export interface HomeData {
  nextMeeting?: Meeting
  upcoming: Meeting[]
  unread: number
  importantUnread: number
  pendingDrafts: Draft[]
  pendingInvites: InviteDraft[]
  /** Agent-prepared actions (doc/sheet edits, event changes) awaiting approval. */
  pendingActions: PendingRef[]
  recent: VoiceExchange[]
}

// ── Chat agent ──────────────────────────────────────────────────────────

/** Where the user was when they asked, so "this one" can resolve. */
export interface ChatContext {
  screen: 'home' | 'inbox' | 'chat' | 'card' | 'other'
  focusEmailId?: string
}

export interface CardItem {
  id: string
  kind: 'email' | 'event' | 'file' | 'contact' | 'row' | 'text'
  title: string
  detail?: string
}

/** Something the agent attaches to a reply for the user to open. */
export type Card =
  | { kind: 'list'; title: string; items: CardItem[] }
  | { kind: 'text'; title: string; text: string }
  | { kind: 'draft'; draft: Draft }
  | { kind: 'invite'; invite: InviteDraft }
  | { kind: 'edit'; title: string; lines: string[] }

/** A side effect the agent prepared; nothing runs until the user approves it. */
export interface PendingRef {
  id: string
  kind: 'draft' | 'invite' | 'action'
  /** Button label, e.g. "Send to Sam", "Add 1 row to Budget", "Delete event". */
  label: string
}

export interface ChatReply {
  turnId: string
  text: string
  card?: Card
  pending?: PendingRef
}

export interface ChatTurn {
  id: string
  at: string
  heard: string
  reply: ChatReply
}

export type ActionDecision = 'approve' | 'discard'

export type VoiceContext =
  | { kind: 'home' }
  | { kind: 'chat'; ctx: ChatContext }
  | { kind: 'reply'; emailId: string }
  | { kind: 'followup'; eventId: string }
  | { kind: 'redo'; draftId: string }

export type VoiceResult =
  | { kind: 'draft'; draft: Draft }
  | { kind: 'invite'; invite: InviteDraft }
  | { kind: 'contacts'; pendingId: string; query: string; candidates: Person[] }
  | { kind: 'unknown'; hint: string; transcript: string }

export type DraftAction = 'send' | 'save' | 'discard'
export type InviteAction = 'create' | 'discard'

// ── Requests (plugin → bridge, answered with the same rid) ──────────────

export type Request =
  | { type: 'home.get' }
  | { type: 'inbox.get' }
  | { type: 'email.get'; id: string }
  | { type: 'meeting.get'; eventId: string }
  | { type: 'voice.start'; ctx: VoiceContext }
  | { type: 'voice.stop' }
  | { type: 'voice.cancel' }
  | { type: 'draft.get'; draftId: string }
  | { type: 'draft.fromSuggestion'; emailId: string; index: number }
  | { type: 'contact.pick'; pendingId: string; index: number }
  | { type: 'draft.act'; draftId: string; action: DraftAction }
  | { type: 'invite.act'; inviteId: string; action: InviteAction }
  | { type: 'auth.start' }

export type DoneKind = 'sent' | 'saved' | 'created' | 'discarded'

export interface ResponseMap {
  'home.get': { type: 'home'; data: HomeData }
  'inbox.get': { type: 'inbox'; items: InboxItem[] }
  'email.get': { type: 'email'; email: EmailDetail }
  'meeting.get': { type: 'meeting'; meeting: Meeting; briefing: Briefing }
  'voice.start': { type: 'ok' }
  'voice.stop': { type: 'voice.result'; result: VoiceResult }
  'voice.cancel': { type: 'ok' }
  'draft.get': { type: 'voice.result'; result: VoiceResult }
  'draft.fromSuggestion': { type: 'voice.result'; result: VoiceResult }
  'contact.pick': { type: 'voice.result'; result: VoiceResult }
  'draft.act': { type: 'done'; kind: DoneKind; message: string }
  'invite.act': { type: 'done'; kind: DoneKind; message: string }
  'auth.start': { type: 'ok' }
}

export type RequestType = Request['type']
export type ResponseFor<T extends RequestType> = ResponseMap[T]

export type ErrorCode = 'AUTH' | 'GOOGLE' | 'AI' | 'STT' | 'BAD_REQUEST' | 'NOT_FOUND' | 'INTERNAL'

export interface ErrorResponse {
  type: 'error'
  code: ErrorCode
  message: string
}

// ── Wire envelopes ──────────────────────────────────────────────────────

export type ClientMessage =
  | { type: 'hello'; token: string }
  | { type: 'ping' }
  | (Request & { rid: number })

export type ServerPush =
  | { type: 'transcript'; final: string; interim: string }
  | { type: 'busy'; label: string }
  | { type: 'changed'; what: 'home' | 'inbox' }
  | { type: 'auth.needed' }

export type ServerMessage =
  | { type: 'ready'; version: string; authNeeded: boolean; fake: boolean }
  | { type: 'pong' }
  | { type: 'error'; code: ErrorCode; message: string } // connection-level, no rid
  | ServerPush
  | ({ rid: number } & (ResponseMap[RequestType] | ErrorResponse))
