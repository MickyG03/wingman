import { describe, expect, it, vi } from 'vitest'
import { parseWhen } from '../src/ai/fake.ts'
import { validateIntent, validateTriage } from '../src/ai/validate.ts'
import { ContactIndex } from '../src/contacts.ts'
import { DraftStore } from '../src/drafts.ts'
import { buildMime, replySubject } from '../src/google/mime.ts'
import { cleanBody, parseAddresses } from '../src/google/parse.ts'

const decode = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8')

describe('mime', () => {
  it('builds a threaded reply with encoded headers', () => {
    const raw = decode(
      buildMime({
        to: [{ name: 'Sam Lee', email: 'sam@x.com' }],
        subject: 'Re: Café plans\r\nBcc: evil@x.com',
        body: 'Hi Sam,\nSee you there.',
        inReplyTo: '<abc@x>',
        references: '<root@x>',
      }),
    )
    expect(raw).toContain('To: "Sam Lee" <sam@x.com>')
    expect(raw).toMatch(/^Subject: =\?UTF-8\?B\?/m)
    expect(raw).not.toMatch(/^Bcc:/m) // newline in subject can't inject headers
    expect(raw).toContain('In-Reply-To: <abc@x>')
    expect(raw).toContain('References: <root@x> <abc@x>')
    const body = raw.split('\r\n\r\n')[1].replace(/\r\n/g, '')
    expect(Buffer.from(body, 'base64').toString('utf8')).toBe('Hi Sam,\r\nSee you there.')
  })

  it('refuses an email with no recipients', () => {
    expect(() => buildMime({ to: [], subject: 's', body: 'b' })).toThrow()
  })

  it('adds Re: once', () => {
    expect(replySubject('Lunch')).toBe('Re: Lunch')
    expect(replySubject('RE: Lunch')).toBe('RE: Lunch')
  })
})

describe('parse', () => {
  it('parses address lists with quoted commas', () => {
    expect(parseAddresses('"Lee, Sam" <sam@x.com>, bob@y.com')).toEqual([
      { name: 'Lee, Sam', email: 'sam@x.com' },
      { name: 'bob@y.com', email: 'bob@y.com' },
    ])
  })

  it('drops quoted history and signatures', () => {
    const text = 'Sounds good!\n\n--\nSam\nVP Things\n\nOn Mon, Oct 6, 2026 Priya wrote:\n> old'
    expect(cleanBody(text)).toBe('Sounds good!')
    expect(cleanBody('Yes.\n> quoted\nThanks')).toBe('Yes.\nThanks')
  })
})

describe('contacts', () => {
  const idx = new ContactIndex()
  idx.setSelf('me@x.com')
  idx.add({ name: 'Priya Sharma', email: 'priya@acme.com' }, 2)
  idx.add({ name: 'Priya Sharma', email: 'priya@acme.com' }, 3)
  idx.add({ name: 'Priya Patel', email: 'priya.patel@mail.com' }, 1)
  idx.add({ name: 'Sam Lee', email: 'sam.lee@acme.com' }, 1)
  idx.add({ name: 'GitHub', email: 'notifications@github.com' }, 9)
  idx.add({ name: 'Me', email: 'me@x.com' }, 9)

  it('asks when a first name is shared', () => {
    const m = idx.match('Priya')
    expect(m.kind).toBe('many')
    if (m.kind === 'many') expect(m.candidates.map(c => c.name)).toEqual(['Priya Sharma', 'Priya Patel'])
  })

  it('resolves full names, unique first names and spoken addresses', () => {
    expect(idx.match('priya patel')).toEqual({ kind: 'one', person: { name: 'Priya Patel', email: 'priya.patel@mail.com' } })
    expect(idx.match('Sam')).toMatchObject({ kind: 'one', person: { email: 'sam.lee@acme.com' } })
    expect(idx.match('new@person.com')).toMatchObject({ kind: 'one', person: { email: 'new@person.com' } })
    expect(idx.match('Zed')).toEqual({ kind: 'none' })
  })

  it('skips self and automated senders', () => {
    expect(idx.match('GitHub')).toEqual({ kind: 'none' })
    expect(idx.topNames(10)).not.toContain('Me')
  })
})

describe('validate', () => {
  const now = Date.parse('2026-10-09T12:00:00Z')

  it('rejects invites in the past and unparseable times', () => {
    expect(validateIntent({ intent: 'invite', startISO: '2026-10-01T12:00:00Z' }, now)).toMatchObject({ intent: 'unknown' })
    expect(validateIntent({ intent: 'invite', startISO: 'Thursday' }, now)).toMatchObject({ intent: 'unknown' })
    expect(
      validateIntent({ intent: 'invite', title: 'Lunch', startISO: '2026-10-15T12:30:00-07:00', durationMin: 9999, attendees: ['Sam'] }, now),
    ).toMatchObject({ intent: 'invite', durationMin: 30, startISO: '2026-10-15T19:30:00.000Z' })
  })

  it('needs recipients and a body for emails', () => {
    expect(validateIntent({ intent: 'email', recipients: [], body: 'x' }, now)).toMatchObject({ intent: 'unknown' })
    expect(validateIntent({ intent: 'email', recipients: ['Sam'], body: 'Hi' }, now)).toMatchObject({ intent: 'email' })
  })

  it('keeps only requested triage ids and never marks newsletters important', () => {
    const out = validateTriage(
      { emails: [{ id: 'a', important: true, category: 'newsletter', summary: 'x'.repeat(200) }, { id: 'zzz', important: true }] },
      ['a'],
    )
    expect(out).toHaveLength(1)
    expect(out[0].important).toBe(false)
    expect(out[0].summary.length).toBeLessThanOrEqual(70)
  })
})

describe('fake when parser', () => {
  it('resolves weekday and pm defaults', () => {
    const thu = parseWhen('lunch with Sam Thursday at 1', new Date(2026, 9, 9, 10)) // Fri Oct 9
    expect(thu.getDay()).toBe(4)
    expect(thu.getHours()).toBe(13)
    expect(parseWhen('call tomorrow at 9:30 am', new Date(2026, 9, 9, 10)).getHours()).toBe(9)
  })
})

describe('DraftStore', () => {
  const fields = { kind: 'new' as const, to: [{ name: 'S', email: 's@x.com' }], cc: [], subject: 's', body: 'b' }

  it('sends a draft at most once', async () => {
    const store = new DraftStore(null)
    const d = store.createDraft(fields)
    const work = vi.fn(async () => {})
    const first = await store.completeDraft(d.id, 'sent', work)
    const second = await store.completeDraft(d.id, 'sent', work)
    expect(first).toMatchObject({ ok: true, already: false })
    expect(second).toMatchObject({ ok: true, already: true })
    expect(work).toHaveBeenCalledTimes(1)
    expect(store.pendingDrafts()).toHaveLength(0)
  })

  it('returns a draft to pending when sending fails', async () => {
    const store = new DraftStore(null)
    const d = store.createDraft(fields)
    await expect(store.completeDraft(d.id, 'sent', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(store.getDraft(d.id)?.draft.status).toBe('pending')
  })

  it('blocks a concurrent second send', async () => {
    const store = new DraftStore(null)
    const d = store.createDraft(fields)
    let release!: () => void
    const slow = store.completeDraft(d.id, 'sent', () => new Promise<void>(r => (release = r)))
    expect(await store.completeDraft(d.id, 'sent', async () => {})).toEqual({ ok: false, reason: 'Already sending' })
    release()
    await slow
  })
})
