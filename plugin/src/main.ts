import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import { connectBridge, defaultBridgeUrl, type BridgeState } from './bridge/client'
import { mountUi, setStatus, setTranscript } from './ui'

// Mic → STT (src/asr/stt.ts, still the template stub) and Claude are wired in
// later steps. For now this proves the glasses ⇄ plugin ⇄ bridge path.

mountUi()

const TOKEN = import.meta.env.VITE_BRIDGE_TOKEN as string | undefined

const bridge = await waitForEvenAppBridge()

const screen = new TextContainerProperty({
  xPosition: 0,
  yPosition: 0,
  width: 576,
  height: 288,
  borderWidth: 0,
  borderColor: 5,
  paddingLength: 4,
  containerID: 1,
  containerName: 'main',
  content: 'Wingman\n\nStarting…',
  isEventCapture: 1,
})

const created = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [screen] }),
)
if (created !== 0) {
  setStatus('error', `createStartUpPageContainer failed: ${created}`)
  console.error('Failed to create startup page')
}

let lastRender = ''
let renderTimer: number | null = null
let currentContent = ''

function show(content: string) {
  currentContent = content
  setTranscript(content, '')
  if (renderTimer !== null) return
  renderTimer = window.setTimeout(async () => {
    renderTimer = null
    if (currentContent === lastRender) return
    lastRender = currentContent
    await bridge.textContainerUpgrade(
      new TextContainerUpgrade({ containerID: 1, containerName: 'main', content: currentContent }),
    )
  }, 120) // debounce display writes — BLE render queue is slow
}

const STATE_TEXT: Record<BridgeState, string> = {
  connecting: 'Connecting to bridge…',
  ready: 'Bridge connected',
  disconnected: 'Bridge offline',
  unauthorized: 'Bridge rejected token',
}

let link: ReturnType<typeof connectBridge> | null = null
if (!TOKEN) {
  setStatus('error', 'VITE_BRIDGE_TOKEN not set — copy .env.example to .env.local')
  show('Wingman\n\nNo bridge token.\nSet VITE_BRIDGE_TOKEN\nin plugin/.env.local')
} else {
  link = connectBridge({
    url: defaultBridgeUrl(),
    token: TOKEN,
    onState: (state, detail) => {
      const text = STATE_TEXT[state] + (detail ? ` (${detail})` : '')
      setStatus(state === 'ready' ? 'ready' : state === 'connecting' ? 'connecting' : 'error', text)
      show(`Wingman\n\n${text}`)
    },
  })
}

let cleanedUp = false
function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  link?.close()
  unsubscribe()
}

// CLICK_EVENT is 0 and protobuf omits zero-value fields, so a tap arrives as an
// envelope with `eventType` undefined. Resolve the default inside the envelope
// check, or events with no sysEvent at all (e.g. audio frames) read as taps.
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

// Double-tap must always reach shutDownPageContainer so the user can exit,
// whichever envelope it arrives in. Check it before CLICK_EVENT.
const unsubscribe = bridge.onEvenHubEvent(event => {
  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)

  if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    bridge.shutDownPageContainer(1)
    return
  }

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    cleanup()
  }
})

window.addEventListener('beforeunload', cleanup)
