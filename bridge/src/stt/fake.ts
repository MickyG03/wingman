import type { VoiceContext } from '../../../shared/protocol.ts'
import type { SttFactory } from './types.ts'

const SCRIPTS: Record<VoiceContext['kind'], string> = {
  home: 'Email Priya that I am running ten minutes late to the design review',
  chat: 'What is unread',
  reply: 'Thursday works, see you at 12:30',
  followup: 'We agreed to launch on October 27 once the analytics hooks are in. Sam owns the checklist',
  redo: 'Make it shorter and more casual',
}

/**
 * FAKE_STT=1: ignores the audio and "hears" a script for the current context,
 * revealed word by word so the dictation screen behaves like the real thing.
 * FAKE_STT_TEXT overrides the script.
 */
export function fakeStt(ctx: () => VoiceContext['kind']): SttFactory {
  return onTranscript => {
    const words = (process.env.FAKE_STT_TEXT || SCRIPTS[ctx()]).split(' ')
    let shown = 0
    const timer = setInterval(() => {
      if (shown >= words.length) return
      shown++
      onTranscript(words.slice(0, shown - 1).join(' '), words[shown - 1])
    }, 180)
    return {
      push() {},
      async finish() {
        clearInterval(timer)
        const text = words.join(' ')
        onTranscript(text, '')
        return text
      },
      cancel() {
        clearInterval(timer)
      },
    }
  }
}
