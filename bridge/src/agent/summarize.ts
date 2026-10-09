// Shapes data for the model so a turn stays small: lists capped, bodies
// trimmed, and old tool results compacted to a digest.

import type { Meeting, Person } from '../../../shared/protocol.ts'
import type { DriveFile, RawEmail } from '../google/ports.ts'

export const LIST_MAX = 10
export const BODY_MAX = 1500

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 3).trimEnd()}...` : s)
const person = (p: Person) => (p.name && p.name !== p.email ? `${p.name} <${p.email}>` : p.email)

export function emailRow(m: RawEmail) {
  return {
    id: m.id,
    from: person(m.from),
    subject: m.subject,
    date: m.date.slice(0, 16),
    unread: m.unread,
    snippet: clip(m.snippet, 120),
  }
}

export function emailBody(m: RawEmail) {
  return {
    id: m.id,
    threadId: m.threadId,
    from: person(m.from),
    to: m.to.map(person).join(', '),
    date: m.date,
    subject: m.subject,
    body: clip(m.bodyText || m.snippet, BODY_MAX),
  }
}

export function eventRow(e: Meeting) {
  return {
    id: e.id,
    title: e.title,
    start: e.start,
    end: e.end,
    allDay: e.allDay,
    location: e.location,
    attendees: e.attendees.map(person).join(', '),
  }
}

export function fileRow(f: DriveFile) {
  const kind = f.mimeType.includes('document') ? 'doc' : f.mimeType.includes('spreadsheet') ? 'sheet' : f.mimeType.split('/').pop()
  return { id: f.id, name: f.name, kind, modified: f.modifiedAt.slice(0, 10), owner: f.owner }
}

export function table(values: string[][], maxRows = 20, maxCols = 10): string[][] {
  return values.slice(0, maxRows).map(r => r.slice(0, maxCols).map(c => clip(c, 60)))
}

/** Compact JSON for a function response; large results get a digest. */
export function digest(value: unknown, max = 300): string {
  const s = JSON.stringify(value)
  return s.length <= max ? s : `${s.slice(0, max)}... (truncated)`
}
