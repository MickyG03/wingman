// Resolves spoken names ("Priya", "Sam Lee") to email addresses using the
// people the user has actually corresponded with. No People API scope needed.

import type { Person } from '../../shared/protocol.ts'

interface Entry {
  person: Person
  count: number
  lastSeen: number
}

export type MatchResult =
  | { kind: 'one'; person: Person }
  | { kind: 'many'; candidates: Person[] }
  | { kind: 'none' }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const AUTOMATED = /(no-?reply|donotreply|notifications?|mailer-daemon|bounce|newsletter|updates?|news|crew|support|info)@/i

const norm = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9@.\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** How well `query` names `p`: 3 exact full name, 2 a whole word, 1 a prefix, 0 none. */
export function nameTier(query: string, p: Person): number {
  const q = norm(query)
  if (!q) return 0
  const name = norm(p.name === p.email ? '' : p.name)
  const local = norm(p.email.split('@')[0].replace(/[._-]+/g, ' '))
  // Only a display-name match is "exact": priya@ shouldn't beat Priya Patel for "Priya".
  if (name === q || (!name && local === q)) return 3
  const words = new Set([...name.split(' '), ...local.split(' ')].filter(Boolean))
  const qWords = q.split(' ')
  if (qWords.every(w => words.has(w))) return 2
  if (qWords.every(w => [...words].some(x => x.startsWith(w) && w.length >= 3))) return 1
  return 0
}

export class ContactIndex {
  private readonly byEmail = new Map<string, Entry>()
  private readonly seenMessages = new Set<string>()
  private selfEmail = ''

  setSelf(email: string) {
    this.selfEmail = email.toLowerCase()
  }

  /** Adds everyone on a message once, however often the message is seen. */
  addMessage(messageId: string, people: Person[], seenAt: number): boolean {
    if (this.seenMessages.has(messageId)) return false
    this.seenMessages.add(messageId)
    for (const p of people) this.add(p, seenAt)
    return true
  }

  toJSON(): Entry[] {
    return [...this.byEmail.values()]
  }

  load(entries: Entry[]) {
    for (const e of entries) {
      if (e?.person?.email && !this.byEmail.has(e.person.email)) this.byEmail.set(e.person.email, { ...e })
    }
  }

  add(p: Person, seenAt: number) {
    const email = p.email.toLowerCase()
    if (!EMAIL.test(email) || email === this.selfEmail || AUTOMATED.test(email)) return
    const e = this.byEmail.get(email)
    if (e) {
      e.count++
      e.lastSeen = Math.max(e.lastSeen, seenAt)
      // Prefer a real display name over a bare address.
      if (e.person.name === e.person.email && p.name !== p.email) e.person = { ...p, email }
    } else {
      this.byEmail.set(email, { person: { name: p.name || email, email }, count: 1, lastSeen: seenAt })
    }
  }

  get size() {
    return this.byEmail.size
  }

  /** Display names for the AI prompt, most relevant first. */
  topNames(limit: number): string[] {
    return [...this.byEmail.values()]
      .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen)
      .slice(0, limit)
      .map(e => e.person.name)
  }

  match(query: string): MatchResult {
    const q = query.trim()
    if (EMAIL.test(q)) return { kind: 'one', person: this.byEmail.get(q.toLowerCase())?.person ?? { name: q, email: q } }

    const scored = [...this.byEmail.values()]
      .map(e => ({ e, tier: nameTier(q, e.person) }))
      .filter(s => s.tier > 0)
      .sort((a, b) => b.tier - a.tier || b.e.count - a.e.count || b.e.lastSeen - a.e.lastSeen)
    if (scored.length === 0) return { kind: 'none' }

    const best = scored[0].tier
    const top = scored.filter(s => s.tier === best)
    if (top.length === 1) return { kind: 'one', person: top[0].e.person }
    return { kind: 'many', candidates: top.slice(0, 5).map(s => s.e.person) }
  }
}
