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
    const { s, effects } = run(ready(), g('down'), g('tap'))
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
    const thinking = run(ready(), g('down'), g('down'), g('tap'), g('tap', T0 + 12_000)).s // speak → stop
    expect(top(thinking).name).toBe('thinking')
    const token = (top(thinking) as { token: number }).token
    const cancelled = run(thinking, g('double', T0 + 12_500)).s
    const after = run(cancelled, { type: 'response', req: { type: 'voice.stop' }, res: { type: 'voice.result', result: { kind: 'draft', draft } }, token }).s
    expect(top(after).name).toBe('home')
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
    const moved = run(ready(), g('down'), g('down')).s // on "Speak" (row 2 of 3)
    const small: HomeData = { ...home, nextMeeting: undefined }
    const after = run(moved, { type: 'response', req: { type: 'home.get' }, res: { type: 'home', data: small } }).s
    expect(top(after)).toMatchObject({ name: 'home', cursor: 1 })
  })
})
