import type { Person } from '../../../shared/protocol.ts'

export interface MimeInput {
  to: Person[]
  cc?: Person[]
  subject: string
  body: string
  inReplyTo?: string
  references?: string
}

const NON_ASCII = /[^\x20-\x7e]/

/** RFC 2047 encoded-word for header values that aren't plain ASCII. */
export function encodeHeaderWord(value: string): string {
  if (!NON_ASCII.test(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

export function formatAddress(p: Person): string {
  if (!p.name || p.name === p.email) return p.email
  const name = NON_ASCII.test(p.name) ? encodeHeaderWord(p.name) : `"${p.name.replace(/["\\]/g, '')}"`
  return `${name} <${p.email}>`
}

function stripCrlf(value: string): string {
  // Header injection guard: a newline in a subject would start a new header.
  return value.replace(/[\r\n]+/g, ' ').trim()
}

/** Builds an RFC 2822 message and returns it base64url-encoded for the Gmail API. */
export function buildMime(input: MimeInput): string {
  if (input.to.length === 0) throw new Error('Email needs at least one recipient')
  const headers = [
    `To: ${input.to.map(formatAddress).join(', ')}`,
    ...(input.cc?.length ? [`Cc: ${input.cc.map(formatAddress).join(', ')}`] : []),
    `Subject: ${encodeHeaderWord(stripCrlf(input.subject))}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${stripCrlf(input.inReplyTo)}`] : []),
    ...(input.inReplyTo || input.references
      ? [`References: ${stripCrlf([input.references, input.inReplyTo].filter(Boolean).join(' '))}`]
      : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ]
  const body = Buffer.from(input.body.replace(/\r?\n/g, '\r\n'), 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n')
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`, 'utf8').toString('base64url')
}

export function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`
}
