import type { Briefing, EmailCategory, Meeting, Person, Suggestion, VoiceExchange } from '../../../shared/protocol.ts'
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

/** Redo may also change who the email goes to. */
export interface RedoText extends EmailText {
  /** New recipients (names or addresses) if the instruction changed them; empty = keep. */
  to: string[]
}

export interface DraftText extends EmailText {
  to: Person[]
}

export interface Ai {
  readonly name: string
  triage(items: TriageInput[]): Promise<TriageResult[]>
  briefing(meeting: Meeting, related: RawEmail[]): Promise<Briefing>
  homeIntent(transcript: string, contactNames: string[], recent: VoiceExchange[]): Promise<HomeIntent>
  reply(thread: RawEmail[], instruction: string): Promise<EmailText>
  followup(meeting: Meeting, notes: string): Promise<EmailText>
  redo(draft: DraftText, instruction: string): Promise<RedoText>
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
