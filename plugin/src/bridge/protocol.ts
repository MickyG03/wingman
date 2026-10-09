// Messages exchanged over the bridge WebSocket. Keep in sync with
// bridge/src/protocol.ts.

export type ClientMessage =
  | { type: 'hello'; token: string }
  | { type: 'ping' }

export type ServerMessage =
  | { type: 'ready'; version: string }
  | { type: 'pong' }
  | { type: 'error'; message: string }
