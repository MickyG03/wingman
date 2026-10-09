// WebSocket client for the Wingman bridge running on the user's PC.
//
// In dev the Vite server proxies `/bridge` to the bridge, so the plugin talks
// to its own origin and needs no network whitelist or CORS. In production,
// VITE_BRIDGE_URL points at the bridge (e.g. ws://192.168.1.6:8787/ws) and
// that origin must be in app.json's `network` whitelist.

import type { ClientMessage, ErrorCode, Request, ResponseMap, ServerMessage, ServerPush } from '../../../shared/protocol'

export type BridgeState = 'connecting' | 'ready' | 'disconnected' | 'unauthorized'

export interface ReadyInfo {
  authNeeded: boolean
  fake: boolean
}

export interface BridgeClientOptions {
  url: string
  token: string
  onState: (state: BridgeState, detail?: string, info?: ReadyInfo) => void
  onPush: (msg: ServerPush) => void
}

export class BridgeError extends Error {
  constructor(
    readonly code: ErrorCode | 'OFFLINE' | 'TIMEOUT',
    message: string,
  ) {
    super(message)
  }
}

const MAX_BACKOFF_MS = 10_000
// Voice requests wait for speech-to-text plus an AI call.
const SLOW_REQUESTS = new Set<Request['type']>(['voice.stop', 'draft.fromSuggestion', 'meeting.get', 'email.get', 'draft.act', 'invite.act'])

export function defaultBridgeUrl(): string {
  const fromEnv = import.meta.env.VITE_BRIDGE_URL as string | undefined
  if (fromEnv) return fromEnv
  return `${location.origin.replace(/^http/, 'ws')}/bridge`
}

interface Pending {
  type: Request['type']
  resolve: (msg: unknown) => void
  reject: (err: BridgeError) => void
  timer: number
}

export function connectBridge(opts: BridgeClientOptions) {
  let ws: WebSocket | null = null
  let ready = false
  let backoff = 500
  let stopped = false
  let retryTimer: number | null = null
  let rid = 0
  const pending = new Map<number, Pending>()

  function failAll(reason: string) {
    for (const [id, p] of pending) {
      clearTimeout(p.timer)
      p.reject(new BridgeError('OFFLINE', reason))
      pending.delete(id)
    }
  }

  function open() {
    opts.onState('connecting')
    ws = new WebSocket(opts.url)
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      backoff = 500
      sendJson({ type: 'hello', token: opts.token })
    }

    ws.onmessage = ev => {
      if (typeof ev.data !== 'string') return
      let msg: ServerMessage
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      if ('rid' in msg) {
        const p = pending.get(msg.rid)
        if (!p) return
        pending.delete(msg.rid)
        clearTimeout(p.timer)
        if (msg.type === 'error') p.reject(new BridgeError(msg.code, msg.message))
        else p.resolve(msg)
        return
      }
      switch (msg.type) {
        case 'ready':
          ready = true
          opts.onState('ready', `v${msg.version}`, { authNeeded: msg.authNeeded, fake: msg.fake })
          break
        case 'pong':
        case 'error':
          break
        default:
          opts.onPush(msg)
      }
    }

    ws.onclose = ev => {
      ws = null
      ready = false
      failAll('Connection lost')
      if (stopped) return
      // 4003 = bad token: retrying won't help until the token is fixed.
      if (ev.code === 4003) {
        opts.onState('unauthorized', 'bridge rejected token')
        return
      }
      opts.onState('disconnected', `retrying in ${Math.round(backoff / 1000)}s`)
      retryTimer = window.setTimeout(open, backoff)
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
    }
  }

  function sendJson(msg: ClientMessage) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  function request<T extends Request>(req: T): Promise<ResponseMap[T['type']]> {
    if (!ready || ws?.readyState !== WebSocket.OPEN) return Promise.reject(new BridgeError('OFFLINE', 'Bridge offline'))
    const id = ++rid
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(
        () => {
          pending.delete(id)
          reject(new BridgeError('TIMEOUT', 'The bridge took too long. Try again.'))
        },
        SLOW_REQUESTS.has(req.type) ? 60_000 : 20_000,
      )
      pending.set(id, { type: req.type, resolve: resolve as (m: unknown) => void, reject, timer })
      sendJson({ ...req, rid: id })
    })
  }

  /** Mic PCM. Dropped silently while disconnected. */
  function sendBinary(data: Uint8Array) {
    if (ready && ws?.readyState === WebSocket.OPEN) ws.send(data)
  }

  function close() {
    stopped = true
    if (retryTimer !== null) clearTimeout(retryTimer)
    ws?.close()
  }

  open()
  return { request, sendBinary, close }
}

export type BridgeClient = ReturnType<typeof connectBridge>
