// The conversation: what the glasses show (turns) and what the model sees
// (contents), plus the ids the model is allowed to reference.

import type { Content, Part } from '@google/genai'
import fs from 'node:fs'
import path from 'node:path'
import type { Card, ChatTurn } from '../../../shared/protocol.ts'
import { digest } from './summarize.ts'

const DIGEST_AFTER_TURNS = 2

interface Saved {
  turns: ChatTurn[]
  contents: Content[]
  known: [string, string][]
}

export class Conversation {
  turns: ChatTurn[] = []
  contents: Content[] = []
  /** id → kind, harvested from tool results. */
  readonly known = new Map<string, string>()
  lastCard: Card | undefined

  constructor(
    private readonly file: string | null,
    private readonly maxTurns: number,
  ) {
    if (file && fs.existsSync(file)) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Saved
        this.turns = data.turns ?? []
        this.contents = data.contents ?? []
        for (const [id, kind] of data.known ?? []) this.known.set(id, kind)
        this.lastCard = this.turns[this.turns.length - 1]?.reply.card
      } catch (err) {
        console.warn(`[chat] could not read ${file}: ${(err as Error).message}`)
      }
    }
  }

  save() {
    if (!this.file) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const data: Saved = { turns: this.turns, contents: this.contents, known: [...this.known] }
    fs.writeFileSync(this.file, JSON.stringify(data))
  }

  reset() {
    this.turns = []
    this.contents = []
    this.known.clear()
    this.lastCard = undefined
    this.save()
  }

  /** Remembers every id in a tool result so later references can be checked. */
  harvest(value: unknown, kind: string) {
    const visit = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(visit)
      else if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>
        if (typeof o.id === 'string') this.known.set(o.id, kind)
        for (const k of ['items', 'emails', 'events', 'files', 'contacts', 'rows', 'thread']) if (k in o) visit(o[k])
      }
    }
    visit(value)
  }

  push(content: Content) {
    this.contents.push(content)
  }

  /** Records a finished turn and trims history. */
  commit(turn: ChatTurn) {
    this.turns.push(turn)
    if (turn.reply.card) this.lastCard = turn.reply.card
    while (this.turns.length > this.maxTurns) this.turns.shift()
    this.compact()
    this.save()
  }

  /** Notes an approved action so the model knows it happened. */
  note(text: string) {
    this.contents.push({ role: 'user', parts: [{ text: `[system note] ${text}` }] })
    this.contents.push({ role: 'model', parts: [{ text: 'Noted.' }] })
    this.save()
  }

  /**
   * Keeps the model's context small: tool results older than the last few
   * turns become one-line digests, and the content list is capped to what
   * the kept turns need.
   */
  private compact() {
    // Find the start of the last DIGEST_AFTER_TURNS user turns.
    let userTurns = 0
    let keepFrom = this.contents.length
    for (let i = this.contents.length - 1; i >= 0; i--) {
      const c = this.contents[i]
      if (c.role === 'user' && c.parts?.some(p => typeof (p as Part).text === 'string' && !String((p as Part).text).startsWith('[system note]'))) {
        userTurns++
        if (userTurns >= DIGEST_AFTER_TURNS) {
          keepFrom = i
          break
        }
      }
    }
    for (let i = 0; i < keepFrom; i++) {
      const c = this.contents[i]
      c.parts = c.parts?.map(p => {
        const fr = (p as Part).functionResponse
        if (!fr) return p
        return { functionResponse: { name: fr.name, response: { digest: digest(fr.response, 200) } } }
      })
    }
    // Hard cap on raw content entries (each turn is ~2 + 2 per tool call).
    const cap = this.maxTurns * 8
    if (this.contents.length > cap) {
      // Never cut in the middle of a call/response pair: start at a user text turn.
      let cut = this.contents.length - cap
      while (cut < this.contents.length && !(this.contents[cut].role === 'user' && (this.contents[cut].parts?.[0] as Part)?.text)) cut++
      this.contents = this.contents.slice(cut)
    }
  }
}
