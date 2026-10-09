import type { InviteDraft, Meeting, Person } from '../../../shared/protocol.ts'

export interface RawEmail {
  id: string
  threadId: string
  from: Person
  to: Person[]
  cc: Person[]
  subject: string
  date: string // ISO
  snippet: string
  bodyText: string // '' when only metadata was fetched
  messageId?: string // RFC 822 Message-ID header, for replies
  references?: string
  unread: boolean
}

export interface MailPort {
  profile(): Promise<{ email: string; name?: string }>
  /** Newest inbox messages, metadata + snippet only. */
  listInbox(max: number): Promise<RawEmail[]>
  /** One message with its body. */
  getEmail(id: string): Promise<RawEmail>
  /** Messages in a thread, oldest first, with bodies. */
  getThread(threadId: string): Promise<RawEmail[]>
  /** Recent messages exchanged with any of these addresses, with bodies. */
  searchWith(emails: string[], max: number): Promise<RawEmail[]>
  /** Headers of recent inbox + sent messages, for the contact index. */
  recentHeaders(max: number): Promise<RawEmail[]>
  markRead(id: string): Promise<void>
  /** `raw` is a base64url RFC 2822 message (see mime.ts). */
  send(raw: string, threadId?: string): Promise<{ id: string }>
  createDraft(raw: string, threadId?: string): Promise<{ id: string }>
}

export interface CalendarPort {
  /** Events from now through `days` ahead, soonest first. */
  upcoming(days: number): Promise<Meeting[]>
  get(id: string): Promise<Meeting | null>
  /** Creates the event and emails invitations to attendees. */
  create(invite: InviteDraft): Promise<{ id: string }>
}

/** Thrown when Google credentials are missing, expired or revoked. */
export class AuthNeededError extends Error {
  constructor(message = 'Google sign-in needed') {
    super(message)
    this.name = 'AuthNeededError'
  }
}
