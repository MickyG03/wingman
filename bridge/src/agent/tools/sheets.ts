import { MIME } from '../../google/ports.ts'
import { table } from '../summarize.ts'
import { str, ToolError, type AgentTool, type ToolContext } from '../types.ts'
import { requireFile } from './drive.ts'

function rows(v: unknown): string[][] {
  if (!Array.isArray(v)) return []
  return v.map(r => (Array.isArray(r) ? r.map(c => (c === null || c === undefined ? '' : String(c))) : [String(r)]))
}

async function requireSheet(ctx: ToolContext, id: string) {
  const f = await requireFile(ctx, id)
  if (f.mimeType !== MIME.sheet) throw new ToolError('That file is not a Google Sheet')
  return f
}

export const sheetsTools: AgentTool[] = [
  {
    name: 'read_range',
    description: 'Read cells from a Google Sheet. Also lists the sheet tabs.',
    parameters: { type: 'object', properties: { sheetId: { type: 'string' }, range: { type: 'string', description: 'A1 notation, e.g. "Totals!A1:B10"' } }, required: ['sheetId'] },
    progress: 'Reading sheet...',
    async run(args, ctx) {
      const f = await requireSheet(ctx, str(args.sheetId))
      const info = await ctx.sheets.info(f.id)
      const { range, values } = await ctx.sheets.readRange(f.id, str(args.range) || undefined)
      const shown = table(values)
      return {
        forModel: { id: f.id, name: f.name, tabs: info.sheets, range, rows: shown, totalRows: values.length },
        card: { kind: 'text', title: `${f.name} (${range.split('!')[0]})`, text: shown.map(r => r.join(' | ')).join('\n') || '(empty)' },
      }
    },
  },
  {
    name: 'append_rows',
    description: 'Prepare adding rows to the end of a sheet for approval. Each row is an array of cell values in column order.',
    parameters: {
      type: 'object',
      properties: {
        sheetId: { type: 'string' },
        sheet: { type: 'string', description: 'Tab name (default: first tab)' },
        rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
      },
      required: ['sheetId', 'rows'],
    },
    async prepare(args, ctx) {
      const f = await requireSheet(ctx, str(args.sheetId))
      const data = rows(args.rows)
      if (!data.length) throw new ToolError('rows is required')
      const tab = str(args.sheet) || undefined
      const a = ctx.pending.create('append_rows', { sheetId: f.id, sheet: tab, rows: data }, `Add ${data.length} row${data.length > 1 ? 's' : ''} to "${f.name}"`, {
        kind: 'edit',
        title: `Add to ${f.name}${tab ? ` / ${tab}` : ''}`,
        lines: data.slice(0, 6).map(r => r.join(' | ')),
      })
      return { forModel: { status: 'awaiting_approval', actionId: a.id, rows: data.length }, card: a.preview, pending: { id: a.id, kind: 'action', label: a.label } }
    },
    async run(args, ctx) {
      const r = await ctx.sheets.appendRows(str(args.sheetId), str(args.sheet) || undefined, rows(args.rows))
      return { forModel: { appended: rows(args.rows).length, range: r.range } }
    },
  },
  {
    name: 'update_range',
    description: 'Prepare overwriting cells in a sheet for approval. Use read_range first to know the layout.',
    parameters: {
      type: 'object',
      properties: {
        sheetId: { type: 'string' },
        range: { type: 'string', description: 'A1 notation of the top-left cell or full range' },
        values: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
      },
      required: ['sheetId', 'range', 'values'],
    },
    async prepare(args, ctx) {
      const f = await requireSheet(ctx, str(args.sheetId))
      const data = rows(args.values)
      const range = str(args.range)
      if (!data.length || !range) throw new ToolError('range and values are required')
      const a = ctx.pending.create('update_range', { sheetId: f.id, range, values: data }, `Update ${range} in "${f.name}"`, {
        kind: 'edit',
        title: `Update ${f.name}`,
        lines: [`Cells: ${range}`, ...data.slice(0, 5).map(r => r.join(' | '))],
      })
      return { forModel: { status: 'awaiting_approval', actionId: a.id }, card: a.preview, pending: { id: a.id, kind: 'action', label: a.label } }
    },
    async run(args, ctx) {
      const r = await ctx.sheets.updateRange(str(args.sheetId), str(args.range), rows(args.values))
      return { forModel: { updated: r.range } }
    },
  },
]
