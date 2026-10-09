// The chat agent: owns the tool registry, the conversation and approvals.

import type { CardItem, ChatContext, ChatReply, ChatTurn, DoneKind, PendingRef, Person } from '../../../shared/protocol.ts'
import type { UserContext } from '../ai/types.ts'
import type { ContactIndex } from '../contacts.ts'
import type { DraftStore } from '../drafts.ts'
import type { CalendarPort, DocsPort, DrivePort, MailPort, SheetsPort } from '../google/ports.ts'
import { Conversation } from './history.ts'
import type { LlmPort } from './llm.ts'
import { runTurn } from './loop.ts'
import { PendingStore } from './pending.ts'
import { agentSystemPrompt } from './prompts.ts'
import { builtinTools } from './tools/index.ts'
import type { AgentTool, ToolContext, ToolHost } from './types.ts'

export interface AgentDeps {
  llm: LlmPort
  mail: MailPort
  calendar: CalendarPort
  drive: DrivePort
  docs: DocsPort
  sheets: SheetsPort
  contacts: ContactIndex
  drafts: DraftStore
  host: ToolHost
  user: () => UserContext
  timeZone: string
  dataDir: string | null // null = nothing persisted (fake mode)
  maxCalls: number
  maxTurns: number
}

export class Agent {
  readonly pending: PendingStore
  private readonly convo: Conversation
  private tools: AgentTool[] = builtinTools()
  private busy = false

  constructor(private readonly d: AgentDeps) {
    this.pending = new PendingStore(d.dataDir ? `${d.dataDir}/pending.json` : null)
    this.convo = new Conversation(d.dataDir ? `${d.dataDir}/chat.json` : null, d.maxTurns)
  }

  addTools(extra: AgentTool[]) {
    const names = new Set(this.tools.map(t => t.name))
    this.tools = [...this.tools, ...extra.filter(t => !names.has(t.name))]
  }

  get toolNames(): string[] {
    return this.tools.map(t => t.name)
  }

  history(): ChatTurn[] {
    return this.convo.turns
  }

  reset() {
    this.convo.reset()
  }

  pendingActions(): PendingRef[] {
    return this.pending.list()
  }

  private toolContext(progress: (label: string) => void): ToolContext {
    const self: Person = { name: this.d.user().name, email: this.d.user().email }
    return {
      mail: this.d.mail,
      calendar: this.d.calendar,
      drive: this.d.drive,
      docs: this.d.docs,
      sheets: this.d.sheets,
      contacts: this.d.contacts,
      drafts: this.d.drafts,
      pending: this.pending,
      self,
      timeZone: this.d.timeZone,
      known: id => this.convo.known.has(id),
      progress,
      host: this.d.host,
    }
  }

  async ask(text: string, ctx: ChatContext, pick: CardItem | undefined, progress: (label: string) => void): Promise<ChatReply> {
    if (this.busy) throw new Error('Still working on the previous request')
    this.busy = true
    try {
      return await runTurn(
        { text, ctx, pick },
        this.convo,
        {
          llm: this.d.llm,
          tools: this.tools,
          system: () => agentSystemPrompt(this.d.user(), this.d.timeZone),
          toolContext: p => this.toolContext(p),
          maxCalls: this.d.maxCalls,
        },
        progress,
      )
    } finally {
      this.busy = false
    }
  }

  /** Executes (or discards) a prepared generic action after the user's tap. */
  async act(id: string, approve: boolean): Promise<{ kind: DoneKind; message: string }> {
    const { action, already } = await this.pending.complete(id, approve, async a => {
      const tool = this.tools.find(t => t.name === a.tool)
      if (!tool) throw new Error(`Tool ${a.tool} is no longer available`)
      await tool.run(a.args, this.toolContext(() => {}))
    })
    if (already) return { kind: action.status === 'done' ? 'done' : 'discarded', message: `Already ${action.status}` }
    if (!approve) {
      this.convo.note(`The user discarded the prepared action "${action.label}".`)
      return { kind: 'discarded', message: 'Discarded' }
    }
    this.convo.note(`The user approved and Wingman completed: ${action.label}.`)
    return { kind: 'done', message: `Done: ${action.label}` }
  }

  /** Lets the conversation know a draft/invite approval happened elsewhere. */
  note(text: string) {
    this.convo.note(text)
  }
}
