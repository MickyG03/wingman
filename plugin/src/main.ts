// Wiring only: SDK events → gestures → reducer → effects + display.

import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { reduce } from './app/reducer'
import { initialState, type Action, type Effect, type State } from './app/state'
import { BridgeError, connectBridge, defaultBridgeUrl } from './bridge/client'
import { Display } from './glasses/display'
import { toGesture, type Gesture } from './glasses/input'
import { Mic } from './glasses/mic'
import { render } from './render/screens'
import { mirror, mountUi, setStatus } from './ui'

const TOKEN = import.meta.env.VITE_BRIDGE_TOKEN as string | undefined

let state: State = initialState()
let display: Display | null = null
let link: ReturnType<typeof connectBridge> | null = null
let mic: Mic | null = null

function dispatch(action: Action) {
  const { state: next, effects } = reduce(state, action)
  state = next
  const frame = render(state)
  display?.show(frame)
  mirror(frame)
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
  }
}

const gesture = (g: Gesture) => dispatch({ type: 'gesture', gesture: g, now: Date.now() })

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

let cleanedUp = false
function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  clearInterval(ticker)
  void mic?.stop()
  link?.close()
  unsubscribe()
}

window.addEventListener('beforeunload', cleanup)
