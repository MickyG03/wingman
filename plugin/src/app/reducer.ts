// All navigation and interaction logic, as a pure function:
// (state, action) → { state, effects }. Effects are run by effects.ts.

import type { CardItem, ChatReply, Request, ResponseMap, VoiceContext, VoiceResult } from '../../../shared/protocol'
import type { Gesture } from '../glasses/input'
import { chatPages, draftPages, emailPages, invitePages, meetingPages, textPages } from '../render/screens'
import { paginate } from '../render/text'
import { firstName, names } from '../render/format'
import { duck, jump, newGame, tick as dinoTick } from '../game/dino'
import { homeEntries } from './home'
import { top, type Action, type Effect, type MenuAction, type MenuItem, type Screen, type State } from './state'

export interface Step {
  state: State
  effects: Effect[]
}

const RESULT_MS = 2200
/** Taps right after a menu opens or a hold ends are likely accidental. */
const TAP_GUARD_MS = 400
const NUDGE_MS = 10 * 60_000

const step = (state: State, effects: Effect[] = []): Step => ({ state, effects })
const req = (r: Request, token?: number): Effect => ({ kind: 'request', req: r, token })

function push(s: State, sc: Screen): State {
  return { ...s, stack: [...s.stack, sc] }
}

function pop(s: State): State {
  return s.stack.length > 1 ? { ...s, stack: s.stack.slice(0, -1) } : s
}

function replaceTop(s: State, sc: Screen): State {
  return { ...s, stack: [...s.stack.slice(0, -1), sc] }
}

function updateTop(s: State, patch: Partial<Screen>): State {
  return replaceTop(s, { ...top(s), ...patch } as Screen)
}

/** Drops transient screens (menus, drafts, dictation...) back to where the user was browsing. */
function popTransient(s: State): State {
  const transient = new Set(['menu', 'dictate', 'thinking', 'contacts', 'draft', 'invite', 'result', 'recent', 'card', 'textCard', 'approval', 'game'])
  let stack = s.stack
  while (stack.length > 1 && transient.has(stack[stack.length - 1].name)) stack = stack.slice(0, -1)
  return { ...s, stack }
}

/** Success toasts close by themselves; anything that went wrong stays until the user taps. */
function result(s: State, message: string, ok: boolean, retry?: VoiceContext): State {
  return push(s, { name: 'result', message, ok, until: ok ? s.now + RESULT_MS : null, retry })
}

function thinking(s: State, label: string, heard?: string): { state: State; token: number } {
  const token = s.nextToken
  return { state: push({ ...s, nextToken: token + 1 }, { name: 'thinking', label, token, heard }), token }
}

function voiceLabel(ctx: VoiceContext, s: State): string {
  switch (ctx.kind) {
    case 'home':
      return 'new email or invite'
    case 'chat':
      return 'ask Wingman'
    case 'reply': {
      const e = s.stack.find(x => x.name === 'email' && x.id === ctx.emailId)
      return e?.name === 'email' && e.email ? `reply to ${firstName(e.email.from)}` : 'reply'
    }
    case 'followup':
      return 'meeting follow-up'
    case 'redo':
      return 'changes to the draft'
  }
}

/** What holding to talk means on the current screen, if anything. */
function voiceContextFor(sc: Screen, s: State): VoiceContext | null {
  switch (sc.name) {
    case 'home':
      return { kind: 'chat', ctx: { screen: 'home' } }
    case 'inbox':
      return { kind: 'chat', ctx: { screen: 'inbox', focusEmailId: s.inbox?.[sc.cursor]?.id } }
    case 'chat':
      return { kind: 'chat', ctx: { screen: 'chat' } }
    case 'card':
    case 'textCard':
    case 'approval':
      return { kind: 'chat', ctx: { screen: 'card' } }
    case 'recent':
    case 'result':
      return { kind: 'chat', ctx: { screen: 'other' } }
    case 'email':
      return sc.email ? { kind: 'reply', emailId: sc.id } : null
    case 'meeting':
      return { kind: 'followup', eventId: sc.id }
    case 'draft':
      return { kind: 'redo', draftId: sc.draft.id }
    default:
      return null
  }
}

function startVoice(s: State, ctx: VoiceContext, mode: 'hold' | 'toggle'): Step {
  const next = push({ ...s, lastVoiceCtx: ctx, micLevel: 0 }, { name: 'dictate', ctx, label: voiceLabel(ctx, s), final: '', interim: '', mode, micWarning: false })
  return step(next, [req({ type: 'voice.start', ctx }), { kind: 'mic', on: true }])
}

function stopVoice(s: State): Step {
  const sc = top(s)
  if (sc.name !== 'dictate') return step(s)
  const heard = [sc.final, sc.interim].filter(Boolean).join(' ')
  const t = thinking(pop(s), 'Thinking...', heard)
  return step(t.state, [{ kind: 'mic', on: false }, req({ type: 'voice.stop' }, t.token)])
}

function cancelVoice(s: State): Step {
  return step(pop(s), [{ kind: 'mic', on: false }, req({ type: 'voice.cancel' })])
}

function openMenu(s: State, title: string, items: MenuItem[]): State {
  return push(s, { name: 'menu', title, items: [...items, { label: 'Back', action: { kind: 'back' } }], cursor: 0, openedAt: s.now })
}

function runMenuAction(s0: State, a: MenuAction): Step {
  const s = pop(s0) // close the menu first
  switch (a.kind) {
    case 'back':
      return step(s)
    case 'voice':
      return startVoice(s, a.ctx, 'toggle')
    case 'suggestion': {
      const t = thinking(s, 'Preparing draft...')
      return step(t.state, [req({ type: 'draft.fromSuggestion', emailId: a.emailId, index: a.index }, t.token)])
    }
    case 'draftAct': {
      const t = thinking(s, a.label)
      return step(t.state, [req({ type: 'draft.act', draftId: a.draftId, action: a.action }, t.token)])
    }
    case 'inviteAct': {
      const t = thinking(s, a.label)
      return step(t.state, [req({ type: 'invite.act', inviteId: a.inviteId, action: a.action }, t.token)])
    }
    case 'actionAct': {
      const t = thinking(s, a.label)
      return step(t.state, [req({ type: 'action.act', id: a.id, action: a.approve ? 'approve' : 'discard' }, t.token)])
    }
  }
}

// ── Chat helpers ────────────────────────────────────────────────────────

const turnOf = (s: State, turnId: string) => s.chat?.find(t => t.id === turnId)

/** Opens the chat at its newest page, loading history on first use. */
function openChat(s: State): Step {
  // Before history arrives the page count is unknown: aim past the end and let
  // clampCursors settle on the newest page once chat.history comes back.
  const page = s.chat === null ? Number.MAX_SAFE_INTEGER : Math.max(0, chatPages(s.chat).length - 1)
  return step(push(s, { name: 'chat', page }), s.chat === null ? [req({ type: 'chat.history' })] : [])
}

/** Sends a tapped card item to the agent ("Open it") and waits. */
function askAbout(s: State, pick: CardItem, text: string): Step {
  const t = thinking(s, 'Opening...')
  return step(t.state, [req({ type: 'chat.send', text, ctx: { screen: 'card' }, pick }, t.token)])
}

/** Shows what came back from the agent: the chat page, plus anything to review. */
function showChatReply(s0: State, reply: ChatReply): State {
  const chat = [...(s0.chat ?? []), { id: reply.turnId, at: new Date(s0.now).toISOString(), heard: top(s0).name === 'thinking' ? ((top(s0) as { heard?: string }).heard ?? '') : '', reply }]
  let s: State = { ...s0, chat }
  s = top(s).name === 'thinking' ? pop(s) : s
  const lastPage = Math.max(0, chatPages(chat).length - 1)
  s = top(s).name === 'chat' ? updateTop(s, { page: lastPage }) : push(s, { name: 'chat', page: lastPage })
  // Something to approve opens right away; double-tap returns to the chat.
  if (reply.card?.kind === 'draft') return push(s, { name: 'draft', draft: reply.card.draft, page: 0 })
  if (reply.card?.kind === 'invite') return push(s, { name: 'invite', invite: reply.card.invite, page: 0 })
  if (reply.pending?.kind === 'action' && reply.card?.kind === 'edit') {
    return push(s, { name: 'approval', pending: reply.pending, lines: [reply.card.title, ...reply.card.lines], page: 0 })
  }
  return s
}

function openTurnCard(s: State, turnId: string): Step {
  const turn = turnOf(s, turnId)
  const card = turn?.reply.card
  const pending = turn?.reply.pending
  if (!card) return step(s)
  switch (card.kind) {
    case 'list':
      return step(push(s, { name: 'card', turnId, cursor: 0 }))
    case 'text':
      return step(push(s, { name: 'textCard', turnId, page: 0 }))
    case 'draft':
      return step(push(s, { name: 'draft', draft: card.draft, page: 0 }))
    case 'invite':
      return step(push(s, { name: 'invite', invite: card.invite, page: 0 }))
    case 'edit':
      return pending ? step(push(s, { name: 'approval', pending, lines: [card.title, ...card.lines], page: 0 })) : step(s)
  }
}

function pageCount(sc: Screen, s: State): number {
  switch (sc.name) {
    case 'email':
      return sc.email ? emailPages(sc.email).length : 1
    case 'meeting': {
      const m = sc.data?.meeting ?? (s.home?.nextMeeting?.id === sc.id ? s.home.nextMeeting : undefined)
      return m ? meetingPages(m, sc.data?.briefing ?? null).length : 1
    }
    case 'draft':
      return draftPages(sc.draft).length
    case 'invite':
      return invitePages(sc.invite).length
    case 'chat':
      return Math.max(1, chatPages(s.chat ?? []).length)
    case 'textCard': {
      const turn = turnOf(s, sc.turnId)
      return turn ? textPages(turn).length : 1
    }
    case 'approval':
      return paginate(sc.lines).length
    default:
      return 1
  }
}

function listLength(sc: Screen, s: State): number {
  switch (sc.name) {
    case 'home':
      return homeEntries(s.home, s.now).length
    case 'inbox':
      return s.inbox?.length ?? 0
    case 'menu':
      return sc.items.length
    case 'contacts':
      return sc.candidates.length
    case 'recent':
      return s.home?.recent.length ?? 0
    case 'card': {
      const card = turnOf(s, sc.turnId)?.reply.card
      return card?.kind === 'list' ? card.items.length : 0
    }
    default:
      return 0
  }
}

function move(s: State, delta: number): State {
  const sc = top(s)
  if ('cursor' in sc) {
    const n = listLength(sc, s)
    return updateTop(s, { cursor: Math.max(0, Math.min(n - 1, sc.cursor + delta)) })
  }
  if ('page' in sc) {
    const n = pageCount(sc, s)
    return updateTop(s, { page: Math.max(0, Math.min(n - 1, sc.page + delta)) })
  }
  return s
}

function tap(s: State): Step {
  if (s.now - s.lastHoldEnd < TAP_GUARD_MS) return step(s)
  const sc = top(s)
  switch (sc.name) {
    case 'home': {
      const entry = homeEntries(s.home, s.now)[sc.cursor]
      if (!entry) return step(s)
      const t = entry.target
      switch (t.kind) {
        case 'meeting':
          return step(push(s, { name: 'meeting', id: t.id, data: null, page: 0 }), [req({ type: 'meeting.get', eventId: t.id })])
        case 'inbox':
          return step(push(s, { name: 'inbox', cursor: 0 }), [req({ type: 'inbox.get' })])
        case 'draft': {
          const draft = s.home?.pendingDrafts.find(d => d.id === t.id)
          return draft ? step(push(s, { name: 'draft', draft, page: 0 })) : step(s)
        }
        case 'invite': {
          const invite = s.home?.pendingInvites.find(i => i.id === t.id)
          return invite ? step(push(s, { name: 'invite', invite, page: 0 })) : step(s)
        }
        case 'recent':
          return step(push(s, { name: 'recent', cursor: 0 }))
        case 'chat':
          return openChat(s)
        case 'dino':
          return step(push(s, { name: 'game', dino: newGame(s.dinoBest) }))
        case 'action': {
          const pending = s.home?.pendingActions.find(a => a.id === t.id)
          return pending ? step(push(s, { name: 'approval', pending, lines: [pending.label], page: 0 })) : step(s)
        }
      }
      return step(s)
    }
    case 'chat': {
      const pages = chatPages(s.chat ?? [])
      const page = pages[Math.min(sc.page, pages.length - 1)]
      // Tap opens what the reply attached; with nothing attached, tap means "ask".
      if (!page || !turnOf(s, page.turnId)?.reply.card) return startVoice(s, { kind: 'chat', ctx: { screen: 'chat' } }, 'toggle')
      return openTurnCard(s, page.turnId)
    }
    case 'card': {
      const card = turnOf(s, sc.turnId)?.reply.card
      const item = card?.kind === 'list' ? card.items[sc.cursor] : undefined
      if (!item) return step(s)
      switch (item.kind) {
        case 'email':
          return step(push(s, { name: 'email', id: item.id, email: null, page: 0 }), [req({ type: 'email.get', id: item.id })])
        case 'event':
          return step(push(s, { name: 'meeting', id: item.id, data: null, page: 0 }), [req({ type: 'meeting.get', eventId: item.id })])
        case 'file':
          return askAbout(s, item, 'Open it')
        case 'contact':
          return askAbout(s, item, 'Use this one')
        case 'row':
        case 'text':
          return step(s)
      }
      return step(s)
    }
    case 'textCard':
      return step(s)
    case 'game':
      return step(updateTop(s, { dino: jump(sc.dino) }))
    case 'approval': {
      const p = sc.pending
      return step(
        openMenu(s, 'Approve?', [
          { label: p.label, action: { kind: 'actionAct', id: p.id, approve: true, label: 'Working...' } },
          { label: 'Discard', action: { kind: 'actionAct', id: p.id, approve: false, label: 'Discarding...' } },
        ]),
      )
    }
    case 'inbox': {
      const item = s.inbox?.[sc.cursor]
      if (!item) return step(s)
      return step(push(s, { name: 'email', id: item.id, email: null, page: 0 }), [req({ type: 'email.get', id: item.id })])
    }
    case 'email': {
      if (!sc.email) return step(s)
      const e = sc.email
      const items: MenuItem[] = [
        ...e.suggestions.map((sg, index) => ({ label: `Reply: ${sg.label}`, action: { kind: 'suggestion', emailId: e.id, index } as const })),
        { label: '● Dictate a reply', action: { kind: 'voice', ctx: { kind: 'reply', emailId: e.id }, label: 'reply' } },
      ]
      return step(openMenu(s, `Reply to ${firstName(e.from)}`, items))
    }
    case 'meeting':
      return step(
        openMenu(s, 'Meeting', [
          { label: '● Dictate a follow-up email', action: { kind: 'voice', ctx: { kind: 'followup', eventId: sc.id }, label: 'follow-up' } },
        ]),
      )
    case 'menu': {
      if (s.now - sc.openedAt < TAP_GUARD_MS) return step(s)
      const item = sc.items[sc.cursor]
      return item ? runMenuAction(s, item.action) : step(s)
    }
    case 'dictate':
      return stopVoice(s)
    case 'contacts': {
      const t = thinking(pop(s), 'Preparing...')
      return step(t.state, [req({ type: 'contact.pick', pendingId: sc.pendingId, index: sc.cursor }, t.token)])
    }
    case 'draft': {
      const d = sc.draft
      const to = names(d.to, 2)
      return step(
        openMenu(s, `Draft to ${to}`, [
          { label: `Send to ${to}`, action: { kind: 'draftAct', draftId: d.id, action: 'send', label: 'Sending...' } },
          { label: 'Save to Gmail drafts', action: { kind: 'draftAct', draftId: d.id, action: 'save', label: 'Saving...' } },
          { label: '● Redo by voice', action: { kind: 'voice', ctx: { kind: 'redo', draftId: d.id }, label: 'redo' } },
          { label: 'Discard', action: { kind: 'draftAct', draftId: d.id, action: 'discard', label: 'Discarding...' } },
        ]),
      )
    }
    case 'invite': {
      const i = sc.invite
      return step(
        openMenu(s, i.title, [
          { label: i.attendees.length ? `Send invite to ${names(i.attendees, 2)}` : 'Add to calendar', action: { kind: 'inviteAct', inviteId: i.id, action: 'create', label: 'Creating...' } },
          { label: 'Discard', action: { kind: 'inviteAct', inviteId: i.id, action: 'discard', label: 'Discarding...' } },
        ]),
      )
    }
    case 'result':
      if (sc.retry) return startVoice(pop(s), sc.retry, 'toggle')
      return step(pop(s), [req({ type: 'home.get' })])
    case 'recent':
      return step(s)
    case 'auth':
      return sc.waiting ? step(s) : step(updateTop(s, { waiting: true }), [req({ type: 'auth.start' })])
    case 'thinking':
      return step(s)
  }
}

function onGesture(s: State, g: Gesture): Step {
  const sc = top(s)
  if (g === 'exit') return step(s, [{ kind: 'mic', on: false }])
  if (g === 'foreground') return step(s, [req({ type: 'home.get' }), ...(sc.name === 'inbox' ? [req({ type: 'inbox.get' })] : [])])
  if (g === 'background') return step(s)

  if (s.conn !== 'ready') return g === 'double' ? step(s, [{ kind: 'exit' }]) : step(s)

  if (sc.name === 'game') {
    if (g === 'up' || g === 'tap') return step(updateTop(s, { dino: jump(sc.dino) }))
    if (g === 'down') return step(updateTop(s, { dino: duck(sc.dino) }))
    if (g === 'double') return step(pop({ ...s, dinoBest: Math.max(s.dinoBest, sc.dino.best, sc.dino.score) }), [{ kind: 'saveBest', best: Math.max(s.dinoBest, sc.dino.best, sc.dino.score) }])
    return step(s)
  }

  switch (g) {
    case 'up':
      return step(move(s, -1))
    case 'down':
      return step(move(s, 1))
    case 'tap':
      return tap(s)
    case 'double':
      if (sc.name === 'dictate') return cancelVoice(s)
      if (s.stack.length === 1 || sc.name === 'auth') return step(s, [{ kind: 'exit' }])
      // Coming back home: refresh so new pending drafts and read counts show.
      return step(pop(s), top(pop(s)).name === 'home' ? [req({ type: 'home.get' })] : [])
    case 'holdStart': {
      const ctx = voiceContextFor(sc, s)
      return ctx ? startVoice(s, ctx, 'hold') : step(s)
    }
    case 'holdEnd': {
      const next = { ...s, lastHoldEnd: s.now }
      return sc.name === 'dictate' && sc.mode === 'hold' ? stopVoice(next) : step(next)
    }
  }
}

function showVoiceResult(s: State, r: VoiceResult): State {
  switch (r.kind) {
    case 'draft':
      return push(s, { name: 'draft', draft: r.draft, page: 0 })
    case 'invite':
      return push(s, { name: 'invite', invite: r.invite, page: 0 })
    case 'contacts':
      return push(s, { name: 'contacts', pendingId: r.pendingId, query: r.query, candidates: r.candidates, cursor: 0 })
    case 'unknown':
      return result(s, r.transcript ? `${r.hint}\n\nHeard: "${r.transcript}"` : r.hint, false, retryContext(s))
  }
}

/** The voice context to retry with: whatever the thinking screen on top was started for. */
function retryContext(s: State): VoiceContext | undefined {
  const dictateCtx = s.lastVoiceCtx
  return dictateCtx ?? undefined
}

/** Keeps list cursors on a real row after the data under them shrinks. */
function clampCursors(s: State): State {
  const stack = s.stack.map(sc => {
    if ('cursor' in sc && sc.name !== 'menu' && sc.name !== 'contacts') {
      const max = Math.max(0, listLength(sc, s) - 1)
      return sc.cursor > max ? { ...sc, cursor: max } : sc
    }
    if (sc.name === 'chat') return { ...sc, page: Math.min(sc.page, Math.max(0, chatPages(s.chat ?? []).length - 1)) }
    return sc
  })
  return { ...s, stack }
}

/** True if the thinking screen waiting for `token` is still on top (not cancelled). */
function awaiting(s: State, token: number | undefined): boolean {
  const sc = top(s)
  return token !== undefined && sc.name === 'thinking' && sc.token === token
}

function onResponse(s: State, res: ResponseMap[Request['type']], token?: number): Step {
  switch (res.type) {
    case 'home': {
      let next: State = { ...s, home: res.data, homeError: '' }
      if (top(next).name === 'auth') next = pop(next)
      return step(clampCursors(next))
    }
    case 'inbox':
      return step(clampCursors({ ...s, inbox: res.items }))
    case 'email': {
      const stack = s.stack.map(sc => (sc.name === 'email' && sc.id === res.email.id ? { ...sc, email: res.email } : sc))
      const inbox = s.inbox?.map(i => (i.id === res.email.id ? { ...i, unread: false } : i)) ?? null
      return step({ ...s, stack, inbox })
    }
    case 'meeting': {
      const stack = s.stack.map(sc => (sc.name === 'meeting' && sc.id === res.meeting.id ? { ...sc, data: { meeting: res.meeting, briefing: res.briefing } } : sc))
      return step({ ...s, stack })
    }
    case 'voice.result':
      if (!awaiting(s, token)) return step(s) // user cancelled; the draft stays pending on home
      return step(showVoiceResult(pop(s), res.result))
    case 'chat.reply':
      if (!awaiting(s, token)) return step({ ...s, chat: [...(s.chat ?? []), { id: res.reply.turnId, at: new Date(s.now).toISOString(), heard: '', reply: res.reply }] })
      return step(showChatReply(s, res.reply))
    case 'chat.history':
      return step(clampCursors({ ...s, chat: res.turns }))
    case 'done': {
      if (!awaiting(s, token)) return step(s, [req({ type: 'home.get' })])
      return step(result(popTransient(s), res.message, true), [req({ type: 'home.get' })])
    }
    case 'ok':
      return step(s)
  }
}

function onFailed(s: State, r: Request, code: string, message: string, token?: number): Step {
  if (code === 'AUTH') {
    const sc = top(s)
    const base = sc.name === 'thinking' || sc.name === 'dictate' ? pop(s) : s
    return step(top(base).name === 'auth' ? base : push(base, { name: 'auth', waiting: false }), [{ kind: 'mic', on: false }])
  }
  switch (r.type) {
    case 'home.get':
      return step({ ...s, homeError: message })
    case 'inbox.get':
      return step(top(s).name === 'inbox' ? result(pop(s), message, false) : s)
    case 'email.get':
    case 'meeting.get': {
      const sc = top(s)
      const loading = (sc.name === 'email' && !sc.email) || (sc.name === 'meeting' && !sc.data)
      return step(loading ? result(pop(s), message, false) : s)
    }
    case 'voice.start': {
      const sc = top(s)
      return step(sc.name === 'dictate' ? result(pop(s), message, false) : s, [{ kind: 'mic', on: false }])
    }
    case 'auth.start':
      return step(result(updateTop(s, { waiting: false }), message, false))
    default:
      if (!awaiting(s, token)) return step(s)
      return step(result(pop(s), message, false))
  }
}

export function reduce(s: State, a: Action): Step {
  switch (a.type) {
    case 'tick': {
      let next: State = { ...s, now: a.now }
      const sc = top(next)
      if (sc.name === 'result' && sc.until !== null && a.now >= sc.until) return step(pop(next), [req({ type: 'home.get' })])
      // Meeting nudge: jump the home cursor to a meeting that's about to start.
      const m = next.home?.nextMeeting
      if (m && sc.name === 'home' && m.id !== next.nudgedMeetingId && Date.parse(m.start) - a.now < NUDGE_MS) {
        next = updateTop({ ...next, nudgedMeetingId: m.id }, { cursor: 0 })
      }
      return step(next)
    }

    case 'conn': {
      if (a.conn !== 'ready') {
        // A dropped connection kills any voice session on the bridge.
        const sc = top(s)
        let next: State = { ...s, conn: a.conn, connDetail: a.detail ?? '' }
        if (sc.name === 'dictate' || sc.name === 'thinking') next = result(pop(next), 'Connection lost. Try again.', false)
        return step(next, sc.name === 'dictate' ? [{ kind: 'mic', on: false }] : [])
      }
      let next: State = { ...s, conn: 'ready', connDetail: '', fake: a.fake ?? false }
      const effects: Effect[] = [req({ type: 'home.get' })]
      if (a.authNeeded && top(next).name !== 'auth') next = push(next, { name: 'auth', waiting: false })
      // Reload whatever the current screen was waiting for.
      const sc = top(next)
      if (sc.name === 'inbox') effects.push(req({ type: 'inbox.get' }))
      if (next.stack.some(x => x.name === 'chat')) effects.push(req({ type: 'chat.history' }))
      if (sc.name === 'email' && !sc.email) effects.push(req({ type: 'email.get', id: sc.id }))
      if (sc.name === 'meeting' && !sc.data) effects.push(req({ type: 'meeting.get', eventId: sc.id }))
      return step(next, effects)
    }

    case 'gesture':
      // Timing guards need the gesture's own time, not the last 1 s tick.
      return onGesture({ ...s, now: a.now }, a.gesture)

    case 'micLevel':
      return step(top(s).name === 'dictate' ? { ...s, micLevel: a.level } : s)

    case 'gameTick': {
      const sc = top(s)
      if (sc.name !== 'game') return step(s)
      const dino = dinoTick(sc.dino, a.dt)
      const effects: Effect[] = dino.over && !sc.dino.over && dino.best > s.dinoBest ? [{ kind: 'saveBest', best: dino.best }] : []
      return step(updateTop({ ...s, dinoBest: Math.max(s.dinoBest, dino.best) }, { dino }), effects)
    }

    case 'dinoBest':
      return step({ ...s, dinoBest: Math.max(s.dinoBest, a.best) })

    case 'gameFps':
      return step({ ...s, gameFps: a.fps })

    case 'micSilent': {
      const sc = top(s)
      return step(sc.name === 'dictate' ? updateTop(s, { micWarning: true }) : s)
    }

    case 'push': {
      const m = a.msg
      const sc = top(s)
      switch (m.type) {
        case 'transcript':
          return step(sc.name === 'dictate' ? updateTop(s, { final: m.final, interim: m.interim }) : s)
        case 'busy':
          return step(sc.name === 'thinking' ? updateTop(s, { label: m.label }) : s)
        case 'changed':
          // Another client (phone page, a second pair of glasses) may have chatted: refresh the view too.
          if (m.what === 'home') return step(s, [req({ type: 'home.get' }), ...(s.stack.some(x => x.name === 'chat') ? [req({ type: 'chat.history' })] : [])])
          return step(s, s.inbox || sc.name === 'inbox' ? [req({ type: 'inbox.get' })] : [])
        case 'auth.needed':
          return step(sc.name === 'auth' ? s : push(s, { name: 'auth', waiting: false }))
      }
      return step(s)
    }

    case 'response':
      return onResponse(s, a.res, a.token)

    case 'failed':
      return onFailed(s, a.req, a.code, a.message, a.token)
  }
}
