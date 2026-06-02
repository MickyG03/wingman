import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { auth, gmail } from '@googleapis/gmail'
import { DATA_DIR, paths } from '../config.ts'
import { AuthNeededError } from './ports.ts'

// gmail.modify covers reading, marking read, drafts and sending with one consent.
// The two contacts scopes are read-only and resolve spoken names to addresses.
// drive.file limits file creation to files Wingman made; drive.readonly covers search and reading.
export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/contacts.other.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
]

export type OAuth2Client = InstanceType<typeof auth.OAuth2>

interface ClientConfig {
  clientId: string
  clientSecret: string
}

function readClientConfig(): ClientConfig {
  if (!fs.existsSync(paths.googleClient)) {
    throw new AuthNeededError(`Missing ${paths.googleClient}. Download your Desktop OAuth client JSON there.`)
  }
  const json = JSON.parse(fs.readFileSync(paths.googleClient, 'utf8'))
  const c = json.installed ?? json.web
  if (!c?.client_id || !c?.client_secret) throw new Error(`${paths.googleClient} is not an OAuth client file`)
  return { clientId: c.client_id, clientSecret: c.client_secret }
}

function writeToken(tokens: object) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(paths.googleToken, JSON.stringify(tokens, null, 2), { mode: 0o600 })
}

export function isAuthError(err: unknown): boolean {
  const e = err as { code?: number | string; status?: number; response?: { status?: number }; message?: string }
  const status = e?.response?.status ?? e?.status ?? (typeof e?.code === 'number' ? e.code : undefined)
  const msg = e?.message ?? ''
  return status === 401 || /invalid_grant|No refresh token|No access, refresh token|unauthorized_client/i.test(msg)
}

/**
 * Holds the OAuth client used by the Gmail and Calendar adapters. Emits
 * `needed` when credentials stop working and `restored` when a new token
 * file appears (e.g. after `npm run auth`), so the bridge recovers without a
 * restart.
 */
export class GoogleAuth extends EventEmitter {
  readonly client: OAuth2Client
  needed = true

  constructor() {
    super()
    let cfg: ClientConfig = { clientId: '', clientSecret: '' }
    try {
      cfg = readClientConfig()
    } catch (err) {
      console.warn(`[google] ${(err as Error).message}`)
    }
    this.client = new auth.OAuth2(cfg.clientId, cfg.clientSecret)
    this.client.on('tokens', tokens => {
      // Refreshes don't repeat the refresh_token, so merge with what's on disk.
      const prev = fs.existsSync(paths.googleToken) ? JSON.parse(fs.readFileSync(paths.googleToken, 'utf8')) : {}
      writeToken({ ...prev, ...tokens })
    })
    this.load()
    fs.watchFile(paths.googleToken, { interval: 2000 }, () => {
      if (this.load()) {
        console.log('[google] credentials reloaded')
        this.emit('restored')
      }
    })
  }

  /** Loads the saved token. Returns true if usable credentials were loaded. */
  load(): boolean {
    if (!fs.existsSync(paths.googleToken)) return false
    try {
      const tokens = JSON.parse(fs.readFileSync(paths.googleToken, 'utf8'))
      if (!tokens.refresh_token) return false
      // A token from before new scopes were added can't reach the new APIs.
      const granted = new Set(String(tokens.scope ?? '').split(/\s+/))
      const missing = SCOPES.filter(s => !granted.has(s))
      if (tokens.scope && missing.length) {
        console.warn(`[google] sign-in is missing ${missing.length} permission(s): run \`npm run auth\` again`)
        return false
      }
      this.client.setCredentials(tokens)
      this.needed = false
      return true
    } catch {
      return false
    }
  }

  markNeeded(reason: string) {
    if (this.needed) return
    this.needed = true
    console.warn(`[google] sign-in needed: ${reason}`)
    this.emit('needed')
  }

  /** Runs a Google API call, translating credential failures into AuthNeededError. */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.needed) throw new AuthNeededError()
    try {
      return await fn()
    } catch (err) {
      if (isAuthError(err)) {
        this.markNeeded((err as Error).message)
        throw new AuthNeededError()
      }
      throw err
    }
  }
}

function openBrowser(url: string) {
  // rundll32 avoids cmd.exe, which would split the URL at every '&'.
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  spawn(cmd, args as string[], { detached: true, stdio: 'ignore' }).unref()
}

const DONE_PAGE = (ok: boolean, msg: string) =>
  `<!doctype html><meta charset="utf-8"><title>Wingman</title>` +
  `<body style="font:16px system-ui;padding:40px"><h2>${ok ? 'Wingman is connected to Google' : 'Sign-in failed'}</h2>` +
  `<p>${msg}</p></body>`

/**
 * Desktop-app OAuth with a loopback redirect and PKCE. Opens the browser on
 * this PC, waits for consent, stores the refresh token in .data/ and returns
 * the signed-in address.
 */
export async function runAuthFlow(): Promise<string> {
  const { clientId, clientSecret } = readClientConfig()
  const server = http.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const client = new auth.OAuth2(clientId, clientSecret, redirectUri)
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync()
  const state = randomBytes(16).toString('hex')
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256' as never,
  })

  console.log(`\nOpening Google sign-in in your browser. If it doesn't open, visit:\n${url}\n`)
  openBrowser(url)

  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for Google sign-in')), 5 * 60_000)
    server.on('request', (req, res) => {
      const u = new URL(req.url ?? '/', redirectUri)
      if (u.searchParams.get('state') !== state) {
        res.writeHead(404).end()
        return
      }
      clearTimeout(timer)
      const error = u.searchParams.get('error')
      const got = u.searchParams.get('code')
      res.writeHead(200, { 'content-type': 'text/html' })
      if (error || !got) {
        res.end(DONE_PAGE(false, error ?? 'No code returned.'))
        reject(new Error(`Google sign-in failed: ${error ?? 'no code'}`))
      } else {
        res.end(DONE_PAGE(true, 'You can close this tab and go back to your glasses.'))
        resolve(got)
      }
    })
  }).finally(() => server.close())

  const { tokens } = await client.getToken({ code, codeVerifier })
  if (!tokens.refresh_token) {
    throw new Error('Google returned no refresh token. Remove Wingman at myaccount.google.com/permissions and try again.')
  }
  client.setCredentials(tokens)
  const profile = await gmail({ version: 'v1', auth: client }).users.getProfile({ userId: 'me' })
  writeToken(tokens)
  return profile.data.emailAddress ?? '(unknown)'
}
