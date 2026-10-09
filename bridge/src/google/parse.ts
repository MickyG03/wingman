// Pure helpers for turning Gmail API payloads into display-ready values.

import type { Person } from '../../../shared/protocol.ts'

/** Parses an address-list header like `"Lee, Sam" <sam@x.com>, bob@y.com`. */
export function parseAddresses(header: string | null | undefined): Person[] {
  if (!header) return []
  const out: Person[] = []
  let buf = ''
  let inQuotes = false
  let inAngle = false
  for (const ch of header) {
    if (ch === '"') inQuotes = !inQuotes
    else if (ch === '<' && !inQuotes) inAngle = true
    else if (ch === '>' && !inQuotes) inAngle = false
    if (ch === ',' && !inQuotes && !inAngle) {
      pushAddress(buf, out)
      buf = ''
    } else {
      buf += ch
    }
  }
  pushAddress(buf, out)
  return out
}

function pushAddress(raw: string, out: Person[]) {
  const s = raw.trim()
  if (!s) return
  const m = /^(.*)<([^>]+)>\s*$/.exec(s)
  if (m) {
    const email = m[2].trim()
    const name = m[1].trim().replace(/^"|"$/g, '').trim()
    out.push({ name: name || email, email })
  } else if (s.includes('@')) {
    out.push({ name: s, email: s })
  }
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'",
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#?\w+);/g, (m, e: string) =>
      ENTITIES[e] ?? (e.startsWith('#') ? String.fromCodePoint(Number(e.slice(1))) : m),
    )
}

/**
 * Drops quoted history and signatures so the glasses (and the AI) only see
 * what this message actually says.
 */
export function cleanBody(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const kept: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^On .+wrote:\s*$/.test(line) || /^On .+$/.test(line) && /wrote:\s*$/.test(lines[i + 1] ?? '')) break
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line)) break
    if (/^From: .+/.test(line) && /^(Sent|Date): /.test(lines[i + 1] ?? '')) break
    if (/^--\s*$/.test(line)) break // signature delimiter
    if (line.startsWith('>')) continue
    kept.push(line.trimEnd())
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

interface Part {
  mimeType?: string | null
  body?: { data?: string | null } | null
  parts?: Part[] | null
}

/** Finds the best text body in a Gmail message payload. */
export function extractBody(payload: Part | undefined | null): string {
  if (!payload) return ''
  const plain = findPart(payload, 'text/plain')
  if (plain) return cleanBody(decode(plain))
  const html = findPart(payload, 'text/html')
  return html ? cleanBody(htmlToText(decode(html))) : ''
}

function findPart(p: Part, mime: string): string | null {
  if (p.mimeType === mime && p.body?.data) return p.body.data
  for (const child of p.parts ?? []) {
    const found = findPart(child, mime)
    if (found) return found
  }
  return null
}

function decode(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8')
}
