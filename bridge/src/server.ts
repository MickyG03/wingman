import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage, type VoiceContext } from '../../shared/protocol.ts'
import { FakeAi } from './ai/fake.ts'
import { GeminiAi } from './ai/gemini.ts'
import type { Ai } from './ai/types.ts'
import { Agent } from './agent/agent.ts'
import { GeminiLlm, ScriptedLlm } from './agent/llm.ts'
import { attachWorkspaceMcp } from './agent/mcp.ts'
import { config, DATA_DIR, paths } from './config.ts'
import { DraftStore } from './drafts.ts'
import { GoogleAuth } from './google/auth.ts'
import { GoogleCalendar } from './google/calendar.ts'
import { GoogleDocs } from './google/docs.ts'
import { GoogleDrive } from './google/drive.ts'
import { FakeCalendar, FakeMail, FakeWorkspace } from './google/fake.ts'
import { GmailMail } from './google/gmail.ts'
import { GooglePeople } from './google/people.ts'
import { GoogleSheets } from './google/sheets.ts'
import { Session } from './session.ts'
import { deepgramStt } from './stt/deepgram.ts'
import { fakeStt } from './stt/fake.ts'
import type { SttFactory } from './stt/types.ts'
import { Wingman, WingmanError } from './wingman.ts'

if (config.token.length < 16) {
  console.error('WINGMAN_TOKEN is missing or too short. Copy .env.example to .env and set it.')
  process.exit(1)
}

// ── Wiring ──────────────────────────────────────────────────────────────

const googleAuth = config.fakeGoogle ? null : new GoogleAuth()
const mail = googleAuth ? new GmailMail(googleAuth) : new FakeMail()
const calendar = googleAuth ? new GoogleCalendar(googleAuth) : new FakeCalendar()
// Fake mode keeps drafts in memory so demo drafts never mix with real ones.
const drafts = new DraftStore(config.fakeGoogle ? null : paths.drafts)

let wingman: Wingman
const user = () => wingman.userContext()
const ai: Ai = config.geminiKey ? new GeminiAi(config.geminiKey, config.geminiModel, config.geminiFallbackModel, user, config.timeZone) : new FakeAi(user)
const people = googleAuth ? new GooglePeople(googleAuth) : null
wingman = new Wingman({ mail, calendar, ai, drafts, googleAuth, people, contactsFile: googleAuth ? paths.contacts : null })

// Chat agent ("Ask Wingman"): Gemini with a manual tool loop, or a scripted
// stand-in that walks the same tools against the fixtures.
const workspace = googleAuth ? null : new FakeWorkspace()
const llm = config.geminiKey ? new GeminiLlm(config.geminiKey, config.geminiModel, config.geminiFallbackModel) : new ScriptedLlm()
const agent = new Agent({
  llm,
  mail,
  calendar,
  drive: googleAuth ? new GoogleDrive(googleAuth) : workspace!,
  docs: googleAuth ? new GoogleDocs(googleAuth) : workspace!,
  sheets: googleAuth ? new GoogleSheets(googleAuth) : workspace!,
  contacts: wingman.contactIndex,
  drafts,
  host: wingman.host,
  user,
  timeZone: config.timeZone,
  dataDir: googleAuth ? DATA_DIR : null,
  maxCalls: config.agentMaxCalls,
  maxTurns: config.chatTurns,
})
wingman.attachAgent(agent)
if (config.workspaceMcp && googleAuth) {
  attachWorkspaceMcp(googleAuth).then(tools => agent.addTools(tools), err => console.warn(`[mcp] ${(err as Error).message}`))
}

// A scripted transcript is only safe against demo data: with real Gmail it
// could draft to a real contact the user never mentioned.
const useFakeStt = config.fakeStt || (!config.deepgramKey && config.fakeGoogle)
const sttFor = (ctx: VoiceContext): SttFactory => {
  if (useFakeStt) return fakeStt(() => ctx.kind)
  if (!config.deepgramKey) throw new WingmanError('STT', 'Voice needs DEEPGRAM_API_KEY in bridge/.env')
  return deepgramStt(config.deepgramKey, config.deepgramModel)
}

// ── Transport ───────────────────────────────────────────────────────────

// Browsers can't set headers on a WebSocket, so the token arrives as the first
// message rather than in a header or query string (which would end up in logs).
const AUTH_TIMEOUT_MS = 5000

function tokenMatches(candidate: unknown): boolean {
  if (typeof candidate !== 'string') return false
  const a = Buffer.from(candidate)
  const b = Buffer.from(config.token)
  return a.length === b.length && timingSafeEqual(a, b)
}

const sessions = new Set<Session>()
const broadcast = (msg: ServerMessage) => sessions.forEach(s => s.send(msg))
wingman.on('changed', (what: 'home' | 'inbox') => broadcast({ type: 'changed', what }))
wingman.on('auth.needed', () => broadcast({ type: 'auth.needed' }))

const http = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
    res.end(JSON.stringify({ ok: true, version: PROTOCOL_VERSION }))
    return
  }
  res.writeHead(404).end()
})

const wss = new WebSocketServer({ server: http, path: '/ws' })

wss.on('connection', (ws, req) => {
  const peer = req.socket.remoteAddress
  let session: Session | null = null
  const authTimer = setTimeout(() => ws.close(4001, 'auth timeout'), AUTH_TIMEOUT_MS)

  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      session?.onAudio(raw as Buffer)
      return
    }

    let msg: ClientMessage
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      ws.send(JSON.stringify({ type: 'error', code: 'BAD_REQUEST', message: 'invalid JSON' } satisfies ServerMessage))
      return
    }

    if (!session) {
      if (msg.type === 'hello' && tokenMatches(msg.token)) {
        clearTimeout(authTimer)
        session = new Session(ws, wingman, sttFor)
        sessions.add(session)
        console.log(`[bridge] client authenticated from ${peer}`)
        session.send({ type: 'ready', version: PROTOCOL_VERSION, authNeeded: wingman.authNeeded, fake: config.fakeGoogle })
      } else {
        console.warn(`[bridge] rejected client from ${peer}`)
        ws.close(4003, 'unauthorized')
      }
      return
    }

    if (msg.type === 'ping') session.send({ type: 'pong' })
    else if ('rid' in msg && typeof msg.rid === 'number') void session.onRequest(msg)
    else session.send({ type: 'error', code: 'BAD_REQUEST', message: `unexpected message: ${msg.type}` })
  })

  ws.on('close', () => {
    clearTimeout(authTimer)
    if (session) {
      session.close()
      sessions.delete(session)
      console.log(`[bridge] client from ${peer} disconnected`)
    }
  })
})

http.listen(config.port, () => {
  console.log(`[bridge] listening on http://localhost:${config.port} (ws path /ws)`)
  console.log(`[bridge] google: ${config.fakeGoogle ? 'FAKE fixtures (nothing is sent)' : googleAuth?.needed ? 'real, SIGN-IN NEEDED (npm run auth)' : 'real'}`)
  console.log(`[bridge] ai: ${ai.name}`)
  console.log(`[bridge] agent: ${llm.name}, ${agent.toolNames.length} tools${config.workspaceMcp ? ' + Workspace MCP' : ''}`)
  console.log(`[bridge] speech-to-text: ${useFakeStt ? 'FAKE (scripted)' : config.deepgramKey ? `deepgram ${config.deepgramModel}` : 'OFF (set DEEPGRAM_API_KEY)'}`)
  wingman.start()
})
