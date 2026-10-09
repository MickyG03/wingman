// Gemini's JSON-schema subset has no maxLength, and models occasionally drift,
// so every AI response is checked and clamped here before it reaches the
// glasses.

import type { Briefing, EmailCategory, Suggestion } from '../../../shared/protocol.ts'
import type { EmailText, HomeIntent, RedoText, TriageResult } from './types.ts'

const CATEGORIES: EmailCategory[] = ['action', 'fyi', 'newsletter', 'notification']

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

export function str(v: unknown, max: number, fallback = ''): string {
  if (typeof v !== 'string') return fallback
  const s = v.trim()
  return s.length > max ? `${s.slice(0, max - 3).trimEnd()}...` : s
}

function strList(v: unknown, maxItems: number, maxLen: number): string[] {
  return Array.isArray(v) ? v.map(x => str(x, maxLen)).filter(Boolean).slice(0, maxItems) : []
}

function suggestions(v: unknown): Suggestion[] {
  if (!Array.isArray(v)) return []
  return v
    .filter(isObj)
    .map(s => ({ label: str(s.label, 28), text: str(s.text, 1200) }))
    .filter(s => s.label && s.text)
    .slice(0, 3)
}

export function validateTriage(v: unknown, ids: string[]): TriageResult[] {
  const list = isObj(v) && Array.isArray(v.emails) ? v.emails : Array.isArray(v) ? v : []
  const wanted = new Set(ids)
  return list
    .filter(isObj)
    .filter(t => typeof t.id === 'string' && wanted.has(t.id))
    .map(t => {
      const category = CATEGORIES.includes(t.category as EmailCategory) ? (t.category as EmailCategory) : 'fyi'
      return {
        id: t.id as string,
        important: t.important === true && category !== 'newsletter' && category !== 'notification',
        category,
        summary: str(t.summary, 70),
        suggestions: suggestions(t.suggestions),
      }
    })
}

export function validateBriefing(v: unknown): Briefing {
  const o = isObj(v) ? v : {}
  return {
    purpose: str(o.purpose, 100),
    lastThread: str(o.lastThread, 260),
    points: strList(o.points, 3, 80),
  }
}

export function validateEmailText(v: unknown): EmailText {
  const o = isObj(v) ? v : {}
  const body = str(o.body, 3000)
  if (!body) throw new Error('AI returned an empty email')
  return { subject: str(o.subject, 150, '(no subject)'), body }
}

/** Checks the intent, including that an invite time is a real future date. */
export function validateIntent(v: unknown, now = Date.now()): HomeIntent {
  const o = isObj(v) ? v : {}
  if (o.intent === 'email') {
    const body = str(o.body, 3000)
    const recipients = strList(o.recipients, 10, 120)
    if (!body) return { intent: 'unknown', hint: 'Say what the email should say.' }
    if (recipients.length === 0) return { intent: 'unknown', hint: 'Who should the email go to?' }
    return { intent: 'email', recipients, subject: str(o.subject, 150, '(no subject)'), body }
  }
  if (o.intent === 'invite') {
    const start = Date.parse(String(o.startISO ?? ''))
    if (Number.isNaN(start)) return { intent: 'unknown', hint: 'When should the meeting be?' }
    if (start < now - 5 * 60_000) return { intent: 'unknown', hint: 'That time is in the past. Try again with a date.' }
    if (start > now + 366 * 86_400_000) return { intent: 'unknown', hint: 'That date is over a year away.' }
    const duration = Number(o.durationMin)
    return {
      intent: 'invite',
      title: str(o.title, 120, 'Meeting'),
      startISO: new Date(start).toISOString(),
      durationMin: Number.isFinite(duration) && duration >= 5 && duration <= 600 ? Math.round(duration) : 30,
      attendees: strList(o.attendees, 20, 120),
      location: str(o.location, 120) || undefined,
    }
  }
  return { intent: 'unknown', hint: str(o.hint, 120, "I didn't understand. Try \"Email Sam that...\" or \"Lunch with Sam Friday at 1\".") }
}

export function validateRedo(v: unknown): RedoText {
  const o = isObj(v) ? v : {}
  return { ...validateEmailText(o), to: strList(o.to, 10, 120) }
}
