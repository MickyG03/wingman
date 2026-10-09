// Pure rendering: state → the three text areas on the glasses.

import type { Draft, EmailDetail, InviteDraft, Meeting, Briefing } from '../../../shared/protocol'
import { homeEntries } from '../app/home'
import { top, type State } from '../app/state'
import { age, clock, firstName, names, relative, whenRange } from './format'
import { BODY_LINES, paginate, renderList, spread, truncate, wrap } from './text'

export interface Frame {
  header: string
  body: string
  footer: string
}

// ── Paged content (also used by the reducer to clamp page numbers) ──────

export function emailPages(e: EmailDetail): string[][] {
  const lines = [
    ...wrap(e.subject),
    ...(e.summary ? wrap(`AI: ${e.summary}`) : []),
    '',
    ...compact(e.bodyText || '(no text)'),
  ]
  return paginate(lines)
}

export function meetingPages(m: Meeting, b: Briefing | null): string[][] {
  const lines = [
    ...wrap(m.title),
    truncate(m.allDay ? 'All day' : whenRange(m.start, m.end)),
    ...(m.location ? [truncate(m.location)] : []),
    ...(m.attendees.length ? wrap(`With: ${names(m.attendees, 6)}`) : []),
    '',
  ]
  if (!b) lines.push('Preparing briefing...')
  else {
    if (b.purpose) lines.push(...wrap(b.purpose))
    if (b.lastThread) lines.push('', ...wrap(`Last email: ${b.lastThread}`))
    if (b.points.length) lines.push('', ...b.points.flatMap(p => wrap(`- ${p}`)))
  }
  return paginate(lines)
}

export function draftPages(d: Draft): string[][] {
  return paginate([
    truncate(`To: ${d.to.map(p => p.name).join(', ')}`),
    ...wrap(`Subject: ${d.subject}`),
    '',
    ...compact(d.body),
  ])
}

export function invitePages(i: InviteDraft): string[][] {
  return paginate([
    ...wrap(i.title),
    truncate(whenRange(i.start, i.end)),
    ...(i.location ? [truncate(i.location)] : []),
    ...wrap(`With: ${i.attendees.length ? i.attendees.map(p => p.name).join(', ') : 'just you'}`),
    '',
    'Tap to send the invite.',
  ])
}

/** Message text without blank lines: on 8 lines, paragraphs read fine without gaps. */
function compact(text: string): string[] {
  return wrap(text).filter(l => l.trim() !== '')
}

function pageTag(page: number, total: number): string {
  return total > 1 ? `${page + 1}/${total}` : ''
}

function centered(lines: string[]): string {
  const padTop = Math.max(0, Math.floor((BODY_LINES - lines.length) / 2) - 1)
  return [...Array(padTop).fill(''), ...lines].join('\n')
}

// ── Screens ─────────────────────────────────────────────────────────────

export function render(s: State): Frame {
  const now = s.now
  const time = clock(now)

  if (s.conn !== 'ready') {
    const msg =
      s.conn === 'unauthorized'
        ? ['Bridge rejected the token.', 'Check VITE_BRIDGE_TOKEN matches', 'WINGMAN_TOKEN in bridge/.env.']
        : s.conn === 'connecting'
          ? ['Connecting to your PC...']
          : ['Bridge offline', s.connDetail, '', 'Is the bridge running on your PC?']
    return { header: spread('Wingman', time), body: centered(msg.filter(l => l !== undefined)), footer: 'double-tap: exit' }
  }

  const sc = top(s)
  switch (sc.name) {
    case 'home': {
      const entries = homeEntries(s.home, now)
      const body = s.home ? renderList(entries, sc.cursor) : [s.homeError ? `Couldn't load: ${s.homeError}` : 'Loading...']
      return {
        header: spread(s.fake ? 'Wingman (demo data)' : 'Wingman', time),
        body: body.join('\n'),
        footer: 'tap: open   hold: speak   double-tap: exit',
      }
    }

    case 'inbox': {
      const items = s.inbox ?? []
      const body = s.inbox
        ? items.length
          ? renderList(
              items.map(i => ({
                lines: [`${i.unread ? (i.important ? '★' : '●') : '  '} ${firstName(i.from)}: ${i.subject}  ${age(i.receivedAt, now)}`, i.summary],
              })),
              sc.cursor,
            )
          : ['Inbox zero.']
        : ['Loading...']
      const unread = items.filter(i => i.unread).length
      return { header: spread('Inbox', `${unread} unread`), body: body.join('\n'), footer: 'tap: open   double-tap: back' }
    }

    case 'email': {
      if (!sc.email) return { header: spread('Email', time), body: 'Loading...', footer: 'double-tap: back' }
      const pages = emailPages(sc.email)
      return {
        header: spread(`From ${sc.email.from.name}`, pageTag(sc.page, pages.length) || age(sc.email.receivedAt, now)),
        body: pages[Math.min(sc.page, pages.length - 1)].join('\n'),
        footer: 'tap: reply   hold: dictate   swipe: page',
      }
    }

    case 'meeting': {
      const m = sc.data?.meeting ?? s.home?.nextMeeting
      if (!m || m.id !== sc.id) return { header: spread('Meeting', time), body: 'Loading...', footer: 'double-tap: back' }
      const pages = meetingPages(m, sc.data?.briefing ?? null)
      return {
        header: spread('Meeting', pageTag(sc.page, pages.length) || (m.allDay ? 'all day' : relative(m.start, now, m.end))),
        body: pages[Math.min(sc.page, pages.length - 1)].join('\n'),
        footer: 'tap: follow-up   hold: dictate follow-up',
      }
    }

    case 'menu':
      return {
        header: truncate(sc.title),
        body: renderList(sc.items.map(i => ({ lines: [i.label] })), sc.cursor).join('\n'),
        footer: 'tap: choose   double-tap: back',
      }

    case 'dictate': {
      const text = [sc.final, sc.interim].filter(Boolean).join(' ')
      const lines = text ? wrap(text) : [sc.micWarning ? 'No audio from the mic yet...' : 'Speak now...']
      return {
        header: spread(`Listening: ${sc.label}`, '●'),
        body: lines.slice(-BODY_LINES).join('\n'),
        footer: sc.mode === 'hold' ? 'release: done   double-tap: cancel' : 'tap: done   double-tap: cancel',
      }
    }

    case 'thinking':
      return { header: spread('Wingman', time), body: centered([sc.label]), footer: 'double-tap: cancel' }

    case 'contacts':
      return {
        header: truncate(`Which "${sc.query}"?`),
        body: renderList(sc.candidates.map(c => ({ lines: [c.name, c.email] })), sc.cursor).join('\n'),
        footer: 'tap: choose   double-tap: cancel',
      }

    case 'draft': {
      const pages = draftPages(sc.draft)
      const kind = sc.draft.kind === 'reply' ? 'Reply' : sc.draft.kind === 'followup' ? 'Follow-up' : 'New email'
      return {
        header: spread(`${kind} (draft)`, pageTag(sc.page, pages.length)),
        body: pages[Math.min(sc.page, pages.length - 1)].join('\n'),
        footer: 'tap: send / save   hold: redo   swipe: page',
      }
    }

    case 'invite': {
      const pages = invitePages(sc.invite)
      return {
        header: spread('Invite (draft)', pageTag(sc.page, pages.length)),
        body: pages[Math.min(sc.page, pages.length - 1)].join('\n'),
        footer: 'tap: send / discard   double-tap: back',
      }
    }

    case 'result':
      return { header: spread('Wingman', time), body: centered(wrap(`${sc.ok ? '' : '! '}${sc.message}`)), footer: 'tap: ok' }

    case 'auth':
      return {
        header: spread('Google sign-in needed', time),
        body: (sc.waiting
          ? ['Finish signing in with the', 'browser window on your PC.', '', 'This screen updates by itself.']
          : ['Wingman needs your Gmail and', 'Calendar.', '', 'Tap to open sign-in on your PC,', 'or run there:  npm run auth']
        ).join('\n'),
        footer: 'tap: sign in   double-tap: exit',
      }
  }
}
