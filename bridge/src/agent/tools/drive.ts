import type { CardItem } from '../../../../shared/protocol.ts'
import { MIME, type DriveFile } from '../../google/ports.ts'
import { BODY_MAX, fileRow, LIST_MAX, table } from '../summarize.ts'
import { num, str, ToolError, type AgentTool, type ToolContext } from '../types.ts'

const KINDS: Record<string, string | undefined> = { doc: MIME.doc, sheet: MIME.sheet, any: undefined }

export function fileItem(f: DriveFile): CardItem {
  const kind = f.mimeType === MIME.doc ? 'Doc' : f.mimeType === MIME.sheet ? 'Sheet' : f.mimeType.split('/').pop()?.toUpperCase() ?? 'File'
  return { id: f.id, kind: 'file', title: f.name, detail: `${kind} - ${f.owner ?? ''} ${f.modifiedAt.slice(0, 10)}`.trim() }
}

export async function requireFile(ctx: ToolContext, id: string): Promise<DriveFile> {
  if (!ctx.known(id)) throw new ToolError('Unknown file id. Search Drive first.')
  const f = await ctx.drive.get(id)
  if (!f) throw new ToolError('File not found')
  return f
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 3).trimEnd()}...` : s)

export const driveTools: AgentTool[] = [
  {
    name: 'search_files',
    description: 'Search Google Drive by name or content. Returns files with ids. Use kind to limit to docs or sheets. Empty query = recently opened files.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        kind: { type: 'string', enum: ['doc', 'sheet', 'any'] },
        max: { type: 'integer' },
      },
    },
    progress: 'Searching Drive...',
    async run(args, ctx) {
      const max = Math.min(LIST_MAX, Math.max(1, num(args.max, 8)))
      const query = str(args.query)
      const files = query ? await ctx.drive.search(query, KINDS[str(args.kind, 'any')], max) : await ctx.drive.recent(max)
      return {
        forModel: { count: files.length, files: files.map(fileRow) },
        card: { kind: 'list', title: files.length ? (query ? `Drive: ${query}` : 'Recent files') : 'No files found', items: files.map(fileItem) },
      }
    },
  },
  {
    name: 'read_file',
    description: 'Read a file: a Doc as text, a Sheet as rows (first sheet unless a range is given), other files as plain text when possible.',
    parameters: { type: 'object', properties: { fileId: { type: 'string' }, range: { type: 'string', description: 'Sheets only, e.g. "Budget!A1:D20"' } }, required: ['fileId'] },
    progress: 'Opening file...',
    async run(args, ctx) {
      const f = await requireFile(ctx, str(args.fileId))
      if (f.mimeType === MIME.sheet) {
        const { range, values } = await ctx.sheets.readRange(f.id, str(args.range) || undefined)
        const rows = table(values)
        const text = rows.map(r => r.join(' | ')).join('\n') || '(empty)'
        return {
          forModel: { id: f.id, name: f.name, kind: 'sheet', range, rows, totalRows: values.length },
          card: { kind: 'text', title: f.name, text },
        }
      }
      const text = f.mimeType === MIME.doc ? (await ctx.docs.readText(f.id)).text : await ctx.drive.exportText(f.id)
      return {
        forModel: { id: f.id, name: f.name, kind: f.mimeType === MIME.doc ? 'doc' : 'file', text: clip(text, BODY_MAX), totalChars: text.length },
        card: { kind: 'text', title: f.name, text: clip(text, 4000) },
      }
    },
  },
  {
    name: 'create_file',
    description: 'Prepare creating a new Google Doc or Sheet in Drive for approval.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        kind: { type: 'string', enum: ['doc', 'sheet'] },
        content: { type: 'string', description: 'Doc text' },
        rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'Sheet rows' },
      },
      required: ['name', 'kind'],
    },
    async prepare(args, ctx) {
      const name = str(args.name)
      if (!name) throw new ToolError('name is required')
      const kind = str(args.kind) === 'sheet' ? 'sheet' : 'doc'
      const preview = kind === 'doc' ? clip(str(args.content), 200) : `${(args.rows as string[][] | undefined)?.length ?? 0} row(s)`
      const a = ctx.pending.create('create_file', { name, kind, content: str(args.content), rows: args.rows ?? [] }, `Create ${kind} "${name}"`, {
        kind: 'edit',
        title: `New ${kind === 'doc' ? 'Doc' : 'Sheet'}`,
        lines: [name, preview],
      })
      return { forModel: { status: 'awaiting_approval', actionId: a.id }, card: a.preview, pending: { id: a.id, kind: 'action', label: a.label } }
    },
    async run(args, ctx) {
      const f =
        str(args.kind) === 'sheet'
          ? await ctx.drive.createSheet(str(args.name), (args.rows as string[][]) ?? [])
          : await ctx.drive.createDoc(str(args.name), str(args.content))
      return { forModel: fileRow(f) }
    },
  },
]
