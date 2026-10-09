import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DATA_DIR = path.join(ROOT, '.data')

const env = process.env

export const config = {
  port: Number(env.PORT ?? 8787),
  token: env.WINGMAN_TOKEN ?? '',
  userName: env.USER_NAME ?? '',
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,

  // FAKE_GOOGLE=1 serves fixture calendar/inbox data and only logs sends.
  fakeGoogle: env.FAKE_GOOGLE === '1',

  geminiKey: env.GEMINI_API_KEY ?? '',
  geminiModel: env.GEMINI_MODEL || 'gemini-3.8-flash',

  deepgramKey: env.DEEPGRAM_API_KEY ?? '',
  deepgramModel: env.DEEPGRAM_MODEL || 'nova-3',
  // FAKE_STT=1 ignores mic audio and returns a scripted transcript.
  fakeStt: env.FAKE_STT === '1',

  pollMs: Number(env.POLL_SECONDS ?? 180) * 1000,
}

export const paths = {
  googleClient: path.join(DATA_DIR, 'google-client.json'),
  googleToken: path.join(DATA_DIR, 'google-token.json'),
  drafts: path.join(DATA_DIR, 'drafts.json'),
  contacts: path.join(DATA_DIR, 'contacts.json'),
}
