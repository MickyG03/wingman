// Owns the glasses page: header, body and footer text areas. The body
// captures input; render/text.ts guarantees it never overflows, so the
// firmware never scrolls it on its own and every swipe reaches us.
// Every write goes through one queue: concurrent textContainerUpgrade calls
// crash the BLE link, and only the latest frame matters.

import {
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import type { Frame } from '../render/screens'

// Lines are 27px. Header/footer have no padding so one line fits in 28px
// without the firmware adding a scrollbar; the body fits 8 lines.
const AREAS = {
  header: { id: 1, name: 'hdr', y: 0, h: 28, pad: 0, color: 2 },
  body: { id: 2, name: 'body', y: 28, h: 232, pad: 4, color: 4 },
  footer: { id: 3, name: 'ftr', y: 260, h: 28, pad: 0, color: 2 },
} as const

type Area = keyof typeof AREAS

// Startup/rebuild accept 1000 chars per container; upgrades accept 2000.
const MAX_UPGRADE = 2000

export class Display {
  private sent: Frame = { header: '', body: '', footer: '' }
  private wanted: Frame | null = null
  private writing = false

  constructor(private readonly bridge: EvenAppBridge) {}

  async init(first: Frame): Promise<boolean> {
    const text = (Object.keys(AREAS) as Area[]).map(
      area =>
        new TextContainerProperty({
          xPosition: 0,
          yPosition: AREAS[area].y,
          width: 576,
          height: AREAS[area].h,
          borderWidth: 0,
          borderColor: 0,
          paddingLength: AREAS[area].pad,
          containerID: AREAS[area].id,
          containerName: AREAS[area].name,
          content: first[area].slice(0, 1000),
          isEventCapture: area === 'body' ? 1 : 0,
          textColor: AREAS[area].color,
        }),
    )
    const result = await this.bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer({ containerTotalNum: text.length, textObject: text }),
    )
    this.sent = { ...first }
    if (result === 0) return true
    // The startup page can only be created once per launch; after a reload
    // (dev hot reload, WebView restart) replace the existing page instead.
    return this.bridge.rebuildPageContainer(new RebuildPageContainer({ containerTotalNum: text.length, textObject: text }))
  }

  /** Shows `frame`, sending only the areas that changed. Latest call wins. */
  show(frame: Frame) {
    this.wanted = frame
    if (!this.writing) void this.flush()
  }

  private async flush() {
    this.writing = true
    try {
      while (this.wanted) {
        const frame = this.wanted
        this.wanted = null
        for (const area of Object.keys(AREAS) as Area[]) {
          const content = frame[area].slice(0, MAX_UPGRADE)
          if (content === this.sent[area]) continue
          await this.bridge.textContainerUpgrade(
            new TextContainerUpgrade({
              containerID: AREAS[area].id,
              containerName: AREAS[area].name,
              contentOffset: 0,
              contentLength: content.length,
              content,
            }),
          )
          this.sent[area] = content
          // A newer frame arrived mid-write: start over with it.
          if (this.wanted) break
        }
      }
    } catch (err) {
      console.error('[display] write failed', err)
    } finally {
      this.writing = false
    }
  }
}
