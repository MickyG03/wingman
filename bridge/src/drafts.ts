// Drafts and invites the AI has prepared, waiting for the user's decision on
// the glasses. Persisted so a reconnect or bridge restart never loses one,
// and every action is idempotent: a draft is sent at most once.

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Draft, InviteDraft, ItemStatus } from '../../shared/protocol.ts'

/** Reply threading details kept on the bridge, never sent to the glasses. */
export interface DraftMeta {
  threadId?: string
  inReplyTo?: string
  references?: string
}

interface StoredDraft {
  draft: Draft
  meta: DraftMeta
}

interface FileShape {
  drafts: StoredDraft[]
  invites: InviteDraft[]
}

const KEEP_FINISHED_MS = 24 * 3_600_000

export type Outcome<T> = { ok: true; item: T; already: boolean } | { ok: false; reason: string }

export class DraftStore {
  private drafts = new Map<string, StoredDraft>()
  private invites = new Map<string, InviteDraft>()

  constructor(private readonly file: string | null) {
    if (file && fs.existsSync(file)) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8')) as FileShape
        for (const d of data.drafts ?? []) {
          // A crash mid-send leaves 'sending'; we can't know if Gmail got it, so
          // surface it as pending again rather than silently dropping it.
          if (d.draft.status === 'sending') d.draft.status = 'pending'
          this.drafts.set(d.draft.id, d)
        }
        for (const i of data.invites ?? []) {
          if (i.status === 'sending') i.status = 'pending'
          this.invites.set(i.id, i)
        }
      } catch (err) {
        console.warn(`[drafts] could not read ${file}: ${(err as Error).message}`)
      }
    }
  }

  private save() {
    if (!this.file) return
    const cutoff = Date.now() - KEEP_FINISHED_MS
    const fresh = <T extends { status: ItemStatus; createdAt: string }>(x: T) =>
      x.status === 'pending' || Date.parse(x.createdAt) > cutoff
    const data: FileShape = {
      drafts: [...this.drafts.values()].filter(d => fresh(d.draft)),
      invites: [...this.invites.values()].filter(fresh),
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2))
  }

  createDraft(fields: Omit<Draft, 'id' | 'status' | 'createdAt'>, meta: DraftMeta = {}): Draft {
    const draft: Draft = { ...fields, id: randomUUID(), status: 'pending', createdAt: new Date().toISOString() }
    this.drafts.set(draft.id, { draft, meta })
    this.save()
    return draft
  }

  createInvite(fields: Omit<InviteDraft, 'id' | 'status' | 'createdAt'>): InviteDraft {
    const invite: InviteDraft = { ...fields, id: randomUUID(), status: 'pending', createdAt: new Date().toISOString() }
    this.invites.set(invite.id, invite)
    this.save()
    return invite
  }

  getDraft(id: string): StoredDraft | undefined {
    return this.drafts.get(id)
  }

  getInvite(id: string): InviteDraft | undefined {
    return this.invites.get(id)
  }

  /** Replaces subject/body of a pending draft (Redo). */
  revise(id: string, subject: string, body: string): Draft | null {
    const d = this.drafts.get(id)
    if (!d || d.draft.status !== 'pending') return null
    d.draft = { ...d.draft, subject, body }
    this.save()
    return d.draft
  }

  pendingDrafts(): Draft[] {
    return [...this.drafts.values()]
      .map(d => d.draft)
      .filter(d => d.status === 'pending')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  pendingInvites(): InviteDraft[] {
    return [...this.invites.values()]
      .filter(i => i.status === 'pending')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /**
   * Moves a pending draft through `work` (send or save). If the draft already
   * finished, returns it with already=true instead of repeating the action.
   */
  async completeDraft(
    id: string,
    done: Extract<ItemStatus, 'sent' | 'saved' | 'discarded'>,
    work: (d: StoredDraft) => Promise<void>,
  ): Promise<Outcome<Draft>> {
    const d = this.drafts.get(id)
    if (!d) return { ok: false, reason: 'Draft not found' }
    if (d.draft.status === 'sending') return { ok: false, reason: 'Already sending' }
    if (d.draft.status !== 'pending') return { ok: true, item: d.draft, already: true }
    d.draft.status = 'sending'
    this.save()
    try {
      await work(d)
      d.draft.status = done
      return { ok: true, item: d.draft, already: false }
    } catch (err) {
      d.draft.status = 'pending'
      throw err
    } finally {
      this.save()
    }
  }

  async completeInvite(
    id: string,
    done: Extract<ItemStatus, 'created' | 'discarded'>,
    work: (i: InviteDraft) => Promise<void>,
  ): Promise<Outcome<InviteDraft>> {
    const i = this.invites.get(id)
    if (!i) return { ok: false, reason: 'Invite not found' }
    if (i.status === 'sending') return { ok: false, reason: 'Already sending' }
    if (i.status !== 'pending') return { ok: true, item: i, already: true }
    i.status = 'sending'
    this.save()
    try {
      await work(i)
      i.status = done
      return { ok: true, item: i, already: false }
    } catch (err) {
      i.status = 'pending'
      throw err
    } finally {
      this.save()
    }
  }
}
