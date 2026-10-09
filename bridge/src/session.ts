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
  reply: 'Drafting reply...',
  followup: 'Drafting follow-up...',
  redo: 'Revising draft...',
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
  private voice: { ctx: VoiceContext; stt: SttSession; bytes: number } | null = null

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
        this.voice = { ctx: req.ctx, stt, bytes: 0 }
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
        console.log(`[voice] ${v.ctx.kind}: ${(v.bytes / 32000).toFixed(1)}s audio, ${transcript.length} chars`)
        this.send({ type: 'busy', label: BUSY_LABEL[v.ctx.kind] })
        const result = await w.processVoice(v.ctx, transcript)
        console.log(`[voice] -> ${result.kind}`)
        return { type: 'voice.result', result }
      }
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
