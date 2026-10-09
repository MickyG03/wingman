import { describe, expect, it } from 'vitest'
import type { ChatReply, Draft, EmailDetail, HomeData } from '../../shared/protocol'
import { reduce } from '../src/app/reducer'
import type { Gesture } from '../src/glasses/input'
import { initialState, top, type Action, type State } from '../src/app/state'
import { BODY_LINES, renderList, TEXT_W, width, wrap } from '../src/render/text'

const T0 = 1_000_000

const home: HomeData = {
  nextMeeting: {
    id: 'm1', title: 'Design review', start: new Date(T0 + 5 * 60_000).toISOString(),
    end: new Date(T0 + 35 * 60_000).toISOString(), allDay: false, attendees: [{ name: 'Priya Sharma', email: 'p@x.com' }],
  },
  upcoming: [],
  unread: 2,
  importantUnread: 1,
  pendingDrafts: [],
  pendingInvites: [],
  pendingActions: [],
  recent: [],
}

const email: EmailDetail = {
  id: 'e1', threadId: 't1', from: { name: 'Sam Lee', email: 's@x.com' }, subject: 'Lunch?', summary: 'Lunch Thursday',
  category: 'action', important: true, unread: false, receivedAt: new Date(T0).toISOString(), to: [], cc: [],
  bodyText: 'Want to grab lunch?', suggestions: [{ label: 'Sounds good', text: 'Hi Sam, sounds good!' }],
}

const draft: Draft = {
  id: 'd1', kind: 'reply', to: [email.from], cc: [], subject: 'Re: Lunch?', body: 'Hi Sam', status: 'pending', createdAt: '',
}

function run(state: State, ...actions: Action[]) {
  let s = state
  let effects: ReturnType<typeof reduce>['effects'] = []
  for (const a of actions) ({ state: s, effects } = reduce(s, a))
  return { s, effects }
}

const ready = (): State =>
  run(initialState(T0), { type: 'conn', conn: 'ready' }, { type: 'response', req: { type: 'home.get' }, res: { type: 'home', data: home } }).s

const g = (gesture: Gesture, now = T0 + 10_000): Action => ({
  type: 'gesture',
  gesture,
  now,
})

describe('reducer', () => {
  it('opens the inbox from home and asks the bridge for it', () => {
    const { s, effects } = run(ready(), g('down'), g('down'), g('tap'))
    expect(top(s).name).toBe('inbox')
    expect(effects).toEqual([{ kind: 'request', req: { type: 'inbox.get' }, token: undefined }])
  })

  it('ignores a tap that lands right after a menu opens', () => {
    const onEmail = { ...ready(), stack: [...ready().stack, { name: 'email' as const, id: 'e1', email, page: 0 }] }
    const opened = run(onEmail, g('tap', T0 + 10_000)).s
    expect(top(opened).name).toBe('menu')
    expect(top(run(opened, g('tap', T0 + 10_100)).s).name).toBe('menu') // too soon: ignored
    const picked = run(opened, g('tap', T0 + 10_600))
    expect(top(picked.s).name).toBe('thinking')
    expect(picked.effects[0]).toMatchObject({ req: { type: 'draft.fromSuggestion', emailId: 'e1', index: 0 } })
  })

  it('push-to-talk on an email dictates a reply', () => {
    const onEmail = { ...ready(), stack: [...ready().stack, { name: 'email' as const, id: 'e1', email, page: 0 }] }
    const holding = run(onEmail, g('holdStart'))
    expect(top(holding.s)).toMatchObject({ name: 'dictate', mode: 'hold', ctx: { kind: 'reply', emailId: 'e1' } })
    expect(holding.effects).toEqual([
      { kind: 'request', req: { type: 'voice.start', ctx: { kind: 'reply', emailId: 'e1' } }, token: undefined },
      { kind: 'mic', on: true },
    ])
    const released = run(holding.s, g('holdEnd', T0 + 13_000))
    expect(top(released.s).name).toBe('thinking')
    expect(released.effects.map(e => (e.kind === 'request' ? e.req.type : e.kind))).toEqual(['mic', 'voice.stop'])
    // The release must not also count as a tap on the next screen.
    expect(top(run(released.s, g('tap', T0 + 13_100)).s).name).toBe('thinking')
  })

  it('drops a voice result that arrives after the user cancelled', () => {
    const thinking = run(ready(), g('down'), g('tap'), g('tap', T0 + 11_000), g('tap', T0 + 12_000)).s // Ask → chat → ask → stop
    expect(top(thinking).name).toBe('thinking')
    const token = (top(thinking) as { token: number }).token
    const cancelled = run(thinking, g('double', T0 + 12_500)).s
    const after = run(cancelled, { type: 'response', req: { type: 'voice.stop' }, res: { type: 'voice.result', result: { kind: 'draft', draft } }, token }).s
    expect(top(after).name).toBe('chat') // back where the user asked, not on the late draft
  })

  it('after sending, returns to the email with a confirmation', () => {
    const base = { ...ready(), stack: [...ready().stack, { name: 'email' as const, id: 'e1', email, page: 0 }, { name: 'draft' as const, draft, page: 0 }] }
    const menu = run(base, g('tap', T0 + 10_000)).s
    const sending = run(menu, g('tap', T0 + 11_000))
    expect(sending.effects[0]).toMatchObject({ req: { type: 'draft.act', draftId: 'd1', action: 'send' } })
    const token = (top(sending.s) as { token: number }).token
    const done = run(sending.s, { type: 'response', req: { type: 'draft.act', draftId: 'd1', action: 'send' }, res: { type: 'done', kind: 'sent', message: 'Sent to Sam' }, token }).s
    expect(done.stack.map(x => x.name)).toEqual(['home', 'email', 'result'])
  })

  it('turns off the mic when the connection drops mid-dictation', () => {
    const dictating = run(ready(), g('holdStart')).s
    const { s, effects } = run(dictating, { type: 'conn', conn: 'offline', detail: 'retrying' })
    expect(top(s)).toMatchObject({ name: 'result', ok: false })
    expect(effects).toEqual([{ kind: 'mic', on: false }])
  })

  it('shows the sign-in screen when the bridge says Google auth is needed', () => {
    const { s } = run(ready(), { type: 'failed', req: { type: 'inbox.get' }, code: 'AUTH', message: 'sign in' })
    expect(top(s).name).toBe('auth')
  })
})

describe('text layout', () => {
  it('wraps to the pixel width', () => {
    const lines = wrap('The quick brown fox jumps over the lazy dog. '.repeat(6))
    expect(lines.length).toBeGreaterThan(1)
    for (const l of lines) expect(width(l)).toBeLessThanOrEqual(TEXT_W)
  })

  it('hard-breaks a word longer than a line', () => {
    for (const l of wrap('x'.repeat(300))) expect(width(l)).toBeLessThanOrEqual(TEXT_W)
  })

  it('keeps the cursor visible in long lists', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({ lines: [`Item ${i}`, 'detail'] }))
    const out = renderList(entries, 9)
    expect(out.length).toBeLessThanOrEqual(BODY_LINES)
    expect(out.some(l => l.startsWith('> Item 9'))).toBe(true)
  })
})

describe('cursor clamping', () => {
  it('keeps the home cursor on a row when home data shrinks', () => {
    const moved = run(ready(), g('down'), g('down'), g('down')).s // on "Dino run" (row 3 of 4)
    const small: HomeData = { ...home, nextMeeting: undefined }
    const after = run(moved, { type: 'response', req: { type: 'home.get' }, res: { type: 'home', data: small } }).s
    expect(top(after)).toMatchObject({ name: 'home', cursor: 2 })
  })
})

describe('voice results', () => {
  it('keeps an unknown result on screen and retries on tap', () => {
    const thinking = run(ready(), g('down'), g('tap'), g('tap', T0 + 11_000), g('tap', T0 + 12_000)).s
    const token = (top(thinking) as { token: number }).token
    const shown = run(thinking, {
      type: 'response', req: { type: 'voice.stop' }, token,
      res: { type: 'voice.result', result: { kind: 'unknown', hint: 'Who should it go to?', transcript: 'email that I am late' } },
    }).s
    expect(top(shown)).toMatchObject({ name: 'result', ok: false, until: null, retry: { kind: 'chat' } })
    // Does not auto-close.
    expect(top(run(shown, { type: 'tick', now: T0 + 60_000 }).s).name).toBe('result')
    const retried = run(shown, g('tap', T0 + 13_000))
    expect(top(retried.s)).toMatchObject({ name: 'dictate', ctx: { kind: 'chat' } })
    expect(retried.effects[0]).toMatchObject({ req: { type: 'voice.start', ctx: { kind: 'chat' } } })
  })

  it('shows what was heard while thinking', () => {
    const dictating = run(ready(), g('holdStart')).s
    const heard = run(dictating, { type: 'push', msg: { type: 'transcript', final: 'email sam', interim: 'that' } }).s
    const thinking = run(heard, g('holdEnd', T0 + 15_000)).s
    expect(top(thinking)).toMatchObject({ name: 'thinking', heard: 'email sam that' })
  })
})

describe('chat agent', () => {
  const listReply: ChatReply = {
    turnId: 't1',
    text: 'Here are your unread emails.',
    card: { kind: 'list', title: 'Unread', items: [{ id: 'e1', kind: 'email', title: 'Sam: Lunch?' }, { id: 'e2', kind: 'email', title: 'Priya: Mocks' }] },
  }

  it('hold on home asks the agent and shows the chat with its card', () => {
    const holding = run(ready(), g('holdStart'))
    expect(top(holding.s)).toMatchObject({ name: 'dictate', ctx: { kind: 'chat', ctx: { screen: 'home' } } })
    const thinking = run(holding.s, g('holdEnd', T0 + 13_000)).s
    const token = (top(thinking) as { token: number }).token
    const shown = run(thinking, { type: 'response', req: { type: 'voice.stop' }, res: { type: 'chat.reply', reply: listReply }, token }).s
    expect(top(shown)).toMatchObject({ name: 'chat' })
    expect(shown.chat).toHaveLength(1)
    // Tap opens the card; tapping an email opens the email screen.
    const card = run(shown, g('tap', T0 + 14_000)).s
    expect(top(card)).toMatchObject({ name: 'card', turnId: 't1', cursor: 0 })
    const opened = run(card, g('down', T0 + 14_500), g('tap', T0 + 15_000))
    expect(top(opened.s)).toMatchObject({ name: 'email', id: 'e2' })
    expect(opened.effects[0]).toMatchObject({ req: { type: 'email.get', id: 'e2' } })
  })

  it('hold on the inbox tells the agent which email is highlighted', () => {
    const inbox = run(ready(), { type: 'response', req: { type: 'inbox.get' }, res: { type: 'inbox', items: [{ ...email, id: 'x1' }, { ...email, id: 'x2' }] } }).s
    const onInbox = { ...inbox, stack: [...inbox.stack, { name: 'inbox' as const, cursor: 1 }] }
    const { effects } = run(onInbox, g('holdStart'))
    expect(effects[0]).toMatchObject({ req: { type: 'voice.start', ctx: { kind: 'chat', ctx: { screen: 'inbox', focusEmailId: 'x2' } } } })
  })

  it('an edit the agent prepared opens for approval and sends action.act on approve', () => {
    const reply: ChatReply = {
      turnId: 't2',
      text: 'Row is ready to add. Tap to approve.',
      card: { kind: 'edit', title: 'Add to Offsite budget', lines: ['Vineyard | 12000'] },
      pending: { id: 'act-1', kind: 'action', label: 'Add 1 row to "Offsite budget"' },
    }
    const thinking = run(ready(), g('holdStart'), g('holdEnd', T0 + 13_000)).s
    const token = (top(thinking) as { token: number }).token
    const shown = run(thinking, { type: 'response', req: { type: 'voice.stop' }, res: { type: 'chat.reply', reply }, token }).s
    expect(top(shown)).toMatchObject({ name: 'approval', pending: { id: 'act-1' } })
    expect(shown.stack.map(x => x.name)).toEqual(['home', 'chat', 'approval'])
    const menu = run(shown, g('tap', T0 + 14_000)).s
    expect(top(menu)).toMatchObject({ name: 'menu', title: 'Approve?' })
    const approved = run(menu, g('tap', T0 + 15_000))
    expect(approved.effects[0]).toMatchObject({ req: { type: 'action.act', id: 'act-1', action: 'approve' } })
    const tok = (top(approved.s) as { token: number }).token
    const done = run(approved.s, { type: 'response', req: { type: 'action.act', id: 'act-1', action: 'approve' }, res: { type: 'done', kind: 'done', message: 'Done' }, token: tok }).s
    expect(done.stack.map(x => x.name)).toEqual(['home', 'chat', 'result'])
  })

  it('a draft the agent prepared opens the existing draft screen over the chat', () => {
    const reply: ChatReply = { turnId: 't3', text: 'Ready to send.', card: { kind: 'draft', draft }, pending: { id: 'd1', kind: 'draft', label: 'Send to Sam' } }
    const thinking = run(ready(), g('holdStart'), g('holdEnd', T0 + 13_000)).s
    const token = (top(thinking) as { token: number }).token
    const shown = run(thinking, { type: 'response', req: { type: 'voice.stop' }, res: { type: 'chat.reply', reply }, token }).s
    expect(shown.stack.map(x => x.name)).toEqual(['home', 'chat', 'draft'])
  })

  it('every chat page fits the display', async () => {
    const { chatPages } = await import('../src/render/screens')
    const long: ChatReply = { turnId: 't4', text: 'word '.repeat(80), card: { kind: 'text', title: 'Doc', text: 'x' } }
    const pages = chatPages([{ id: 't4', at: '', heard: 'tell me everything about the onboarding launch plan please', reply: long }])
    expect(pages.length).toBeGreaterThan(1)
    for (const p of pages) {
      expect(p.lines.length).toBeLessThanOrEqual(BODY_LINES)
      for (const l of p.lines) expect(width(l)).toBeLessThanOrEqual(TEXT_W)
    }
  })
})

describe('dino engine', () => {
  it('starts on tap, jumps only from the ground, and ends on a cactus', async () => {
    const { newGame, jump, tick, duck, DINO_H, GROUND_Y } = await import('../src/game/dino')
    let g = jump(newGame(5)) // first tap starts
    expect(g.started).toBe(true)
    g = jump(g)
    expect(g.vy).toBeLessThan(0)
    const mid = tick(g, 150, () => 0.99)
    expect(jump(mid).vy).toBe(mid.vy) // no double jump in the air...
    expect(jump(mid).jumpUntil).toBeGreaterThan(mid.t) // ...but the tap is remembered until landing
    // Run straight into a cactus with no input.
    let run = { ...newGame(5), started: true, obstacles: [{ x: 60, w: 13, h: 16, flying: false }], nextAt: 1e9 }
    for (let i = 0; i < 20 && !run.over; i++) run = tick(run, 50, () => 0.99)
    expect(run.over).toBe(true)
    // Ducking under a flyer survives.
    let fly = { ...newGame(5), started: true, obstacles: [{ x: 60, w: 20, h: 7, flying: true }], nextAt: 1e9 }
    for (let i = 0; i < 20 && !fly.over; i++) fly = tick(duck(fly), 50, () => 0.99)
    expect(fly.over).toBe(false)
    expect(fly.y).toBe(GROUND_Y - DINO_H)
  })
})

describe('dino levels', () => {
  it('stitches fixed segments, never repeating one back to back, and keeps gaps jumpable', async () => {
    const { newGame, tick, pickSegment } = await import('../src/game/dino')
    let g = { ...newGame(), started: true }
    const seen: number[] = []
    let last = -1
    for (let i = 0; i < 200; i++) {
      const pick = pickSegment(30_000, last, Math.random)
      expect(pick).not.toBe(last)
      seen.push(pick)
      last = pick
    }
    expect(new Set(seen).size).toBeGreaterThan(8)
    // Run the world for a while with a stuck RNG: obstacles must always be spaced apart.
    for (let i = 0; i < 400; i++) g = { ...tick(g, 50, () => 0.42), over: false, y: -500 } // keep it airborne so nothing ends the run
    const xs = g.obstacles.map(o => o.x).sort((a, b) => a - b)
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(110)
  })
})
