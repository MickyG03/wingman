export interface SttSession {
  /** Mic audio: PCM s16le, 16 kHz, mono. */
  push(pcm: Buffer): void
  /** Stops listening and resolves with the full final transcript. */
  finish(): Promise<string>
  cancel(): void
}

export type TranscriptListener = (final: string, interim: string) => void

export type SttFactory = (onTranscript: TranscriptListener) => SttSession
