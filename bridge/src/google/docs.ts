import { docs, type docs_v1 } from '@googleapis/docs'
import type { GoogleAuth } from './auth.ts'
import type { DocsPort } from './ports.ts'

/** Walks the document body and returns its text, one paragraph per line. */
export function flattenDoc(doc: docs_v1.Schema$Document): string {
  const lines: string[] = []
  const walk = (elements: docs_v1.Schema$StructuralElement[] | undefined) => {
    for (const el of elements ?? []) {
      if (el.paragraph) {
        const text = (el.paragraph.elements ?? []).map(e => e.textRun?.content ?? '').join('')
        const bullet = el.paragraph.bullet ? '- ' : ''
        lines.push(bullet + text.replace(/\n$/, ''))
      } else if (el.table) {
        for (const row of el.table.tableRows ?? []) {
          const cells = (row.tableCells ?? []).map(c => {
            const inner: string[] = []
            for (const ce of c.content ?? []) inner.push((ce.paragraph?.elements ?? []).map(e => e.textRun?.content ?? '').join('').trim())
            return inner.join(' ')
          })
          lines.push(cells.join(' | '))
        }
      } else if (el.tableOfContents) {
        walk(el.tableOfContents.content)
      }
    }
  }
  walk(doc.body?.content)
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export class GoogleDocs implements DocsPort {
  private readonly api: docs_v1.Docs

  constructor(private readonly auth: GoogleAuth) {
    this.api = docs({ version: 'v1', auth: auth.client as never })
  }

  async readText(docId: string) {
    return this.auth.call(async () => {
      const res = await this.api.documents.get({ documentId: docId })
      return { title: res.data.title ?? '(untitled)', text: flattenDoc(res.data) }
    })
  }

  async appendText(docId: string, text: string) {
    await this.auth.call(() =>
      this.api.documents.batchUpdate({
        documentId: docId,
        requestBody: { requests: [{ insertText: { endOfSegmentLocation: {}, text: `\n${text}` } }] },
      }),
    )
  }

  async replaceText(docId: string, find: string, replace: string) {
    return this.auth.call(async () => {
      const res = await this.api.documents.batchUpdate({
        documentId: docId,
        requestBody: { requests: [{ replaceAllText: { containsText: { text: find, matchCase: false }, replaceText: replace } }] },
      })
      return res.data.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0
    })
  }
}
