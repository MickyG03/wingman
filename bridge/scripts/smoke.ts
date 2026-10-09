// End-to-end check of a running bridge over the real WebSocket protocol:
//   npm run smoke            (expects the bridge on PORT with FAKE_GOOGLE=1)
// Walks home → inbox → email → meeting briefing → voice draft (with contact
// pick) → send, and reply-from-suggestion → save. Refuses to run against real
// Google so it can never send a real email.

import WebSocket from 'ws'
import type { ClientMessage, Request, ResponseMap, ServerMessage } from '../../shared/protocol.ts'

const url = `ws://localhost:${process.env.PORT ?? 8787}/ws`
const ws = new WebSocket(url)
let rid = 0
const waiting = new Map<number, (m: ServerMessage) => void>()
let readyResolve: (m: Extract<ServerMessage, { type: 'ready' }>) => void
const ready = new Promise<Extract<ServerMessage, { type: 'ready' }>>(r => (readyResolve = r))

ws.on('message', raw => {
  const m = JSON.parse(raw.toString()) as ServerMessage
  if ('rid' in m) waiting.get(m.rid)?.(m)
  else if (m.type === 'ready') readyResolve(m)
  else if (m.type === 'transcript') process.stdout.write(`\r  hearing: ${m.final} ${m.interim}`.padEnd(90))
  else if (m.type === 'busy') console.log(`\n  busy: ${m.label}`)
})

function send(m: ClientMessage) {
  ws.send(JSON.stringify(m))
}

async function req<T extends Request>(r: T): Promise<ResponseMap[T['type']]> {
  const id = ++rid
  const res = await new Promise<ServerMessage>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${r.type} timed out`)), 30_000)
    waiting.set(id, m => {
      clearTimeout(t)
      resolve(m)
    })
    send({ ...r, rid: id })
  })
  if ((res as { type: string }).type === 'error') throw new Error(`${r.type}: ${JSON.stringify(res)}`)
  return res as unknown as ResponseMap[T["type"]]
}

const step = (s: string) => console.log(`\n== ${s}`)

ws.on('open', async () => {
  try {
    send({ type: 'hello', token: process.env.WINGMAN_TOKEN ?? '' })
    const r = await ready
    if (!r.fake) throw new Error('Bridge is using real Google. Set FAKE_GOOGLE=1 before running the smoke test.')

    step('home')
    const home = (await req({ type: 'home.get' })).data
    console.log(`  next: ${home.nextMeeting?.title} | unread ${home.unread} (${home.importantUnread} important)`)

    step('inbox')
    const inbox = (await req({ type: 'inbox.get' })).items
    inbox.slice(0, 4).forEach(i => console.log(`  ${i.important ? '*' : ' '} ${i.from.name}: ${i.summary}`))

    step('email')
    const email = (await req({ type: 'email.get', id: inbox[0].id })).email
    console.log(`  ${email.subject} | ${email.suggestions.length} suggestions | body ${email.bodyText.length} chars`)

    step('meeting briefing')
    const mt = await req({ type: 'meeting.get', eventId: home.nextMeeting!.id })
    console.log(`  purpose: ${mt.briefing.purpose}\n  last: ${mt.briefing.lastThread}\n  points: ${mt.briefing.points.join(' / ')}`)

    step('voice: new email from home')
    await req({ type: 'voice.start', ctx: { kind: 'home' } })
    for (let i = 0; i < 15; i++) {
      ws.send(Buffer.alloc(3200)) // 100 ms of silence, like the simulator
      await new Promise(res => setTimeout(res, 100))
    }
    let result = (await req({ type: 'voice.stop' })).result
    if (result.kind === 'contacts') {
      console.log(`\n  "${result.query}" is ambiguous: ${result.candidates.map(c => c.name).join(' | ')}`)
      result = (await req({ type: 'contact.pick', pendingId: result.pendingId, index: 0 })).result
    }
    if (result.kind !== 'draft') throw new Error(`expected a draft, got ${JSON.stringify(result)}`)
    console.log(`  draft to ${result.draft.to.map(p => p.email).join(', ')}: "${result.draft.subject}"`)
    const sent = await req({ type: 'draft.act', draftId: result.draft.id, action: 'send' })
    console.log(`  ${sent.message}`)
    const again = await req({ type: 'draft.act', draftId: result.draft.id, action: 'send' })
    console.log(`  second send attempt: ${again.message}`)

    step('reply from suggestion → save to drafts')
    const withSuggestions = email.suggestions.length ? email : null
    if (withSuggestions) {
      const s = (await req({ type: 'draft.fromSuggestion', emailId: email.id, index: 0 })).result
      if (s.kind !== 'draft') throw new Error('expected draft')
      console.log(`  ${s.draft.subject} -> ${s.draft.to[0].email}`)
      console.log(`  ${(await req({ type: 'draft.act', draftId: s.draft.id, action: 'save' })).message}`)
    }

    step('home after')
    const after = (await req({ type: 'home.get' })).data
    console.log(`  unread ${after.unread}, pending drafts ${after.pendingDrafts.length}`)
    console.log('\nSMOKE OK')
    process.exit(0)
  } catch (err) {
    console.error(`\nSMOKE FAILED: ${(err as Error).message}`)
    process.exit(1)
  }
})
ws.on('error', err => {
  console.error(`Cannot reach bridge at ${url}: ${err.message}`)
  process.exit(1)
})
