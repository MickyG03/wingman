import type { HomeData } from '../../../shared/protocol'
import { names, relative, timeOf } from '../render/format'

export type HomeTarget =
  | { kind: 'meeting'; id: string }
  | { kind: 'inbox' }
  | { kind: 'draft'; id: string }
  | { kind: 'invite'; id: string }
  | { kind: 'voice' }

export interface HomeEntry {
  target: HomeTarget
  lines: string[]
}

/** The selectable rows on the home screen, top to bottom. */
export function homeEntries(home: HomeData | null, now: number): HomeEntry[] {
  const out: HomeEntry[] = []
  if (home?.nextMeeting) {
    const m = home.nextMeeting
    const who = names(m.attendees)
    out.push({
      target: { kind: 'meeting', id: m.id },
      lines: [m.title, [relative(m.start, now, m.end), who && `with ${who}`].filter(Boolean).join('  -  ')],
    })
  }
  for (const m of home?.upcoming.slice(0, 1) ?? []) {
    out.push({ target: { kind: 'meeting', id: m.id }, lines: [`${timeOf(m.start)}  ${m.title}`] })
  }
  if (home) {
    const important = home.importantUnread ? `, ${home.importantUnread} important` : ''
    out.push({ target: { kind: 'inbox' }, lines: [`Inbox: ${home.unread} unread${important}`] })
    for (const d of home.pendingDrafts) {
      out.push({ target: { kind: 'draft', id: d.id }, lines: [`Draft: ${d.subject}`] })
    }
    for (const i of home.pendingInvites) {
      out.push({ target: { kind: 'invite', id: i.id }, lines: [`Invite: ${i.title}`] })
    }
  }
  out.push({ target: { kind: 'voice' }, lines: ['● Speak: new email or invite'] })
  return out
}
