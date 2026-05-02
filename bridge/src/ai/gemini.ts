import { GoogleGenAI } from '@google/genai'
import type { Meeting, VoiceExchange } from '../../../shared/protocol.ts'
import type { RawEmail } from '../google/ports.ts'
import * as P from './prompts.ts'
import { AiError, type Ai, type DraftText, type TriageInput, type UserContext } from './types.ts'
import { validateBriefing, validateEmailText, validateIntent, validateRedo, validateTriage } from './validate.ts'

// Someone is waiting on the glasses: fail over to the fallback model rather
// than retrying a slow or overloaded one.
const TIMEOUT_MS = 15_000

export function isOverloaded(err: unknown): boolean {
  const msg = (err as Error)?.message ?? ''
  return /503|UNAVAILABLE|high demand|overloaded|429|RESOURCE_EXHAUSTED/i.test(msg)
}

export class GeminiAi implements Ai {
  readonly name: string
  private readonly client: GoogleGenAI

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly fallbackModel: string,
    private readonly user: () => UserContext,
    private readonly timeZone: string,
  ) {
    this.client = new GoogleGenAI({ apiKey })
    this.name = `gemini (${model}, fallback ${fallbackModel})`
  }

  private async callModel(model: string, prompt: string, schema: object): Promise<unknown> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const res = await this.client.models.generateContent({
        model,
        contents: prompt,
        config: {
          systemInstruction: P.systemPrompt(this.user(), this.timeZone),
          responseMimeType: 'application/json',
          responseJsonSchema: schema,
          temperature: 0.3,
          abortSignal: ctrl.signal,
        },
      })
      const text = res.text
      if (!text) throw new Error('empty response')
      return JSON.parse(text)
    } catch (err) {
      if (ctrl.signal.aborted) throw new Error(`timeout after ${TIMEOUT_MS / 1000}s`)
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  /** Main model once; on timeout or overload, the fallback model once. */
  private async generateJson(prompt: string, schema: object, label: string): Promise<unknown> {
    const started = Date.now()
    try {
      const out = await this.callModel(this.model, prompt, schema)
      console.log(`[ai] ${label} ok in ${Date.now() - started}ms`)
      return out
    } catch (err) {
      const msg = (err as Error).message ?? String(err)
      const retry = isOverloaded(err) || /timeout/.test(msg)
      console.warn(`[ai] ${label} on ${this.model} failed: ${msg.slice(0, 160)}${retry ? ` -> trying ${this.fallbackModel}` : ''}`)
      if (!retry || this.fallbackModel === this.model) throw new AiError(`Gemini ${label} failed: ${msg}`)
      try {
        const out = await this.callModel(this.fallbackModel, prompt, schema)
        console.log(`[ai] ${label} ok on ${this.fallbackModel} in ${Date.now() - started}ms`)
        return out
      } catch (err2) {
        const msg2 = (err2 as Error).message ?? String(err2)
        console.warn(`[ai] ${label} on ${this.fallbackModel} failed: ${msg2.slice(0, 160)}`)
        throw new AiError(`Gemini ${label} failed: ${msg2}`)
      }
    }
  }

  async triage(items: TriageInput[]) {
    if (items.length === 0) return []
    const out = await this.generateJson(P.triagePrompt(items), P.schemas.triage, `triage(${items.length})`)
    return validateTriage(out, items.map(i => i.id))
  }

  async briefing(meeting: Meeting, related: RawEmail[]) {
    return validateBriefing(await this.generateJson(P.briefingPrompt(meeting, related), P.schemas.briefing, 'briefing'))
  }

  async homeIntent(transcript: string, contactNames: string[]) {
    return validateIntent(await this.generateJson(P.intentPrompt(transcript, contactNames), P.schemas.intent, 'intent'))
  }

  async reply(thread: RawEmail[], instruction: string) {
    return validateEmailText(await this.generateJson(P.replyPrompt(thread, instruction), P.schemas.email, 'reply'))
  }

  async followup(meeting: Meeting, notes: string) {
    return validateEmailText(await this.generateJson(P.followupPrompt(meeting, notes), P.schemas.email, 'followup'))
  }

  async redo(draft: DraftText, instruction: string) {
    return validateEmailText(await this.generateJson(P.redoPrompt(draft, instruction), P.schemas.email, 'redo'))
  }
}
