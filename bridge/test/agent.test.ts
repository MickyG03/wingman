import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatContext } from '../../shared/protocol.ts'
import { Agent } from '../src/agent/agent.ts'
import { Conversation } from '../src/agent/history.ts'
import { ScriptedLlm, type LlmPort, type LlmStep } from '../src/agent/llm.ts'
import { runTurn } from '../src/agent/loop.ts'
import { PendingStore } from '../src/agent/pending.ts'
import type { AgentTool } from '../src/agent/types.ts'
import { ContactIndex } from '../src/contacts.ts'
import { DraftStore } from '../src/drafts.ts'
import { FakeCalendar, FakeMail, FakeWorkspace } from '../src/google/fake.ts'
import { SELF } from '../src/google/fixtures.ts'

const ctx: ChatContext = { screen: 'home' }
const quiet = () => {}

function makeAgent(llm: LlmPort = new ScriptedLlm()) {
  const mail = new FakeMail()
  const calendar = new FakeCalendar()
  const workspace = new FakeWorkspace()
  const contacts = new ContactIndex()
  contacts.setSelf(SELF.email)
  contacts.add({ name: 'Sam Lee', email: 'sam.lee@acme.example' }, Date.now())
  contacts.add({ name: 'Priya Sharma', email: 'priya@acme.example' }, Date.now())
  contacts.add({ name: 'Priya Patel', email: 'priya.patel@mail.example' }, Date.now())
  const drafts = new DraftStore(null)
  const agent = new Agent({
    llm,
    mail,
    calendar,
    drive: workspace,
    docs: workspace,
    sheets: workspace,
    contacts,
    drafts,
    host: {
      emailDetail: async id => {
        const m = await mail.getEmail(id)
        return { subject: m.subject, from: m.from, bodyText: m.bodyText, suggestions: [] }
      },
      replyDraft: async (emailId, body) => {
        const m = await mail.getEmail(emailId)
        const d = drafts.createDraft({ kind: 'reply', to: [m.from], cc: [], subject: `Re: ${m.subject}`, body, replyToId: m.id })
        return { id: d.id, to: d.to, subject: d.subject }
      },
      meetingBriefing: async id => ({ title: (await calendar.get(id))!.title, purpose: 'p', lastThread: '', points: [] }),
    },
    user: () => ({ name: 'Me', email: SELF.email }),
    timeZone: 'UTC',
    dataDir: null,
    maxCalls: 8,
    maxTurns: 20,
  })
  return { agent, mail, calendar, workspace, drafts }
}

describe('agent end to end (scripted model, fake Google)', () => {
  let a: ReturnType<typeof makeAgent>
  beforeEach(() => {
    a = makeAgent()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('lists unread email, opens the second, drafts a reply for approval', async () => {
    const r1 = await a.agent.ask('what is unread', ctx, undefined, quiet)
    expect(r1.card?.kind).toBe('list')
    const items = r1.card?.kind === 'list' ? r1.card.items : []
    expect(items.length).toBeGreaterThan(1)
    expect(items.every(i => i.kind === 'email')).toBe(true)

    const r2 = await a.agent.ask('open the second one', { screen: 'chat' }, undefined, quiet)
    expect(r2.card).toMatchObject({ kind: 'list', items: [{ id: items[1].id, kind: 'email' }] })
    expect((await a.mail.getEmail(items[1].id)).unread).toBe(false)

    const r3 = await a.agent.ask('reply saying Thursday works for me', { screen: 'chat' }, undefined, quiet)
    expect(r3.pending).toMatchObject({ kind: 'draft' })
    expect(r3.card?.kind).toBe('draft')
    expect(a.drafts.pendingDrafts()).toHaveLength(1)
    expect(a.drafts.pendingDrafts()[0].body).toContain('Thursday works for me')
    expect(r3.text).toMatch(/ready|tap/i) // never claims it was sent
  })

  it('prepares an invite and resolves the attendee', async () => {
    const r = await a.agent.ask('lunch with Sam Thursday', ctx, undefined, quiet)
    expect(r.pending?.kind).toBe('invite')
    expect(r.card?.kind === 'invite' && r.card.invite.attendees[0].email).toBe('sam.lee@acme.example')
    expect(a.drafts.pendingInvites()).toHaveLength(1)
  })

  it('finds a sheet, appends a row only after approval, and tells the model', async () => {
    const r1 = await a.agent.ask('find the offsite budget sheet', ctx, undefined, quiet)
    const files = r1.card?.kind === 'list' ? r1.card.items : []
    expect(files.some(f => /Offsite budget/.test(f.title))).toBe(true)

    const before = (await a.workspace.readRange('sheet-offsite')).values.length
    const r2 = await a.agent.ask('add a row: Vineyard, 12000, 1h', { screen: 'chat' }, undefined, quiet)
    expect(r2.pending).toMatchObject({ kind: 'action', label: expect.stringMatching(/Add 1 row/) })
    expect(r2.card).toMatchObject({ kind: 'edit', lines: ['Vineyard | 12000 | 1h'] })
    expect((await a.workspace.readRange('sheet-offsite')).values.length).toBe(before) // nothing changed yet
    expect(a.agent.pendingActions()).toHaveLength(1)

    const done = await a.agent.act(r2.pending!.id, true)
    expect(done.kind).toBe('done')
    expect((await a.workspace.readRange('sheet-offsite')).values.length).toBe(before + 1)
    expect(a.agent.pendingActions()).toHaveLength(0)
    expect(await a.agent.act(r2.pending!.id, true)).toMatchObject({ message: /Already/ })
  })

  it('reads a doc as a text card', async () => {
    await a.agent.ask('find the onboarding doc', ctx, undefined, quiet)
    const r = await a.agent.ask('open the first one', { screen: 'chat' }, undefined, quiet)
    expect(r.card?.kind).toBe('text')
    expect(r.card?.kind === 'text' && r.card.text).toContain('launch plan')
  })

  it('asks which Priya when the name is ambiguous', async () => {
    const r = await a.agent.ask('email Priya that I am running late', ctx, undefined, quiet)
    expect(r.pending).toBeUndefined()
    expect(r.card).toMatchObject({ kind: 'list', title: 'Which "Priya"?' })
  })
})

describe('agent loop guards', () => {
  const END: LlmStep = { text: 'end', calls: [], content: { role: 'model', parts: [{ text: 'end' }] } }
  const stubLlm = (steps: LlmStep[]): LlmPort => {
    const queue = [...steps]
    // With no tools offered (the budget's last call), answer in words like a real model would.
    return { name: 'stub', generate: async (_s, _c, tools) => (tools.length === 0 ? END : (queue.shift() ?? END)) }
  }
  const call = (name: string, args: Record<string, unknown>): LlmStep => ({ text: '', calls: [{ name, args }], content: { role: 'model', parts: [{ functionCall: { name, args } }] } })

  it('rejects ids the model made up and unknown tools, feeding the error back', async () => {
    const seen: unknown[] = []
    const llm: LlmPort = {
      name: 'spy',
      generate: async (_s, contents) => {
        seen.push(contents[contents.length - 1])
        if (seen.length === 1) return call('read_email', { id: 'made-up' })
        if (seen.length === 2) return call('no_such_tool', {})
        return { text: 'ok', calls: [], content: { role: 'model', parts: [{ text: 'ok' }] } }
      },
    }
    const { agent } = makeAgent(llm)
    const r = await agent.ask('hi', ctx, undefined, quiet)
    expect(r.text).toBe('ok')
    const responses = seen.slice(1).map(c => JSON.stringify(c))
    expect(responses[0]).toMatch(/Unknown email id/)
    expect(responses[1]).toMatch(/Unknown tool/)
  })

  it('stops after the tool budget', async () => {
    const llm = stubLlm(Array.from({ length: 12 }, () => call('search_contacts', { name: 'sam' })))
    const tools: AgentTool[] = [{ name: 'search_contacts', description: '', parameters: { type: 'object', properties: {} }, run: async () => ({ forModel: { ok: true } }) }]
    const convo = new Conversation(null, 5)
    const reply = await runTurn(
      { text: 'loop', ctx },
      convo,
      { llm, tools, system: () => '', toolContext: () => ({}) as never, maxCalls: 3 },
      quiet,
    )
    expect(reply.text).toBe('end')
    const budgetNotes = convo.contents.filter(c => JSON.stringify(c).includes('budget'))
    expect(budgetNotes.length).toBeGreaterThan(0)
  })

  it('pending store: once, discard, expiry', async () => {
    const store = new PendingStore(null)
    const a = store.create('t', {}, 'Do it', { kind: 'edit', title: 't', lines: [] })
    const work = vi.fn(async () => {})
    expect((await store.complete(a.id, true, work)).already).toBe(false)
    expect((await store.complete(a.id, true, work)).already).toBe(true)
    expect(work).toHaveBeenCalledTimes(1)
    const b = store.create('t', {}, 'Skip it', { kind: 'edit', title: 't', lines: [] })
    expect((await store.complete(b.id, false, work)).action.status).toBe('discarded')
    expect(store.list()).toHaveLength(0)
  })
})
