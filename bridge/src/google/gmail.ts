import { gmail, type gmail_v1 } from '@googleapis/gmail'
import type { GoogleAuth } from './auth.ts'
import { extractBody, parseAddresses } from './parse.ts'
import type { MailPort, RawEmail } from './ports.ts'

const META_HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID', 'References']

/** Runs `fn` over `items` with at most `limit` in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    }),
  )
  return out
}

function toRaw(m: gmail_v1.Schema$Message, withBody: boolean): RawEmail {
  const headers = m.payload?.headers ?? []
  const h = (name: string) => headers.find(x => x.name?.toLowerCase() === name.toLowerCase())?.value ?? ''
  const from = parseAddresses(h('From'))[0] ?? { name: '(unknown)', email: '' }
  return {
    id: m.id ?? '',
    threadId: m.threadId ?? '',
    from,
    to: parseAddresses(h('To')),
    cc: parseAddresses(h('Cc')),
    subject: h('Subject') || '(no subject)',
    date: new Date(Number(m.internalDate ?? Date.now())).toISOString(),
    snippet: decodeSnippet(m.snippet ?? ''),
    bodyText: withBody ? extractBody(m.payload) : '',
    messageId: h('Message-ID') || undefined,
    references: h('References') || undefined,
    unread: m.labelIds?.includes('UNREAD') ?? false,
  }
}

function decodeSnippet(s: string): string {
  return s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

export class GmailMail implements MailPort {
  private readonly api: gmail_v1.Gmail

  constructor(private readonly auth: GoogleAuth) {
    this.api = gmail({ version: 'v1', auth: auth.client })
  }

  async profile() {
    return this.auth.call(async () => {
      const p = await this.api.users.getProfile({ userId: 'me' })
      const email = p.data.emailAddress ?? ''
      let name: string | undefined
      try {
        const sendAs = await this.api.users.settings.sendAs.list({ userId: 'me' })
        name = sendAs.data.sendAs?.find(s => s.isPrimary)?.displayName || undefined
      } catch {
        // Display name is a nicety; the address is enough.
      }
      return { email, name }
    })
  }

  private async listIds(params: gmail_v1.Params$Resource$Users$Messages$List): Promise<string[]> {
    const res = await this.api.users.messages.list({ userId: 'me', ...params })
    return (res.data.messages ?? []).map(m => m.id!).filter(Boolean)
  }

  private async fetch(ids: string[], withBody: boolean): Promise<RawEmail[]> {
    return mapLimit(ids, 8, async id => {
      const res = await this.api.users.messages.get(
        withBody
          ? { userId: 'me', id, format: 'full' }
          : { userId: 'me', id, format: 'metadata', metadataHeaders: META_HEADERS },
      )
      return toRaw(res.data, withBody)
    })
  }

  async listInbox(max: number) {
    return this.auth.call(async () => this.fetch(await this.listIds({ labelIds: ['INBOX'], maxResults: max }), false))
  }

  async getEmail(id: string) {
    return this.auth.call(async () => (await this.fetch([id], true))[0])
  }

  async getThread(threadId: string) {
    return this.auth.call(async () => {
      const res = await this.api.users.threads.get({ userId: 'me', id: threadId, format: 'full' })
      return (res.data.messages ?? []).map(m => toRaw(m, true))
    })
  }

  async searchWith(emails: string[], max: number) {
    if (emails.length === 0) return []
    // `{a b}` is Gmail's OR group.
    const terms = emails.flatMap(e => [`from:${e}`, `to:${e}`]).join(' ')
    return this.auth.call(async () =>
      this.fetch(await this.listIds({ q: `{${terms}} newer_than:120d`, maxResults: max }), true),
    )
  }

  async recentHeaders(max: number) {
    return this.auth.call(async () =>
      this.fetch(await this.listIds({ q: '{in:inbox in:sent} newer_than:180d', maxResults: max }), false),
    )
  }

  async markRead(id: string) {
    await this.auth.call(() =>
      this.api.users.messages.modify({ userId: 'me', id, requestBody: { removeLabelIds: ['UNREAD'] } }),
    )
  }

  async send(raw: string, threadId?: string) {
    return this.auth.call(async () => {
      const res = await this.api.users.messages.send({ userId: 'me', requestBody: { raw, threadId } })
      return { id: res.data.id ?? '' }
    })
  }

  async createDraft(raw: string, threadId?: string) {
    return this.auth.call(async () => {
      const res = await this.api.users.drafts.create({ userId: 'me', requestBody: { message: { raw, threadId } } })
      return { id: res.data.id ?? '' }
    })
  }
}
