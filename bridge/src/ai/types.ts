import type { Briefing, EmailCategory, Meeting, Person, Suggestion } from '../../../shared/protocol.ts'
import type { RawEmail } from '../google/ports.ts'

export interface TriageInput {
  id: string
  from: Person
  subject: string
  snippet: string
  date: string
}

export interface TriageResult {
  id: string
  important: boolean
  category: EmailCategory
  summary: string
  suggestions: Suggestion[]
}

export type HomeIntent =
  | { intent: 'email'; recipients: string[]; subject: string; body: string }
  | { intent: 'invite'; title: string; startISO: string; durationMin: number; attendees: string[]; location?: string }
  | { intent: 'unknown'; hint: string }

export interface EmailText {
  subject: string
  body: string
}

export interface DraftText extends EmailText {
  to: Person[]
}

export interface Ai {
  readonly name: string
  triage(items: TriageInput[]): Promise<TriageResult[]>
  briefing(meeting: Meeting, related: RawEmail[]): Promise<Briefing>
  homeIntent(transcript: string, contactNames: string[]): Promise<HomeIntent>
  reply(thread: RawEmail[], instruction: string): Promise<EmailText>
  followup(meeting: Meeting, notes: string): Promise<EmailText>
  redo(draft: DraftText, instruction: string): Promise<EmailText>
}

export interface UserContext {
  name: string
  email: string
}

export class AiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AiError'
  }
}
