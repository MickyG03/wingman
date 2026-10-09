// The model behind the agent loop. Gemini with automatic function calling
// disabled, so every tool call passes through our approval logic.

import { FunctionCallingConfigMode, GoogleGenAI, type Content, type FunctionCall, type FunctionDeclaration } from '@google/genai'
import { isOverloaded } from '../ai/gemini.ts'
import { AiError } from '../ai/types.ts'

export interface LlmStep {
  text: string
  calls: FunctionCall[]
  /** The model turn to append to history (contains the function calls). */
  content: Content
}

export interface LlmPort {
  readonly name: string
  generate(system: string, contents: Content[], tools: FunctionDeclaration[]): Promise<LlmStep>
}

const TIMEOUT_MS = 20_000

export class GeminiLlm implements LlmPort {
  readonly name: string
  private readonly client: GoogleGenAI

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly fallbackModel: string,
  ) {
    this.client = new GoogleGenAI({ apiKey })
    this.name = `gemini agent (${model}, fallback ${fallbackModel})`
  }

  private async call(model: string, system: string, contents: Content[], tools: FunctionDeclaration[]): Promise<LlmStep> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const res = await this.client.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: system,
          tools: [{ functionDeclarations: tools }],
          toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
          automaticFunctionCalling: { disable: true },
          temperature: 0.3,
          abortSignal: ctrl.signal,
        },
      })
      const content = res.candidates?.[0]?.content ?? { role: 'model', parts: [{ text: res.text ?? '' }] }
      return { text: res.text ?? '', calls: res.functionCalls ?? [], content }
    } catch (err) {
      if (ctrl.signal.aborted) throw new Error(`timeout after ${TIMEOUT_MS / 1000}s`)
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  async generate(system: string, contents: Content[], tools: FunctionDeclaration[]): Promise<LlmStep> {
    const started = Date.now()
    try {
      const step = await this.call(this.model, system, contents, tools)
      console.log(`[agent] model ${Date.now() - started}ms ${step.calls.length ? `-> ${step.calls.map(c => c.name).join(', ')}` : '-> reply'}`)
      return step
    } catch (err) {
      const msg = (err as Error).message ?? String(err)
      const retry = isOverloaded(err) || /timeout/.test(msg)
      console.warn(`[agent] ${this.model} failed: ${msg.slice(0, 160)}${retry ? ` -> trying ${this.fallbackModel}` : ''}`)
      if (!retry || this.fallbackModel === this.model) throw new AiError(msg)
      try {
        const step = await this.call(this.fallbackModel, system, contents, tools)
        console.log(`[agent] model (${this.fallbackModel}) ${Date.now() - started}ms`)
        return step
      } catch (err2) {
        throw new AiError((err2 as Error).message ?? String(err2))
      }
    }
  }
}

// ── Scripted stand-in for the simulator ─────────────────────────────────

type Step = { call: string; args: Record<string, unknown> } | { text: string }
interface Script {
  match: RegExp
  steps: (say: string, shown: { kind: string; id: string; title: string }[], pick?: { kind: string; id: string }) => Step[]
}

const ORDINALS: Record<string, number> = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4, last: -1 }

function nth(say: string, shown: { id: string }[]): string | undefined {
  const m = /\b(first|second|third|fourth|fifth|last|\d)\b/i.exec(say)
  if (!m || shown.length === 0) return undefined
  const word = m[1].toLowerCase()
  const i = word in ORDINALS ? (ORDINALS[word] < 0 ? shown.length - 1 : ORDINALS[word]) : Number(word) - 1
  return shown[i]?.id
}

const SCRIPTS: Script[] = [
  {
    match: /^(e-?mail|tell|write to|message)\s+(\w+)/i,
    steps: say => {
      const m = /^(?:e-?mail|tell|write to|message)\s+([\w.@-]+)\s*(?:that|saying|about)?\s*(.*)$/i.exec(say)!
      const body = m[2] || 'Quick note.'
      return [
        { call: 'draft_email', args: { to: [m[1]], subject: body.slice(0, 50), body: `Hi ${m[1]},\n\n${body[0].toUpperCase()}${body.slice(1)}.\n\nBest,\nMe` } },
        { text: `Email to ${m[1]} is ready. Tap to review and send.` },
      ]
    },
  },
  {
    match: /unread|inbox|new (e-?)?mails?\b|my (e-?)?mails?\b|any (e-?)?mails?\b/i,
    steps: () => [{ call: 'search_emails', args: { unreadOnly: true, max: 10 } }, { text: 'Here are your unread emails. Tap one to open it.' }],
  },
  {
    match: /^(open|read|show)\b/i,
    steps: (say, shown, pick) => {
      const id = pick?.id ?? nth(say, shown) ?? shown[0]?.id
      const item = shown.find(s => s.id === id)
      if (!id) return [{ text: 'Nothing is shown yet. Ask for your inbox or a file first.' }]
      if (item?.kind === 'file') return [{ call: 'read_file', args: { fileId: id } }, { text: 'Here is the file. Swipe to read.' }]
      if (item?.kind === 'event') return [{ call: 'show_meeting', args: { eventId: id } }, { text: 'Here is the meeting.' }]
      return [{ call: 'read_email', args: { id } }, { text: 'Opened it. Tap to read the full email or reply.' }]
    },
  },
  {
    match: /reply/i,
    steps: (say, shown, pick) => {
      const id = pick?.id ?? shown.find(s => s.kind === 'email')?.id
      if (!id) return [{ text: 'Which email? Open your inbox first.' }]
      const what = say.replace(/^.*?(saying|that|with)\s+/i, '').trim() || 'Sounds good, thanks!'
      return [
        { call: 'draft_reply', args: { emailId: id, body: `Hi,\n\n${what[0].toUpperCase()}${what.slice(1)}${/[.!?]$/.test(what) ? '' : '.'}\n\nBest,\nMe` } },
        { text: 'Reply is ready. Tap to review and send.' },
      ]
    },
  },
  {
    match: /lunch|coffee|dinner|schedule|meeting with|invite|call with/i,
    steps: say => {
      const who = /\bwith\s+([A-Za-z]+)/i.exec(say)?.[1]
      const d = new Date()
      d.setDate(d.getDate() + 2)
      d.setHours(13, 0, 0, 0)
      return [
        { call: 'create_event', args: { title: `${/lunch|coffee|dinner/i.exec(say)?.[0] ?? 'Meeting'}${who ? ` with ${who}` : ''}`, startISO: d.toISOString(), durationMin: 60, attendees: who ? [who] : [] } },
        { text: 'Invite is ready. Tap to review and send it.' },
      ]
    },
  },
  {
    match: /free|available|when can/i,
    steps: () => [{ call: 'find_free_time', args: { dateISO: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), durationMin: 30 } }, { text: 'You are free at these times tomorrow.' }],
  },
  {
    match: /calendar|meetings|today|tomorrow|this week|agenda/i,
    steps: () => [{ call: 'list_events', args: { days: 3 } }, { text: 'Here is your schedule for the next few days.' }],
  },
  {
    match: /add (a )?(row|line)|append|put .* in the sheet/i,
    steps: (say, shown) => {
      const sheet = shown.find(s => s.kind === 'file' && /sheet|budget/i.test(s.title))
      if (!sheet) return [{ text: 'Which spreadsheet? Find it first, e.g. "find the offsite budget".' }]
      const cells = (say.split(/:\s*/)[1] ?? 'New item, 0').split(/,\s*/)
      return [{ call: 'append_rows', args: { sheetId: sheet.id, rows: [cells] } }, { text: 'Row is ready to add. Tap to approve.' }]
    },
  },
  {
    match: /find|search|look for|file|sheet|doc\b|document|drive/i,
    steps: say => {
      const q = say.replace(/^(find|search for|search|look for|open)\s+(the\s+)?/i, '').replace(/\b(sheet|doc|document|file|spreadsheet|in drive)\b/gi, '').trim()
      return [{ call: 'search_files', args: { query: q || 'budget', max: 5 } }, { text: 'Here is what I found in Drive. Tap one to open it.' }]
    },
  },
  {
    match: /who is|contact|number for|email for/i,
    steps: say => [{ call: 'search_contacts', args: { name: say.replace(/^.*?(who is|contact|for)\s+/i, '').replace(/\?$/, '') } }, { text: 'Here is what I have.' }],
  },
]

/** Pattern-matched stand-in so every flow can be demoed without a Gemini key. */
export class ScriptedLlm implements LlmPort {
  readonly name = 'scripted (set GEMINI_API_KEY for the real agent)'
  private queue: Step[] = []

  async generate(_system: string, contents: Content[]): Promise<LlmStep> {
    const last = contents[contents.length - 1]
    const lastText = String(last?.parts?.find(p => p.text)?.text ?? '')
    const isUserTurn = last?.role === 'user' && /User says: "/.test(lastText)
    // React to what the tools said, the way a real model would.
    for (const p of last?.parts ?? []) {
      const r = p.functionResponse?.response as { needsChoice?: string; error?: string } | undefined
      if (r?.needsChoice) {
        this.queue = []
        return this.reply(`I know more than one ${r.needsChoice}. Tap the right one.`)
      }
      if (r?.error) {
        this.queue = []
        return this.reply(r.error)
      }
    }
    if (isUserTurn) {
      const say = /User says: "([\s\S]*)"$/.exec(lastText)?.[1] ?? lastText
      const shown = [...lastText.matchAll(/\d+\. \[(\w+) ([^\]\s]+)\] ([^\n]+)/g)].map(m => ({ kind: m[1], id: m[2], title: m[3] }))
      const pm = /The user selected: \[(\w+) ([^\]\s]+)\]/.exec(lastText)
      const pick = pm ? { kind: pm[1], id: pm[2] } : undefined
      const script = SCRIPTS.find(s => s.match.test(say))
      this.queue = script ? script.steps(say, shown, pick) : [{ text: 'Try: "what is unread", "find the offsite budget", "lunch with Sam Thursday".' }]
    }
    const step = this.queue.shift() ?? { text: 'Done.' }
    await new Promise(r => setTimeout(r, 400))
    if ('call' in step) {
      const call: FunctionCall = { name: step.call, args: step.args }
      return { text: '', calls: [call], content: { role: 'model', parts: [{ functionCall: call }] } }
    }
    return this.reply(step.text)
  }

  private reply(text: string): LlmStep {
    return { text, calls: [], content: { role: 'model', parts: [{ text }] } }
  }
}
