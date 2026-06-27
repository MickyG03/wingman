// One authenticated glasses connection: routes requests to Wingman, streams
// mic audio to speech-to-text, and pushes updates back.

import type { WebSocket } from 'ws'
import type {
  ErrorCode,
  Request,
  ResponseMap,
  ServerMessage,
  VoiceContext,
} from '../../shared/protocol.ts'
import { AiError } from './ai/types.ts'
import { AuthNeededError } from './google/ports.ts'
import type { SttFactory, SttSession } from './stt/types.ts'
import { WingmanError, type Wingman } from './wingman.ts'

const BUSY_LABEL: Record<VoiceContext['kind'], string> = {
  home: 'Working on it...',
  chat: 'Thinking...',
  reply: 'Drafting reply...',
  followup: 'Drafting follow-up...',
  redo: 'Revising draft...',
}

// 16-bit PCM below this is effectively silence (a muted or denied mic sends zeros).
const SILENT_PEAK = 300

function peakLevel(chunk: Buffer): number {
  let peak = 0
  for (let i = 0; i + 1 < chunk.length; i += 2) {
    const v = Math.abs(chunk.readInt16LE(i))
    if (v > peak) peak = v
  }
  return peak
}

function classify(err: unknown): { code: ErrorCode; message: string } {
  if (err instanceof AuthNeededError) return { code: 'AUTH', message: err.message }
  if (err instanceof WingmanError) return { code: err.code, message: err.message }
  if (err instanceof AiError) return { code: 'AI', message: 'The AI could not answer. Try again.' }
  const status = (err as { response?: { status?: number } }).response?.status
  if (status) return { code: 'GOOGLE', message: `Google error ${status}. Try again.` }
  return { code: 'INTERNAL', message: (err as Error)?.message ?? 'Something went wrong' }
}

export class Session {
  private voice: { ctx: VoiceContext; stt: SttSession; bytes: number; peak: number } | null = null

  constructor(
    private readonly ws: WebSocket,
    private readonly wingman: Wingman,
    private readonly sttFor: (ctx: VoiceContext) => SttFactory,
  ) {}

  send(msg: ServerMessage) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg))
  }

  onAudio(chunk: Buffer) {
    if (!this.voice) return
    this.voice.bytes += chunk.length
    this.voice.peak = Math.max(this.voice.peak, peakLevel(chunk))
    this.voice.stt.push(chunk)
  }

  async onRequest(req: Request & { rid: number }) {
    const started = Date.now()
    try {
      const res = await this.dispatch(req)
      this.send({ rid: req.rid, ...res })
      console.log(`[req] ${req.type} ok ${Date.now() - started}ms`)
    } catch (err) {
      const e = classify(err)
      console.warn(`[req] ${req.type} failed (${e.code}): ${(err as Error)?.message ?? err}`)
      this.send({ rid: req.rid, type: 'error', ...e })
    }
  }

  close() {
    this.voice?.stt.cancel()
    this.voice = null
  }

  private async dispatch(req: Request): Promise<ResponseMap[Request['type']]> {
    const w = this.wingman
    switch (req.type) {
      case 'home.get':
        return { type: 'home', data: await w.home() }
      case 'inbox.get':
        return { type: 'inbox', items: await w.inboxItems() }
      case 'email.get':
        return { type: 'email', email: await w.email(req.id) }
      case 'meeting.get':
        return { type: 'meeting', ...(await w.meeting(req.eventId)) }
      case 'voice.start': {
        this.voice?.stt.cancel()
        const stt = this.sttFor(req.ctx)((final, interim) => this.send({ type: 'transcript', final, interim }))
        this.voice = { ctx: req.ctx, stt, bytes: 0, peak: 0 }
        return { type: 'ok' }
      }
      case 'voice.stop': {
        const v = this.voice
        if (!v) throw new WingmanError('BAD_REQUEST', 'Not listening')
        this.voice = null
        let transcript: string
        try {
          transcript = await v.stt.finish()
        } catch (err) {
          throw new WingmanError('STT', (err as Error).message)
        }
        // Log sizes only: transcripts can contain private details.
        const seconds = v.bytes / 32000
        console.log(`[voice] ${v.ctx.kind}: ${seconds.toFixed(1)}s audio, peak ${v.peak}/32767, ${transcript.length} chars`)
        if (seconds > 1 && v.peak < SILENT_PEAK) {
          console.warn('[voice] the audio was silent: the Even app probably lacks microphone permission, or the glasses mic did not open')
        }
        this.send({ type: 'busy', label: BUSY_LABEL[v.ctx.kind] })
        if (v.ctx.kind === 'chat') {
          const reply = await w.chat(transcript, v.ctx.ctx, undefined, label => this.send({ type: 'busy', label }))
          return { type: 'chat.reply', reply }
        }
        const result = await w.processVoice(v.ctx, transcript)
        console.log(`[voice] -> ${result.kind}`)
        return { type: 'voice.result', result }
      }
      case 'chat.send': {
        this.send({ type: 'busy', label: 'Thinking...' })
        const reply = await w.chat(req.text, req.ctx, req.pick, label => this.send({ type: 'busy', label }))
        return { type: 'chat.reply', reply }
      }
      case 'chat.history':
        return { type: 'chat.history', turns: w.chatHistory() }
      case 'chat.reset':
        w.chatReset()
        return { type: 'ok' }
      case 'action.act':
        return { type: 'done', ...(await w.actionAct(req.id, req.action === 'approve')) }
      case 'voice.cancel':
        this.close()
        return { type: 'ok' }
      case 'draft.get':
        return { type: 'voice.result', result: w.draftResult(req.draftId) }
      case 'draft.fromSuggestion':
        this.send({ type: 'busy', label: 'Preparing draft...' })
        return { type: 'voice.result', result: await w.fromSuggestion(req.emailId, req.index) }
      case 'contact.pick':
        return { type: 'voice.result', result: w.pickContact(req.pendingId, req.index) }
      case 'draft.act':
        return { type: 'done', ...(await w.draftAct(req.draftId, req.action)) }
      case 'invite.act':
        return { type: 'done', ...(await w.inviteAct(req.inviteId, req.action)) }
      case 'auth.start':
        w.startAuth()
        return { type: 'ok' }
    }
  }
}
