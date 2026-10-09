// Side effects the agent prepared (doc/sheet edits, event changes) that
// wait for a tap on the glasses. Same send-once state machine as DraftStore.

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Card, PendingRef } from '../../../shared/protocol.ts'

export interface PendingAction {
  id: string
  tool: string
  args: Record<string, unknown>
  label: string
  preview: Card
  status: 'pending' | 'running' | 'done' | 'discarded'
  createdAt: string
}

const TTL_MS = 30 * 60_000

export class PendingStore {
  private readonly items = new Map<string, PendingAction>()

  constructor(private readonly file: string | null) {
    if (file && fs.existsSync(file)) {
      try {
        for (const a of JSON.parse(fs.readFileSync(file, 'utf8')) as PendingAction[]) {
          if (a.status === 'running') a.status = 'pending'
          this.items.set(a.id, a)
        }
      } catch (err) {
        console.warn(`[pending] could not read ${file}: ${(err as Error).message}`)
      }
    }
  }

  private save() {
    if (!this.file) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify([...this.items.values()].filter(a => a.status === 'pending')))
  }

  private expire() {
    const cutoff = Date.now() - TTL_MS
    for (const [id, a] of this.items) if (a.status === 'pending' && Date.parse(a.createdAt) < cutoff) this.items.delete(id)
  }

  create(tool: string, args: Record<string, unknown>, label: string, preview: Card): PendingAction {
    const a: PendingAction = { id: randomUUID(), tool, args, label, preview, status: 'pending', createdAt: new Date().toISOString() }
    this.items.set(a.id, a)
    this.save()
    return a
  }

  get(id: string): PendingAction | undefined {
    this.expire()
    return this.items.get(id)
  }

  list(): PendingRef[] {
    this.expire()
    return [...this.items.values()]
      .filter(a => a.status === 'pending')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(a => ({ id: a.id, kind: 'action', label: a.label }))
  }

  /** Runs `work` once for a pending action; repeats return already=true. */
  async complete(id: string, approve: boolean, work: (a: PendingAction) => Promise<void>): Promise<{ action: PendingAction; already: boolean }> {
    const a = this.get(id)
    if (!a) throw new Error('That action expired. Ask again.')
    if (a.status === 'running') throw new Error('Already running')
    if (a.status !== 'pending') return { action: a, already: true }
    if (!approve) {
      a.status = 'discarded'
      this.save()
      return { action: a, already: false }
    }
    a.status = 'running'
    this.save()
    try {
      await work(a)
      a.status = 'done'
      return { action: a, already: false }
    } catch (err) {
      a.status = 'pending'
      throw err
    } finally {
      this.save()
    }
  }
}
