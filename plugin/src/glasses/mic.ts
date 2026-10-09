import { AudioInputSource, type EvenAppBridge, type EvenHubEvent } from '@evenrealities/even_hub_sdk'

// audioControl(true) reports success even when mic permission is denied, so a
// silent mic is detected by counting frames instead.
const SILENCE_WATCHDOG_MS = 1500

export class Mic {
  private on = false
  private frames = 0
  private watchdog: number | null = null

  constructor(
    private readonly bridge: EvenAppBridge,
    private readonly onPcm: (pcm: Uint8Array) => void,
    private readonly onSilent: () => void,
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
  }
}
