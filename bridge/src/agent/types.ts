import type { Card, PendingRef, Person } from '../../../shared/protocol.ts'
import type { ContactIndex } from '../contacts.ts'
import type { DraftStore } from '../drafts.ts'
import type { CalendarPort, DocsPort, DrivePort, MailPort, SheetsPort } from '../google/ports.ts'
import type { PendingStore } from './pending.ts'

/** A JSON-schema object the model sees as the tool's parameters. */
export interface JsonSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
}

export interface ToolResult {
  /** What the model gets back. Keep it small; see summarize.ts. */
  forModel: unknown
  /** Something for the glasses to show alongside the reply. */
  card?: Card
  /** A prepared side effect awaiting the user's tap. */
  pending?: PendingRef
}

export interface ToolContext {
  mail: MailPort
  calendar: CalendarPort
  drive: DrivePort
  docs: DocsPort
  sheets: SheetsPort
  contacts: ContactIndex
  drafts: DraftStore
  pending: PendingStore
  self: Person
  timeZone: string
  /** Ids the model is allowed to reference (harvested from earlier tool results). */
  known: (id: string) => boolean
  /** Short status for the glasses while the tool runs. */
  progress: (label: string) => void
  /** Hooks into Wingman for things it already does well (email detail, reply drafts). */
  host: ToolHost
}

export interface ToolHost {
  emailDetail(id: string): Promise<{ subject: string; from: Person; bodyText: string; suggestions: { label: string; text: string }[] }>
  replyDraft(emailId: string, body: string): Promise<{ id: string; to: Person[]; subject: string }>
  meetingBriefing(eventId: string): Promise<{ title: string; purpose: string; lastThread: string; points: string[] }>
}

export interface AgentTool {
  name: string
  description: string
  parameters: JsonSchema
  /** Progress label shown while running, e.g. "Searching Drive...". */
  progress?: string
  /**
   * Side-effect tools implement `prepare` (build a preview, store a pending
   * action) and `run` (execute after approval). Read-only tools only `run`.
   */
  prepare?(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}

export const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v.trim() : fallback)
export const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
export const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(Boolean) : []

export class ToolError extends Error {}
