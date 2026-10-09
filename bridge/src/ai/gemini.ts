import { GoogleGenAI, ThinkingLevel } from '@google/genai'
import type { Meeting } from '../../../shared/protocol.ts'
import type { RawEmail } from '../google/ports.ts'
import * as P from './prompts.ts'
import { AiError, type Ai, type DraftText, type TriageInput, type UserContext } from './types.ts'
import { validateBriefing, validateEmailText, validateIntent, validateTriage } from './validate.ts'

const TIMEOUT_MS = 25_000

export class GeminiAi implements Ai {
  readonly name: string
  private readonly client: GoogleGenAI
  // Low thinking keeps latency down; dropped automatically if a model rejects it.
  private thinking = true

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly user: () => UserContext,
    private readonly timeZone: string,
  ) {
    this.client = new GoogleGenAI({ apiKey })
    this.name = `gemini (${model})`
  }

  private async generateJson(prompt: string, schema: object, label: string): Promise<unknown> {
    let lastErr: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
      const started = Date.now()
      try {
        const res = await this.client.models.generateContent({
          model: this.model,
          contents: prompt,
          config: {
            systemInstruction: P.systemPrompt(this.user(), this.timeZone),
            responseMimeType: 'application/json',
            responseJsonSchema: schema,
            temperature: 0.3,
            abortSignal: ctrl.signal,
            ...(this.thinking ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {}),
          },
        })
        const text = res.text
        if (!text) throw new Error('empty response')
        console.log(`[ai] ${label} ok in ${Date.now() - started}ms`)
        return JSON.parse(text)
      } catch (err) {
        lastErr = err
        const msg = (err as Error).message ?? String(err)
        if (this.thinking && /thinking/i.test(msg)) {
          console.warn('[ai] model rejected thinkingConfig; retrying without it')
          this.thinking = false
          attempt--
          continue
        }
        console.warn(`[ai] ${label} attempt ${attempt + 1} failed: ${ctrl.signal.aborted ? 'timeout' : msg}`)
      } finally {
        clearTimeout(timer)
      }
    }
    throw new AiError(`Gemini ${label} failed: ${(lastErr as Error)?.message ?? lastErr}`)
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
