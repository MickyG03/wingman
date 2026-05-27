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
  /** Gmail search syntax (e.g. `from:sam is:unread newer_than:7d`), metadata only. */
  search(query: string, max: number): Promise<RawEmail[]>
  /** Headers of recent inbox + sent messages, for the contact index. */
  recentHeaders(max: number): Promise<RawEmail[]>
  markRead(id: string): Promise<void>
  /** `raw` is a base64url RFC 2822 message (see mime.ts). */
  send(raw: string, threadId?: string): Promise<{ id: string }>
  createDraft(raw: string, threadId?: string): Promise<{ id: string }>
}

export interface EventPatch {
  title?: string
  start?: string
  end?: string
  location?: string
  addAttendees?: Person[]
}

export interface CalendarPort {
  /** Events from now through `days` ahead, soonest first. */
  upcoming(days: number): Promise<Meeting[]>
  /** Events in a window, soonest first. */
  between(fromIso: string, toIso: string, max: number): Promise<Meeting[]>
  get(id: string): Promise<Meeting | null>
  /** Creates the event and emails invitations to attendees. */
  create(invite: InviteDraft): Promise<{ id: string }>
  update(id: string, patch: EventPatch): Promise<Meeting>
  remove(id: string): Promise<void>
}

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  modifiedAt: string
  owner?: string
  webUrl?: string
}

export const MIME = {
  doc: 'application/vnd.google-apps.document',
  sheet: 'application/vnd.google-apps.spreadsheet',
  folder: 'application/vnd.google-apps.folder',
} as const

export interface DrivePort {
  search(query: string, mimeType: string | undefined, max: number): Promise<DriveFile[]>
  recent(max: number): Promise<DriveFile[]>
  get(id: string): Promise<DriveFile | null>
  /** Plain-text export of a non-Google file (txt, pdf, docx...). */
  exportText(id: string): Promise<string>
  createDoc(name: string, content: string): Promise<DriveFile>
  createSheet(name: string, rows: string[][]): Promise<DriveFile>
}

export interface DocsPort {
  /** Flattened body text. */
  readText(docId: string): Promise<{ title: string; text: string }>
  appendText(docId: string, text: string): Promise<void>
  /** Returns how many occurrences were replaced. */
  replaceText(docId: string, find: string, replace: string): Promise<number>
}

export interface SheetsPort {
  /** Sheet (tab) names and the spreadsheet title. */
  info(sheetId: string): Promise<{ title: string; sheets: string[] }>
  /** A1 range (e.g. "Budget!A1:E20"); defaults to the first sheet. */
  readRange(sheetId: string, range?: string): Promise<{ range: string; values: string[][] }>
  appendRows(sheetId: string, sheet: string | undefined, rows: string[][]): Promise<{ range: string }>
  updateRange(sheetId: string, range: string, values: string[][]): Promise<{ range: string }>
}

export interface ContactsPort {
  /** Saved contacts and auto-saved correspondents. */
  list(): Promise<Person[]>
}

/** Thrown when Google credentials are missing, expired or revoked. */
export class AuthNeededError extends Error {
  constructor(message = 'Google sign-in needed') {
    super(message)
    this.name = 'AuthNeededError'
  }
}
