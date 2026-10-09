import { OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'

export type Gesture = 'up' | 'down' | 'tap' | 'double' | 'holdStart' | 'holdEnd' | 'foreground' | 'background' | 'exit'

// The firmware can report one swipe more than once; ignore repeats this close together.
const SCROLL_COOLDOWN_MS = 250

let lastScroll = 0

/**
 * Maps one SDK event to a gesture. Audio and IMU events return null.
 *
 * CLICK_EVENT is 0 and protobuf omits zero values, so a tap arrives as an
 * envelope with `eventType` undefined. The default is resolved only for an
 * envelope that is present: audio frames carry no sysEvent/textEvent and must
 * not read as taps.
 */
export function toGesture(event: EvenHubEvent, now = Date.now()): Gesture | null {
  const env = event.sysEvent ?? event.textEvent ?? event.listEvent
  if (!env) return null
  const type = env.eventType ?? OsEventTypeList.CLICK_EVENT
  switch (type) {
    case OsEventTypeList.CLICK_EVENT:
      return 'tap'
    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      return 'double'
    case OsEventTypeList.SCROLL_TOP_EVENT:
    case OsEventTypeList.SCROLL_BOTTOM_EVENT:
      if (now - lastScroll < SCROLL_COOLDOWN_MS) return null
      lastScroll = now
      return type === OsEventTypeList.SCROLL_TOP_EVENT ? 'up' : 'down'
    case OsEventTypeList.LONG_PRESS_EVENT:
      return 'holdStart'
    case OsEventTypeList.LONG_PRESS_RELEASE_EVENT:
      return 'holdEnd'
    case OsEventTypeList.FOREGROUND_ENTER_EVENT:
      return 'foreground'
    case OsEventTypeList.FOREGROUND_EXIT_EVENT:
      return 'background'
    case OsEventTypeList.SYSTEM_EXIT_EVENT:
    case OsEventTypeList.ABNORMAL_EXIT_EVENT:
      return 'exit'
    default:
      return null
  }
}
