// Talk to the running bridge's chat agent from the terminal:
//   npm run chat -- "what is unread"
//   npm run chat -- --approve <pendingId>
//   npm run chat -- --reset
// Needs WINGMAN_TOKEN (from .env). Refuses to run against real Google unless
// ALLOW_REAL=1, so a scripted test can't send real mail by accident.

import WebSocket from 'ws'
import type { ClientMessage, Request, ServerMessage } from '../../shared/protocol.ts'

const args = process.argv.slice(2)
const url = `ws://localhost:${process.env.PORT ?? 8787}/ws`
const ws = new WebSocket(url)
let rid = 0
const waiting = new Map<number, (m: ServerMessage) => void>()

ws.on('message', raw => {
  const m = JSON.parse(raw.toString()) as ServerMessage
  if ('rid' in m) waiting.get(m.rid)?.(m)
  else if (m.type === 'busy') console.log(`  ... ${m.label}`)
  else if (m.type === 'ready') void main(m)
})
ws.on('error', err => {
  console.error(`Cannot reach bridge at ${url}: ${err.message}`)
  process.exit(1)
})
ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: process.env.WINGMAN_TOKEN ?? '' } satisfies ClientMessage)))

function send(req: Request): Promise<ServerMessage> {
  const id = ++rid
  return new Promise(resolve => {
    waiting.set(id, resolve)
    ws.send(JSON.stringify({ ...req, rid: id }))
  })
}

async function main(ready: Extract<ServerMessage, { type: 'ready' }>) {
  if (!ready.fake && process.env.ALLOW_REAL !== '1') {
    console.error('Bridge is on real Google. Set ALLOW_REAL=1 to chat against your real account.')
    process.exit(1)
  }
  const started = Date.now()
  let res: ServerMessage
  if (args[0] === '--reset') res = await send({ type: 'chat.reset' })
  else if (args[0] === '--approve' || args[0] === '--discard') res = await send({ type: 'action.act', id: args[1], action: args[0] === '--approve' ? 'approve' : 'discard' })
  else if (args[0] === '--send' || args[0] === '--save') res = await send({ type: 'draft.act', draftId: args[1], action: args[0] === '--send' ? 'send' : 'save' })
  else if (args[0] === '--invite') res = await send({ type: 'invite.act', inviteId: args[1], action: 'create' })
  else res = await send({ type: 'chat.send', text: args.join(' '), ctx: { screen: 'chat' } })

  if (res.type === 'chat.reply') {
    const r = res.reply
    console.log(`\nWingman: ${r.text}`)
    if (r.card?.kind === 'list') r.card.items.forEach((it, i) => console.log(`  ${i + 1}. [${it.kind}] ${it.title}${it.detail ? ` - ${it.detail}` : ''}  (${it.id})`))
    if (r.card?.kind === 'text') console.log(`  --- ${r.card.title} ---\n${r.card.text.split('\n').slice(0, 12).map(l => `  ${l}`).join('\n')}`)
    if (r.card?.kind === 'draft') console.log(`  Draft to ${r.card.draft.to.map(p => p.email).join(', ')}: "${r.card.draft.subject}"\n${r.card.draft.body.split('\n').map(l => `  | ${l}`).join('\n')}`)
    if (r.card?.kind === 'invite') console.log(`  Invite: ${r.card.invite.title} ${r.card.invite.start} with ${r.card.invite.attendees.map(a => a.email).join(', ')}`)
    if (r.card?.kind === 'edit') console.log(`  --- ${r.card.title} ---\n${r.card.lines.map(l => `  | ${l}`).join('\n')}`)
    if (r.pending) console.log(`  PENDING ${r.pending.kind} ${r.pending.id}: ${r.pending.label}`)
  } else console.log(JSON.stringify(res))
  console.log(`(${Date.now() - started}ms)`)
  process.exit(0)
}
