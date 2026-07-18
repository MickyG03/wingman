// Pure rendering: state → what the glasses show.

import type { Briefing, ChatTurn, Draft, EmailDetail, InviteDraft, Meeting } from '../../../shared/protocol'
import { homeEntries } from '../app/home'
import { top, type State } from '../app/state'
import { draw as drawDino } from '../game/dino'
import type { IconName } from '../glasses/icons'
import { age, clock, firstName, names, relative, whenRange } from './format'
import { BODY_LINES, paginate, renderList, renderListRows, spread, TEXT_W, truncate, wrap } from './text'

/** Which page layout the display should use (see glasses/display.ts). */
export type Layout = 'default' | 'chat' | 'game'

export interface Frame {
  layout: Layout
  header: string
  body: string
  footer: string
  /** chat layout: the dim "You: ..." area above the reply. */
  you?: string
  /** default layout: an icon per body line (null = none). */
  icons?: (IconName | null)[]
  /** game layout: draws the play area. */
  draw?: (ctx: CanvasRenderingContext2D, w: number, h: number) => void
  /** game layout: identity of the state drawn, so unchanged frames are not re-sent. */
  gameState?: object
}

type Partial = Omit<Frame, 'layout'> & { layout?: Layout }

/** Reply lines per chat page (the dim "You:" area takes two). */
export const CHAT_LINES = 6

/** A small level meter for the listening header. */
export function meter(level: number, bars = 6): string {
  const glyphs = '▁▂▃▄▅▆▇█'
  const filled = Math.round(Math.min(1, level * 1.6) * bars)
  let out = ''
  for (let i = 0; i < bars; i++) out += i < filled ? glyphs[Math.min(7, 2 + Math.floor((i / bars) * 6))] : '▁'
  return out
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

// ── Chat ────────────────────────────────────────────────────────────────

export interface ChatPage {
  turnId: string
  /** What the user said, for the dim area (two lines max). */
  you: string
  lines: string[]
}

function cardHint(turn: ChatTurn): string {
  const { card, pending } = turn.reply
  if (pending) return `▶ ${pending.label}  -  tap to review`
  if (!card) return ''
  switch (card.kind) {
    case 'list':
      return `▶ ${card.title} (${card.items.length})  -  tap to open`
    case 'text':
      return `▶ ${truncate(card.title, TEXT_W - 160)}  -  tap to read`
    case 'draft':
    case 'invite':
    case 'edit':
      return '▶ tap to review'
  }
}

/** Wingman's reply plus a hint for its card, as glasses lines. */
function turnLines(turn: ChatTurn): string[] {
  const hint = cardHint(turn)
  return [...compact(turn.reply.text), ...(hint ? [truncate(hint)] : [])]
}

/** The whole conversation paginated, oldest first, each page tagged with its turn. */
export function chatPages(turns: ChatTurn[]): ChatPage[] {
  const pages: ChatPage[] = []
  for (const turn of turns) {
    const you = turn.heard ? wrap(`You: ${turn.heard}`).slice(0, 2).join('\n') : ''
    for (const lines of paginate(turnLines(turn), CHAT_LINES)) pages.push({ turnId: turn.id, you, lines })
  }
  return pages
}

export function textPages(turn: ChatTurn): string[][] {
  const card = turn.reply.card
  if (card?.kind !== 'text') return [[]]
  return paginate([...wrap(card.title), ...compact(card.text)])
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
  const f = renderScreen(s)
  return { ...f, layout: f.layout ?? 'default' }
}

function renderScreen(s: State): Partial {
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
      const rows = s.home ? renderListRows(entries, sc.cursor) : null
      const body = rows ? rows.lines : [s.homeError ? `Couldn't load: ${s.homeError}` : 'Loading...']
      // An icon on the first line of each entry; continuation lines stay blank.
      const icons = rows ? rows.entryOfLine.map((e, i) => (i === 0 || rows.entryOfLine[i - 1] !== e ? entries[e].icon : null)) : []
      return {
        header: spread(s.fake ? 'Wingman  (demo data)' : 'Wingman', time),
        body: body.join('\n'),
        footer: 'tap: open   hold: ask   double-tap: exit',
        icons,
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
        header: spread(`Listening: ${sc.label}`, `${meter(s.micLevel)} ●`),
        body: lines.slice(-BODY_LINES).join('\n'),
        footer: sc.mode === 'hold' ? 'release: done   double-tap: cancel' : 'tap: done   double-tap: cancel',
      }
    }

    case 'thinking': {
      const lines = sc.heard ? [...wrap(`Heard: "${sc.heard}"`).slice(0, 5), '', sc.label] : [sc.label]
      return { header: spread('Wingman', time), body: sc.heard ? lines.join('\n') : centered(lines), footer: 'double-tap: cancel' }
    }

    case 'recent': {
      const items = s.home?.recent ?? []
      const body = items.length
        ? renderList(
            items.map(r => ({
              lines: [
                `${age(r.at, now)}  "${r.heard || '(nothing heard)'}"`,
                `${r.outcome === 'draft' || r.outcome === 'invite' ? '' : r.outcome === 'error' ? 'Error: ' : ''}${r.detail}`,
              ],
            })),
            sc.cursor,
          )
        : ['Nothing yet. Hold to talk from home.']
      return { header: spread('Recent voice requests', time), body: body.join('\n'), footer: 'swipe: scroll   double-tap: back' }
    }

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

    case 'chat': {
      const pages = chatPages(s.chat ?? [])
      if (pages.length === 0) {
        return {
          header: spread('Ask Wingman', time),
          body: centered(s.chat === null ? ['Loading...'] : ['Hold to talk, or tap.', '', 'Try: "what is unread",', '"find the offsite budget",', '"lunch with Sam Thursday".']),
          footer: 'tap: ask   hold: talk   double-tap: back',
        }
      }
      const page = pages[Math.min(sc.page, pages.length - 1)]
      const hasCard = !!s.chat?.find(t => t.id === page.turnId)?.reply.card
      return {
        layout: 'chat',
        header: spread('Ask Wingman', pageTag(Math.min(sc.page, pages.length - 1), pages.length) || time),
        you: page.you || ' ',
        body: page.lines.join('\n'),
        footer: `${hasCard ? 'tap: open' : 'tap: ask'}   hold: talk   swipe: page`,
      }
    }

    case 'game':
      return {
        layout: 'game',
        header: spread(`Dino run${s.gameFps ? `   ${s.gameFps.toFixed(0)} fps` : ''}`, `score ${sc.dino.score}   best ${Math.max(sc.dino.best, s.dinoBest)}`),
        body: ' ',
        footer: 'tap / swipe up: jump   swipe down: duck   double-tap: quit',
        draw: ctx => drawDino(ctx, sc.dino),
        gameState: sc.dino,
      }

    case 'card': {
      const card = s.chat?.find(t => t.id === sc.turnId)?.reply.card
      const items = card?.kind === 'list' ? card.items : []
      return {
        header: truncate(card?.kind === 'list' ? card.title : 'Items'),
        body: items.length ? renderList(items.map(i => ({ lines: i.detail ? [i.title, i.detail] : [i.title] })), sc.cursor).join('\n') : 'Nothing here.',
        footer: 'tap: open   hold: ask   double-tap: back',
      }
    }

    case 'textCard': {
      const turn = s.chat?.find(t => t.id === sc.turnId)
      const pages = turn ? textPages(turn) : [[]]
      const card = turn?.reply.card
      return {
        header: spread(truncate(card?.kind === 'text' ? card.title : 'Text', TEXT_W - 60), pageTag(sc.page, pages.length)),
        body: pages[Math.min(sc.page, pages.length - 1)].join('\n'),
        footer: 'swipe: page   hold: ask   double-tap: back',
      }
    }

    case 'approval': {
      const pages = paginate(sc.lines.flatMap(l => wrap(l)))
      return {
        header: spread('Approve?', pageTag(sc.page, pages.length)),
        body: pages[Math.min(sc.page, pages.length - 1)].join('\n'),
        footer: 'tap: approve / discard   double-tap: back',
      }
    }

    case 'result': {
      const lines = wrap(`${sc.ok ? '' : '! '}${sc.message}`).slice(0, BODY_LINES)
      const footer = sc.retry ? 'tap: try again   double-tap: back' : sc.until === null ? 'tap: ok   double-tap: back' : 'tap: ok'
      return { header: spread('Wingman', time), body: sc.ok ? centered(lines) : lines.join('\n'), footer }
    }

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
