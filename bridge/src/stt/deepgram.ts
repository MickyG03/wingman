import WebSocket from 'ws'
import type { SttFactory, SttSession, TranscriptListener } from './types.ts'

const FINALIZE_WAIT_MS = 1500
const KEEPALIVE_MS = 4000

interface DgResult {
  type: 'Results'
  is_final?: boolean
  from_finalize?: boolean
  channel?: { alternatives?: { transcript?: string }[] }
}

/**
 * Streams mic PCM to Deepgram's live endpoint. Audio sent before the socket
 * opens is buffered so the first words aren't lost.
 */
export function deepgramStt(apiKey: string, model: string): SttFactory {
  return (onTranscript: TranscriptListener): SttSession => {
    const params = new URLSearchParams({
      model,
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      interim_results: 'true',
      endpointing: '300',
      utterance_end_ms: '1000',
      smart_format: 'true',
      punctuate: 'true',
    })
    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
      headers: { Authorization: `Token ${apiKey}` },
    })

    const finals: string[] = []
    let interim = ''
    let pending: Buffer[] = []
    let closed = false
    let error: Error | null = null
    let onFinalized: (() => void) | null = null
    let sentBytes = 0
    let results = 0

    const text = () => finals.join(' ').trim()

    const keepAlive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }))
    }, KEEPALIVE_MS)

    ws.on('open', () => {
      for (const chunk of pending) ws.send(chunk)
      pending = []
    })

    ws.on('message', raw => {
      let msg: DgResult | { type: string }
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.type !== 'Results') {
        if (msg.type !== 'Metadata' && msg.type !== 'UtteranceEnd' && msg.type !== 'SpeechStarted') console.log(`[stt] deepgram: ${JSON.stringify(msg).slice(0, 200)}`)
        return
      }
      results++
      const r = msg as DgResult
      const t = r.channel?.alternatives?.[0]?.transcript?.trim() ?? ''
      if (r.is_final) {
        if (t) finals.push(t)
        interim = ''
      } else {
        interim = t
      }
      onTranscript(text(), interim)
      if (r.from_finalize) onFinalized?.()
    })

    ws.on('error', err => {
      error = err
      console.warn(`[stt] deepgram error: ${err.message}`)
      onFinalized?.()
    })

    ws.on('close', () => {
      closed = true
      clearInterval(keepAlive)
      onFinalized?.()
    })

    function shutdown() {
      clearInterval(keepAlive)
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'CloseStream' }))
      else if (ws.readyState === WebSocket.CONNECTING) ws.terminate()
    }

    return {
      push(pcm) {
        if (closed) return
        sentBytes += pcm.length
        if (ws.readyState === WebSocket.OPEN) ws.send(pcm)
        else pending.push(pcm)
      },

      async finish() {
        if (ws.readyState === WebSocket.OPEN) {
          // Finalize flushes whatever Deepgram is still holding as interim.
          await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, FINALIZE_WAIT_MS)
            onFinalized = () => {
              clearTimeout(timer)
              resolve()
            }
            ws.send(JSON.stringify({ type: 'Finalize' }))
          })
        } else if (ws.readyState === WebSocket.CONNECTING && pending.length) {
          // Released before the socket opened: give it a moment to connect and flush.
          await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, FINALIZE_WAIT_MS * 2)
            ws.once('open', () => {
              ws.send(JSON.stringify({ type: 'Finalize' }))
              onFinalized = () => {
                clearTimeout(timer)
                resolve()
              }
            })
          })
        }
        shutdown()
        const result = [text(), interim].filter(Boolean).join(' ').trim()
        console.log(`[stt] deepgram: ${(sentBytes / 32000).toFixed(1)}s sent, ${results} results, ${finals.length} final segments${error ? `, error: ${error.message}` : ''}`)
        if (!result && error) throw new Error(`Speech-to-text failed: ${(error as Error).message}`)
        return result
      },

      cancel() {
        shutdown()
      },
    }
  }
}
