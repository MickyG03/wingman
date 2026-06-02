import { drive, type drive_v3 } from '@googleapis/drive'
import type { GoogleAuth } from './auth.ts'
import { MIME, type DriveFile, type DrivePort } from './ports.ts'

const FIELDS = 'id,name,mimeType,modifiedTime,owners(displayName),webViewLink'

function toFile(f: drive_v3.Schema$File): DriveFile {
  return {
    id: f.id ?? '',
    name: f.name ?? '(untitled)',
    mimeType: f.mimeType ?? '',
    modifiedAt: f.modifiedTime ?? '',
    owner: f.owners?.[0]?.displayName ?? undefined,
    webUrl: f.webViewLink ?? undefined,
  }
}

/** Drive's query language needs quotes escaped inside string literals. */
const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

export class GoogleDrive implements DrivePort {
  private readonly api: drive_v3.Drive

  constructor(private readonly auth: GoogleAuth) {
    this.api = drive({ version: 'v3', auth: auth.client as never })
  }

  async search(query: string, mimeType: string | undefined, max: number) {
    return this.auth.call(async () => {
      const parts = ['trashed = false']
      const words = query.trim()
      // Name match first (what people usually mean), then full-text as a fallback.
      if (words) parts.push(`(name contains '${q(words)}' or fullText contains '${q(words)}')`)
      if (mimeType) parts.push(`mimeType = '${q(mimeType)}'`)
      const res = await this.api.files.list({
        q: parts.join(' and '),
        pageSize: max,
        orderBy: words ? undefined : 'modifiedTime desc',
        fields: `files(${FIELDS})`,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      })
      return (res.data.files ?? []).map(toFile)
    })
  }

  async recent(max: number) {
    return this.auth.call(async () => {
      const res = await this.api.files.list({
        q: `trashed = false and mimeType != '${MIME.folder}'`,
        pageSize: max,
        orderBy: 'viewedByMeTime desc',
        fields: `files(${FIELDS})`,
      })
      return (res.data.files ?? []).map(toFile)
    })
  }

  async get(id: string) {
    return this.auth.call(async () => {
      try {
        return toFile((await this.api.files.get({ fileId: id, fields: FIELDS, supportsAllDrives: true })).data)
      } catch (err) {
        if ((err as { code?: number }).code === 404) return null
        throw err
      }
    })
  }

  async exportText(id: string) {
    return this.auth.call(async () => {
      const file = await this.get(id)
      if (!file) throw new Error('File not found')
      if (file.mimeType.startsWith('application/vnd.google-apps.')) {
        const res = await this.api.files.export({ fileId: id, mimeType: 'text/plain' }, { responseType: 'text' })
        return String(res.data ?? '')
      }
      if (file.mimeType.startsWith('text/') || file.mimeType === 'application/json') {
        const res = await this.api.files.get({ fileId: id, alt: 'media' }, { responseType: 'text' })
        return String(res.data ?? '')
      }
      return `(${file.mimeType} file; no text preview available)`
    })
  }

  async createDoc(name: string, content: string) {
    return this.auth.call(async () => {
      const res = await this.api.files.create({ requestBody: { name, mimeType: MIME.doc }, fields: FIELDS })
      const file = toFile(res.data)
      if (content) {
        const { docs } = await import('@googleapis/docs')
        await docs({ version: 'v1', auth: this.auth.client as never }).documents.batchUpdate({
          documentId: file.id,
          requestBody: { requests: [{ insertText: { endOfSegmentLocation: {}, text: content } }] },
        })
      }
      return file
    })
  }

  async createSheet(name: string, rows: string[][]) {
    return this.auth.call(async () => {
      const res = await this.api.files.create({ requestBody: { name, mimeType: MIME.sheet }, fields: FIELDS })
      const file = toFile(res.data)
      if (rows.length) {
        const { sheets } = await import('@googleapis/sheets')
        await sheets({ version: 'v4', auth: this.auth.client as never }).spreadsheets.values.update({
          spreadsheetId: file.id,
          range: 'A1',
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: rows },
        })
      }
      return file
    })
  }
}
