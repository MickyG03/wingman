import { AudioInputSource, type EvenAppBridge, type EvenHubEvent } from '@evenrealities/even_hub_sdk'

// audioControl(true) reports success even when mic permission is denied, so a
// silent mic is detected by counting frames instead.
const SILENCE_WATCHDOG_MS = 1500
const LEVEL_EVERY_MS = 120

/** Peak sample level of a PCM s16le chunk, 0..1. */
export function peakLevel(pcm: Uint8Array): number {
  let peak = 0
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = (pcm[i] | (pcm[i + 1] << 8)) << 16 >> 16
    const a = v < 0 ? -v : v
    if (a > peak) peak = a
  }
  return peak / 32767
}

export class Mic {
  private on = false
  private frames = 0
  private watchdog: number | null = null
  private lastLevelAt = 0

  constructor(
    private readonly bridge: EvenAppBridge,
    private readonly onPcm: (pcm: Uint8Array) => void,
    private readonly onSilent: () => void,
    private readonly onLevel: (level: number) => void,
  ) {}

  async start() {
    if (this.on) return
    this.on = true
    this.frames = 0
    await this.bridge.audioControl(true, AudioInputSource.Glasses)
    this.watchdog = window.setTimeout(() => {
      if (this.on && this.frames === 0) this.onSilent()
    }, SILENCE_WATCHDOG_MS)
  }

  async stop() {
    if (this.watchdog !== null) clearTimeout(this.watchdog)
    this.watchdog = null
    if (!this.on) return
    this.on = false
    await this.bridge.audioControl(false)
  }

  /** Feed every SDK event here; forwards PCM while the mic is on. */
  handle(event: EvenHubEvent) {
    const pcm = event.audioEvent?.audioPcm
    if (!pcm || !this.on) return
    this.frames++
    this.onPcm(pcm)
    const now = Date.now()
    if (now - this.lastLevelAt >= LEVEL_EVERY_MS) {
      this.lastLevelAt = now
      this.onLevel(peakLevel(pcm))
    }
  }
}
