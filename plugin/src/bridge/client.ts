// WebSocket client for the Wingman bridge running on the user's PC.
//
// In dev the Vite server proxies `/bridge` to the bridge, so the plugin talks
// to its own origin and needs no network whitelist or CORS. In production,
// VITE_BRIDGE_URL points at the tunnel (e.g. wss://wingman.example.com/ws) and
// that origin must be in app.json's `network` whitelist.

import type { ClientMessage, ServerMessage } from './protocol'

export type BridgeState = 'connecting' | 'ready' | 'disconnected' | 'unauthorized'

export interface BridgeClientOptions {
  url: string
  token: string
  onState: (state: BridgeState, detail?: string) => void
  onMessage?: (msg: ServerMessage) => void
}

const MAX_BACKOFF_MS = 10_000

export function defaultBridgeUrl(): string {
  const fromEnv = import.meta.env.VITE_BRIDGE_URL as string | undefined
  if (fromEnv) return fromEnv
  return `${location.origin.replace(/^http/, 'ws')}/bridge`
}

export function connectBridge(opts: BridgeClientOptions) {
  let ws: WebSocket | null = null
  let backoff = 500
  let stopped = false
  let retryTimer: number | null = null

  function open() {
    opts.onState('connecting')
    ws = new WebSocket(opts.url)

    ws.onopen = () => {
      backoff = 500
      send({ type: 'hello', token: opts.token })
    }

    ws.onmessage = ev => {
      let msg: ServerMessage
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      if (msg.type === 'ready') opts.onState('ready', `v${msg.version}`)
      opts.onMessage?.(msg)
    }

    ws.onclose = ev => {
      ws = null
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

  function send(msg: ClientMessage) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  function close() {
    stopped = true
    if (retryTimer !== null) clearTimeout(retryTimer)
    ws?.close()
  }

  open()
  return { send, close }
}
