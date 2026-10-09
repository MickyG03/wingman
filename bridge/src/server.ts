import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import type { ClientMessage, ServerMessage } from './protocol.ts'

const VERSION = '0.1.0'
const PORT = Number(process.env.PORT ?? 8787)
const TOKEN = process.env.WINGMAN_TOKEN ?? ''

if (TOKEN.length < 16) {
  console.error('WINGMAN_TOKEN is missing or too short. Copy .env.example to .env and set it.')
  process.exit(1)
}

// Browsers can't set headers on a WebSocket, so the token arrives as the first
// message rather than in a header or query string (which would end up in logs).
const AUTH_TIMEOUT_MS = 5000

function tokenMatches(candidate: unknown): boolean {
  if (typeof candidate !== 'string') return false
  const a = Buffer.from(candidate)
  const b = Buffer.from(TOKEN)
  return a.length === b.length && timingSafeEqual(a, b)
}

function send(ws: WebSocket, msg: ServerMessage) {
  ws.send(JSON.stringify(msg))
}

const http = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
    res.end(JSON.stringify({ ok: true, version: VERSION }))
    return
  }
  res.writeHead(404).end()
})

const wss = new WebSocketServer({ server: http, path: '/ws' })

wss.on('connection', (ws, req) => {
  const peer = req.socket.remoteAddress
  let authed = false
  const authTimer = setTimeout(() => ws.close(4001, 'auth timeout'), AUTH_TIMEOUT_MS)

  ws.on('message', raw => {
    let msg: ClientMessage
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      send(ws, { type: 'error', message: 'invalid JSON' })
      return
    }

    if (!authed) {
      if (msg.type === 'hello' && tokenMatches(msg.token)) {
        authed = true
        clearTimeout(authTimer)
        console.log(`[bridge] client authenticated from ${peer}`)
        send(ws, { type: 'ready', version: VERSION })
      } else {
        console.warn(`[bridge] rejected client from ${peer}`)
        ws.close(4003, 'unauthorized')
      }
      return
    }

    switch (msg.type) {
      case 'ping':
        send(ws, { type: 'pong' })
        break
      default:
        send(ws, { type: 'error', message: `unknown message type: ${(msg as { type: string }).type}` })
    }
  })

  ws.on('close', () => {
    clearTimeout(authTimer)
    if (authed) console.log(`[bridge] client from ${peer} disconnected`)
  })
})

http.listen(PORT, () => {
  console.log(`[bridge] listening on http://localhost:${PORT} (ws path /ws)`)
})
