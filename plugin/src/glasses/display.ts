// Owns the glasses page. Four layouts share header/body/footer text areas;
// `home` adds the logo and an icon strip, `chat` adds a dim "You:" line,
// `game` adds the 288x144 play area. Switching layout rebuilds the page
// (one flicker); everything else is an in-place text or image update.
//
// Every write goes through one queue: concurrent writes crash the BLE link,
// and only the latest frame matters.

import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import type { Frame, Layout } from '../render/screens'
import { cachedPng, drawIcon, drawLogo, toPng, type IconName } from './icons'

interface TextArea {
  id: number
  name: string
  x: number
  y: number
  w: number
  h: number
  pad: number
  color: number
  capture?: boolean
}
interface ImageArea {
  id: number
  name: string
  x: number
  y: number
  w: number
  h: number
}

const HDR = { id: 1, name: 'hdr', x: 0, y: 0, w: 576, h: 28, pad: 0, color: 2 }
const FTR = { id: 3, name: 'ftr', x: 0, y: 260, w: 576, h: 28, pad: 0, color: 2 }
const BODY = { id: 2, name: 'body', x: 0, y: 28, w: 576, h: 232, pad: 4, color: 4, capture: true }

// Every normal screen shares one layout with a 28px column on the left: the
// logo at the top, then an icon per row (rows are 27px from y=32). Sharing the
// layout means moving between screens never rebuilds the page, so the images
// survive. The column is two images (max height 144): rows 0-3 with the logo,
// and rows 4-7.
export const INSET = 30
const STRIP_A = { id: 11, name: 'icons-a', x: 0, y: 0, w: 28, h: 136 }
const STRIP_B = { id: 12, name: 'icons-b', x: 0, y: 136, w: 28, h: 116 }
// Chat: two dim lines of what you said, then six lines of reply.
const YOU = { id: 4, name: 'you', x: 0, y: 28, w: 576, h: 58, pad: 4, color: 2 }
const CHAT_BODY = { ...BODY, y: 86, h: 174 }
// Game: the play area, centered.
// Smaller than the 144px maximum: fewer bytes per frame over BLE.
export const GAME = { id: 13, name: 'game', x: 144, y: 86, w: 288, h: 88 }

const LAYOUTS: Record<Layout, { text: TextArea[]; images: ImageArea[] }> = {
  default: { text: [{ ...HDR, x: 32, w: 544 }, { ...BODY, x: INSET, w: 576 - INSET }, FTR], images: [STRIP_A, STRIP_B] },
  chat: { text: [HDR, YOU, CHAT_BODY, FTR], images: [] },
  game: { text: [HDR, { ...BODY, color: 1 }, FTR], images: [GAME] },
}

const MAX_CREATE = 1000
const MAX_UPGRADE = 2000

function textOf(frame: Frame, area: TextArea): string {
  if (area.id === HDR.id) return frame.header
  if (area.id === FTR.id) return frame.footer
  if (area.id === YOU.id) return frame.you ?? ' '
  return frame.layout === 'game' ? ' ' : frame.body
}

export class Display {
  private layout: Layout | null = null
  private sent = new Map<number, string>() // text area id → content on glasses
  private sentStrips = ['', ''] // icon keys on the glasses, per strip
  private wanted: Frame | null = null
  private writing = false
  private gameFrame: Uint8Array | null = null
  private gameBusy = false
  private lastGameState: object | null = null
  /** Called after each game frame reaches the SDK, with the time it took. Drives the game loop. */
  onGameFrameSent: ((ms: number) => void) | null = null

  constructor(private readonly bridge: EvenAppBridge) {}

  private containers(frame: Frame) {
    const L = LAYOUTS[frame.layout]
    const textObject = L.text.map(
      a =>
        new TextContainerProperty({
          xPosition: a.x,
          yPosition: a.y,
          width: a.w,
          height: a.h,
          borderWidth: 0,
          borderColor: 0,
          paddingLength: a.pad,
          containerID: a.id,
          containerName: a.name,
          content: textOf(frame, a).slice(0, MAX_CREATE) || ' ',
          isEventCapture: a.capture ? 1 : 0,
          textColor: a.color,
        }),
    )
    const imageObject = L.images.map(
      i => new ImageContainerProperty({ xPosition: i.x, yPosition: i.y, width: i.w, height: i.h, containerID: i.id, containerName: i.name }),
    )
    return { containerTotalNum: textObject.length + imageObject.length, textObject, imageObject }
  }

  async init(first: Frame): Promise<boolean> {
    const result = await this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(this.containers(first)))
    // The startup page can only be created once per launch; after a reload
    // (dev hot reload, WebView restart) replace the existing page instead.
    const ok = result === 0 ? true : await this.bridge.rebuildPageContainer(new RebuildPageContainer(this.containers(first)))
    this.afterBuild(first)
    await this.sendImages(first, true)
    return ok
  }

  private afterBuild(frame: Frame) {
    this.layout = frame.layout
    this.sent.clear()
    for (const a of LAYOUTS[frame.layout].text) this.sent.set(a.id, textOf(frame, a).slice(0, MAX_CREATE) || ' ')
    this.sentStrips = ['', '']
  }

  /** Shows `frame`, sending only what changed. Latest call wins. */
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
        if (frame.layout !== this.layout) {
          const ok = await this.bridge.rebuildPageContainer(new RebuildPageContainer(this.containers(frame)))
          if (!ok) console.error('[display] rebuild rejected for layout', frame.layout)
          this.afterBuild(frame)
          await this.sendImages(frame, true)
          continue
        }
        for (const a of LAYOUTS[frame.layout].text) {
          const content = (textOf(frame, a) || ' ').slice(0, MAX_UPGRADE)
          if (content === this.sent.get(a.id)) continue
          await this.bridge.textContainerUpgrade(
            new TextContainerUpgrade({ containerID: a.id, containerName: a.name, contentOffset: 0, contentLength: content.length, content }),
          )
          this.sent.set(a.id, content)
          if (this.wanted) break // a newer frame arrived: start over with it
        }
        if (!this.wanted) await this.sendImages(frame, false)
      }
    } catch (err) {
      console.error('[display] write failed', err)
    } finally {
      this.writing = false
    }
  }

  private async image(area: ImageArea, bytes: Uint8Array) {
    await this.bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: area.id, containerName: area.name, imageData: bytes }))
  }

  private async sendImages(frame: Frame, all: boolean) {
    if (frame.layout === 'default') {
      const icons = frame.icons ?? []
      const strips = [STRIP_A, STRIP_B]
      for (let n = 0; n < 2; n++) {
        const area = strips[n]
        const from = n * 4
        const key = icons.slice(from, from + 4).map(i => i ?? '-').join(',')
        if (!all && key === this.sentStrips[n]) continue
        this.sentStrips[n] = key
        // Rows start at y=32 on screen; strip A also carries the logo at the top.
        const top = n === 0 ? 32 : 4
        const bytes = await cachedPng(`strip${n}:${key}`, area.w, area.h, ctx => {
          if (n === 0) drawLogo(ctx, 0, 0, 28)
          for (let i = 0; i < 4; i++) {
            const icon = icons[from + i] as IconName | null | undefined
            if (icon) drawIcon(ctx, icon, 4, top + 27 * i + 3)
          }
        })
        await this.image(area, bytes)
      }
    }
    // Only a changed game state is worth a frame: every image sent joins the
    // Bluetooth queue, and a queue of identical frames is pure input lag.
    if (frame.layout === 'game' && frame.draw && (all || frame.gameState !== this.lastGameState)) {
      this.lastGameState = frame.gameState ?? null
      void this.sendGame(frame.draw)
    }
  }

  /** Game frames bypass the text queue; if one is in flight the newest waits. */
  private async sendGame(draw: NonNullable<Frame['draw']>) {
    this.gameFrame = await toPng(GAME.w, GAME.h, ctx => draw(ctx, GAME.w, GAME.h))
    if (this.gameBusy) return
    this.gameBusy = true
    try {
      while (this.gameFrame && this.layout === 'game') {
        const bytes = this.gameFrame
        this.gameFrame = null
        const t0 = performance.now()
        await this.image(GAME, bytes)
        if (import.meta.env.DEV) console.log(`[game] frame ${bytes.length}B in ${Math.round(performance.now() - t0)}ms`)
        this.onGameFrameSent?.(performance.now() - t0)
      }
    } catch (err) {
      console.error('[display] game frame failed', err)
    } finally {
      this.gameBusy = false
    }
  }
}
