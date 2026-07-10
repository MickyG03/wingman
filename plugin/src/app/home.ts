import type { HomeData } from '../../../shared/protocol'
import type { IconName } from '../glasses/icons'
import { names, relative, timeOf } from '../render/format'

export type HomeTarget =
  | { kind: 'meeting'; id: string }
  | { kind: 'inbox' }
  | { kind: 'draft'; id: string }
  | { kind: 'invite'; id: string }
  | { kind: 'recent' }
  | { kind: 'chat' }
  | { kind: 'action'; id: string }
  | { kind: 'dino' }

export interface HomeEntry {
  target: HomeTarget
  lines: string[]
  icon: IconName
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
      icon: 'calendar',
    })
  }
  for (const m of home?.upcoming.slice(0, 1) ?? []) {
    out.push({ target: { kind: 'meeting', id: m.id }, lines: [`${timeOf(m.start)}  ${m.title}`], icon: 'calendar' })
  }
  // The one voice entry: email, replies, invites, files, questions. Hold anywhere on home does the same.
  out.push({ target: { kind: 'chat' }, lines: ['Ask Wingman'], icon: 'wing' })
  if (home) {
    const important = home.importantUnread ? `, ${home.importantUnread} important` : ''
    out.push({ target: { kind: 'inbox' }, lines: [`Inbox: ${home.unread} unread${important}`], icon: 'mail' })
    for (const d of home.pendingDrafts) {
      out.push({ target: { kind: 'draft', id: d.id }, lines: [`Draft: ${d.subject}`], icon: 'doc' })
    }
    for (const i of home.pendingInvites) {
      out.push({ target: { kind: 'invite', id: i.id }, lines: [`Invite: ${i.title}`], icon: 'calendar' })
    }
    for (const a of home.pendingActions ?? []) {
      out.push({ target: { kind: 'action', id: a.id }, lines: [`Approve: ${a.label}`], icon: 'check' })
    }
  }
  if (home?.recent.length) {
    const last = home.recent[0]
    const gist = last.outcome === 'draft' || last.outcome === 'invite' ? last.detail : last.heard ? `"${last.heard}"` : last.detail
    out.push({ target: { kind: 'recent' }, lines: [`Recent (${home.recent.length}): ${gist}`], icon: 'clock' })
  }
  out.push({ target: { kind: 'dino' }, lines: ['Dino run'], icon: 'game' })
  return out
}
