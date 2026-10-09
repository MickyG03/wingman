// One conversational turn: the model proposes tool calls, we run the safe
// ones and prepare the risky ones, until it answers in words.

import type { FunctionDeclaration } from '@google/genai'
import { randomUUID } from 'node:crypto'
import type { Card, CardItem, ChatContext, ChatReply, PendingRef } from '../../../shared/protocol.ts'
import { str as clampStr } from '../ai/validate.ts'
import { AuthNeededError } from '../google/ports.ts'
import type { Conversation } from './history.ts'
import type { LlmPort } from './llm.ts'
import { userTurn } from './prompts.ts'
import { digest } from './summarize.ts'
import { ToolError, type AgentTool, type ToolContext, type ToolResult } from './types.ts'

const REPLY_MAX = 320

export interface TurnInput {
  text: string
  ctx: ChatContext
  pick?: CardItem
}

export interface LoopDeps {
  llm: LlmPort
  tools: AgentTool[]
  system: () => string
  toolContext: (progress: (label: string) => void) => ToolContext
  maxCalls: number
}

export function declarations(tools: AgentTool[]): FunctionDeclaration[] {
  return tools.map(t => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters }))
}

function kindOf(result: unknown): string {
  const o = result as Record<string, unknown>
  if (o?.emails || o?.threadId) return 'email'
  if (o?.events || (o?.start && o?.title)) return 'event'
  if (o?.files || o?.kind === 'doc' || o?.kind === 'sheet') return 'file'
  if (o?.contacts) return 'contact'
  return 'item'
}

export async function runTurn(input: TurnInput, convo: Conversation, deps: LoopDeps, progress: (label: string) => void): Promise<ChatReply> {
  const started = Date.now()
  const byName = new Map(deps.tools.map(t => [t.name, t]))
  const ctx = deps.toolContext(progress)
  const decls = declarations(deps.tools)

  convo.push({ role: 'user', parts: [{ text: userTurn(input.text, input.ctx, convo.lastCard, input.pick) }] })
  if (input.pick) convo.known.set(input.pick.id, input.pick.kind)

  let card: Card | undefined
  let pending: PendingRef | undefined
  let calls = 0
  let text = ''

  for (let round = 0; round <= deps.maxCalls; round++) {
    const step = await deps.llm.generate(deps.system(), convo.contents, decls)
    convo.push(step.content)
    if (step.calls.length === 0) {
      text = step.text
      break
    }
    if (calls + step.calls.length > deps.maxCalls) {
      // Out of budget: one last, tool-free chance to answer in words.
      convo.push({ role: 'user', parts: [{ text: '[system note] Tool budget for this turn is used up. Answer with what you have, in words.' }] })
      const last = await deps.llm.generate(deps.system(), convo.contents, [])
      convo.push(last.content)
      text = last.text
      break
    }
    const responses = []
    for (const call of step.calls) {
      calls++
      const name = call.name ?? ''
      const args = (call.args ?? {}) as Record<string, unknown>
      const tool = byName.get(name)
      let result: ToolResult
      const t0 = Date.now()
      try {
        if (!tool) throw new ToolError(`Unknown tool "${name}"`)
        if (tool.progress) progress(tool.progress)
        result = tool.prepare ? await tool.prepare(args, ctx) : await tool.run(args, ctx)
        convo.harvest(result.forModel, kindOf(result.forModel))
        if (result.card) convo.harvest(result.card.kind === 'list' ? { items: result.card.items } : {}, 'item')
        console.log(`[agent] ${name} ${Date.now() - t0}ms ${digest(result.forModel, 80)}`)
      } catch (err) {
        if (err instanceof AuthNeededError) throw err
        const message = (err as Error).message ?? String(err)
        console.warn(`[agent] ${name} failed: ${message}`)
        result = { forModel: { error: message } }
      }
      if (result.card) card = result.card
      if (result.pending) pending = result.pending
      responses.push({ functionResponse: { name, response: toObject(result.forModel) } })
    }
    convo.push({ role: 'user', parts: responses })
  }

  if (!text) text = card ? 'Here you go.' : "I couldn't finish that. Try asking in a different way."
  const reply: ChatReply = { turnId: randomUUID(), text: clampStr(text, REPLY_MAX), card, pending }
  convo.commit({ id: reply.turnId, at: new Date().toISOString(), heard: input.text, reply })
  console.log(`[agent] turn done in ${Date.now() - started}ms, ${calls} tool call(s)${pending ? `, pending ${pending.kind}` : ''}`)
  return reply
}

function toObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { result: v }
}
