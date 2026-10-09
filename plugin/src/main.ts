// Wiring only: SDK events → gestures → reducer → effects + display.

import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { reduce } from './app/reducer'
import { initialState, type Action, type Effect, type State } from './app/state'
import { BridgeError, connectBridge, defaultBridgeUrl } from './bridge/client'
import { Display } from './glasses/display'
import { toGesture, type Gesture } from './glasses/input'
import { Mic } from './glasses/mic'
import { render } from './render/screens'
import { mirror, mountUi, setStatus, showChat } from './ui'

const TOKEN = import.meta.env.VITE_BRIDGE_TOKEN as string | undefined

let state: State = initialState()
let display: Display | null = null
let link: ReturnType<typeof connectBridge> | null = null
let mic: Mic | null = null
let prevChat: typeof state.chat = null

function dispatch(action: Action) {
  const { state: next, effects } = reduce(state, action)
  state = next
  const frame = render(state)
  display?.show(frame)
  mirror(frame)
  if (state.chat !== prevChat) showChat((prevChat = state.chat))
  for (const e of effects) runEffect(e)
}

function runEffect(e: Effect) {
  switch (e.kind) {
    case 'request':
      if (!link) return
      link.request(e.req).then(
        res => dispatch({ type: 'response', req: e.req, res, token: e.token }),
        (err: BridgeError) => dispatch({ type: 'failed', req: e.req, code: err.code ?? 'INTERNAL', message: err.message, token: e.token }),
      )
      break
    case 'mic':
      void (e.on ? mic?.start() : mic?.stop())
      break
    case 'exit':
      void bridge.shutDownPageContainer(1)
      break
    case 'saveBest':
      void bridge.setLocalStorage('dino.best', String(e.best))
      break
  }
}

const gesture = (g: Gesture) => {
  dispatch({ type: 'gesture', gesture: g, now: Date.now() })
  // In the game, a tap or swipe gets its frame now rather than at the next scheduled one.
  if (state.stack[state.stack.length - 1].name === 'game' && (g === 'tap' || g === 'up' || g === 'down')) pumpNow()
}

mountUi(gesture)

const bridge = await waitForEvenAppBridge()
display = new Display(bridge)
if (!(await display.init(render(state)))) {
  setStatus('error', 'Could not create the glasses page')
  console.error('createStartUpPageContainer failed')
}

if (!TOKEN) {
  setStatus('error', 'VITE_BRIDGE_TOKEN not set — copy .env.example to .env.local')
  dispatch({ type: 'conn', conn: 'unauthorized' })
} else {
  link = connectBridge({
    url: defaultBridgeUrl(),
    token: TOKEN,
    onState: (s, detail, info) => {
      setStatus(s === 'ready' ? 'ready' : s === 'connecting' ? 'connecting' : 'error', s === 'ready' ? 'Connected' : detail ?? s)
      dispatch({
        type: 'conn',
        conn: s === 'disconnected' ? 'offline' : s,
        detail,
        authNeeded: info?.authNeeded,
        fake: info?.fake,
      })
    },
    onPush: msg => dispatch({ type: 'push', msg }),
  })
  mic = new Mic(
    bridge,
    pcm => link?.sendBinary(pcm),
    () => dispatch({ type: 'micSilent' }),
    level => dispatch({ type: 'micLevel', level }),
  )
}

const unsubscribe = bridge.onEvenHubEvent(event => {
  mic?.handle(event)
  const g = toGesture(event)
  if (import.meta.env.DEV && (event.sysEvent || event.textEvent || event.listEvent)) {
    console.log('[input]', JSON.stringify({ sys: event.sysEvent, text: event.textEvent, list: event.listEvent }), '->', g)
  }
  if (!g) return
  if (g === 'exit') cleanup()
  gesture(g)
})

const ticker = window.setInterval(() => dispatch({ type: 'tick', now: Date.now() }), 1000)

// The dino game is driven by the display: the next frame is simulated and
// drawn as soon as the previous one has been handed to the SDK, so frames
// never queue up behind a slow Bluetooth link (queued frames = laggy taps).
// A minimum interval keeps the simulator from running away.
// Slower than the SDK's 100 ms pacing on purpose: the Bluetooth link drains
// frames more slowly than the SDK accepts them, and every queued frame delays
// what you see after a tap. Override with VITE_GAME_FRAME_MS to experiment.
const MIN_FRAME_MS = Number(import.meta.env.VITE_GAME_FRAME_MS) || 150
const INPUT_FRAME_MIN_MS = 40
const FRAME_WATCHDOG_MS = 400
let lastGameTick = 0
let fpsEma = 0
let gameWatchdog: number | null = null

function pumpNow() {
  if (lastGameTick && performance.now() - lastGameTick < INPUT_FRAME_MIN_MS) return
  pumpGame()
}

/** True while the dino is actually running; otherwise no frames need sending. */
function gameRunning(): boolean {
  const sc = state.stack[state.stack.length - 1]
  return sc.name === 'game' && sc.dino.started && !sc.dino.over
}

function pumpGame() {
  if (gameWatchdog !== null) clearTimeout(gameWatchdog)
  gameWatchdog = null
  if (!gameRunning()) {
    lastGameTick = 0
    return
  }
  const now = performance.now()
  const dt = lastGameTick ? Math.min(200, now - lastGameTick) : MIN_FRAME_MS
  if (lastGameTick) {
    fpsEma = fpsEma ? fpsEma * 0.85 + (1000 / dt) * 0.15 : 1000 / dt
    if (Math.abs(fpsEma - state.gameFps) >= 0.5) dispatch({ type: 'gameFps', fps: fpsEma })
  }
  lastGameTick = now
  dispatch({ type: 'gameTick', dt }) // renders, and display.sendGame → onGameFrameSent → next pump
  // If the frame never reports back (send failed, layout changed), keep going anyway.
  if (gameRunning()) gameWatchdog = window.setTimeout(pumpGame, FRAME_WATCHDOG_MS)
  else lastGameTick = 0 // game over: stop sending until the next tap
}

if (display) {
  display.onGameFrameSent = ms => {
    if (!gameRunning()) return
    const wait = Math.max(0, MIN_FRAME_MS - ms)
    if (gameWatchdog !== null) clearTimeout(gameWatchdog)
    gameWatchdog = window.setTimeout(pumpGame, wait)
  }
}

// Starting a run kicks the loop off; game over or leaving stops it by itself.
const gameTicker = window.setInterval(() => {
  if (gameRunning() && lastGameTick === 0) pumpGame()
}, 100)

void bridge.getLocalStorage('dino.best').then(v => {
  const best = Number(v)
  if (best > 0) dispatch({ type: 'dinoBest', best })
})

let cleanedUp = false
function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  clearInterval(ticker)
  clearInterval(gameTicker)
  void mic?.stop()
  link?.close()
  unsubscribe()
}

window.addEventListener('beforeunload', cleanup)
