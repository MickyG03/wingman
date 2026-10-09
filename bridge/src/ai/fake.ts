// Deterministic stand-in for Gemini when GEMINI_API_KEY is not set, so the
// whole flow can be exercised in the simulator. Output is obviously canned.

import type { Briefing, EmailCategory, Meeting } from '../../../shared/protocol.ts'
import type { RawEmail } from '../google/ports.ts'
import { firstName } from './prompts.ts'
import type { Ai, DraftText, EmailText, HomeIntent, TriageInput, TriageResult, UserContext } from './types.ts'
import { str, validateIntent } from './validate.ts'

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

function sentence(s: string): string {
  const t = s.trim().replace(/\s+/g, ' ')
  if (!t) return t
  const capped = t[0].toUpperCase() + t.slice(1)
  return /[.!?]$/.test(capped) ? capped : `${capped}.`
}

function firstSentence(s: string): string {
  // Skip greetings like "Hi!" or "Hi Sam," so the summary says something.
  const body = s.trim().replace(/^(hi|hello|hey|dear|good (morning|afternoon))\b[^.!?,]{0,20}[.!?,]\s*/i, '')
  return (body.split(/(?<=[.!?])\s+/)[0] ?? body).trim()
}

/** Very small "Thursday at 1pm" / "tomorrow at 12:30" parser for the fake intent. */
export function parseWhen(text: string, now: Date): Date {
  const t = text.toLowerCase()
  const d = new Date(now)
  const day = DAYS.findIndex(name => t.includes(name))
  if (t.includes('tomorrow')) d.setDate(d.getDate() + 1)
  else if (day >= 0) d.setDate(d.getDate() + (((day - d.getDay() + 7) % 7) || 7))
  else if (!t.includes('today')) d.setDate(d.getDate() + 1)
  const m = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?=\W|$)/.exec(t.replace(/\b(at|on)\b/g, ' $1 '))
  let hour = 12
  let minute = 0
  if (m) {
    hour = Number(m[1])
    minute = Number(m[2] ?? 0)
    const ampm = m[3]?.[0]
    if (ampm === 'p' && hour < 12) hour += 12
    if (!ampm && hour >= 1 && hour <= 7) hour += 12 // "at 1" means 1 PM
  }
  d.setHours(hour, minute, 0, 0)
  return d
}

export class FakeAi implements Ai {
  readonly name = 'fake (set GEMINI_API_KEY for real drafts)'

  constructor(private readonly user: () => UserContext) {}

  private signOff() {
    return `Best,\n${firstName(this.user().name)}`
  }

  async triage(items: TriageInput[]): Promise<TriageResult[]> {
    return items.map(i => {
      const email = i.from.email.toLowerCase()
      const category: EmailCategory = /notification|noreply|no-reply|github/.test(email)
        ? 'notification'
        : /newsletter|brew|crew|digest/.test(email)
          ? 'newsletter'
          : i.snippet.includes('?')
            ? 'action'
            : 'fyi'
      const hi = `Hi ${firstName(i.from.name)},\n\n`
      return {
        id: i.id,
        important: category === 'action',
        category,
        summary: str(firstSentence(i.snippet) || i.subject, 60),
        suggestions:
          category === 'action'
            ? [
                { label: 'Sounds good', text: `${hi}Sounds good, thanks!\n\n${this.signOff()}` },
                { label: 'Let me check', text: `${hi}Let me check and get back to you today.\n\n${this.signOff()}` },
                { label: 'Can we talk?', text: `${hi}Could we discuss this live? Grab any slot on my calendar.\n\n${this.signOff()}` },
              ]
            : [],
      }
    })
  }

  async briefing(meeting: Meeting, related: RawEmail[]): Promise<Briefing> {
    const latest = related[0]
    const text = related.map(r => r.bodyText || r.snippet).join(' ')
    const points = text
      .split(/(?<=[.!?])\s+/)
      .filter(s => /\?|\$|\d{1,2}(st|nd|rd|th)?\b|deadline|by /i.test(s))
      .slice(0, 3)
      .map(s => str(s, 60))
    return {
      purpose: str(meeting.description || meeting.title, 80),
      lastThread: latest ? str(`${latest.from.name}: ${firstSentence(latest.bodyText || latest.snippet)}`, 200) : '',
      points,
    }
  }

  async homeIntent(transcript: string, _contactNames: string[]): Promise<HomeIntent> {
    const t = transcript.trim()
    const lower = t.toLowerCase()
    const invite = /\b(lunch|dinner|coffee|meeting|meet|call|invite|schedule|sync)\b/.test(lower)
    const email = /^(email|e-mail|send|tell|write|ask|message|reply)\b/.test(lower)
    if (invite && !email) {
      const withWho = /\bwith\s+([a-z]+(?:\s+[a-z]+)?)/i
        .exec(t)?.[1]
        ?.replace(/\s+(on|at|tomorrow|today|next|this|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.*$/i, '')
      const what = /\b(lunch|dinner|coffee|call|sync|meeting)\b/i.exec(t)?.[1] ?? 'Meeting'
      const start = parseWhen(t, new Date())
      return validateIntent({
        intent: 'invite',
        title: withWho ? `${sentence(what).slice(0, -1)} with ${withWho}` : sentence(what).slice(0, -1),
        startISO: start.toISOString(),
        durationMin: /lunch|dinner/i.test(what) ? 60 : 30,
        attendees: withWho ? [withWho] : [],
      })
    }
    if (email) {
      const m = /^(?:email|e-mail|send|tell|write|ask|message|reply)(?:\s+(?:an?\s+)?(?:email|e-mail|note|message))?(?:\s+to)?\s+([a-z0-9@._-]+(?:\s+[a-z]+)?)\s*(?:that|saying|about|to|asking|,)?\s*(.*)$/i.exec(t)
      if (!m) return { intent: 'unknown', hint: 'Try "Email Sam that I am running late".' }
      let [, who, rest] = m
      // "Sam that" can slip into the name capture when the second word isn't a surname.
      who = who.replace(/\s+(that|saying|about|to|asking)$/i, '')
      const body = `Hi ${firstName(who)},\n\n${sentence(rest || 'Quick note.')}\n\n${this.signOff()}`
      return validateIntent({ intent: 'email', recipients: [who], subject: str(sentence(rest).replace(/\.$/, ''), 60, 'Quick note'), body })
    }
    return { intent: 'unknown', hint: 'Try "Email Sam that..." or "Lunch with Sam Friday at 1".' }
  }

  async reply(thread: RawEmail[], instruction: string): Promise<EmailText> {
    const last = thread[thread.length - 1]
    const to = last?.from.name ?? 'there'
    return {
      subject: last ? (/^re:/i.test(last.subject) ? last.subject : `Re: ${last.subject}`) : 'Re:',
      body: `Hi ${firstName(to)},\n\n${sentence(instruction)}\n\n${this.signOff()}`,
    }
  }

  async followup(meeting: Meeting, notes: string): Promise<EmailText> {
    return {
      subject: `Follow-up: ${meeting.title}`,
      body: `Hi all,\n\nThanks for the time today. ${sentence(notes)}\n\n${this.signOff()}`,
    }
  }

  async redo(draft: DraftText, instruction: string): Promise<EmailText> {
    const greeting = draft.body.split('\n')[0] || `Hi ${firstName(draft.to[0]?.name ?? 'there')},`
    return { subject: draft.subject, body: `${greeting}\n\n${sentence(instruction)}\n\n${this.signOff()}` }
  }
}

