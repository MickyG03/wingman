import { MIME } from '../../google/ports.ts'
import { str, ToolError, type AgentTool } from '../types.ts'
import { requireFile } from './drive.ts'

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 3).trimEnd()}...` : s)

export const docsTools: AgentTool[] = [
  {
    name: 'append_text',
    description: 'Prepare adding text to the end of a Google Doc for approval.',
    parameters: { type: 'object', properties: { docId: { type: 'string' }, text: { type: 'string' } }, required: ['docId', 'text'] },
    async prepare(args, ctx) {
      const f = await requireFile(ctx, str(args.docId))
      if (f.mimeType !== MIME.doc) throw new ToolError('That file is not a Google Doc')
      const text = str(args.text)
      if (!text) throw new ToolError('text is required')
      const a = ctx.pending.create('append_text', { docId: f.id, text }, `Add to "${f.name}"`, { kind: 'edit', title: `Append to ${f.name}`, lines: clip(text, 400).split('\n') })
      return { forModel: { status: 'awaiting_approval', actionId: a.id }, card: a.preview, pending: { id: a.id, kind: 'action', label: a.label } }
    },
    async run(args, ctx) {
      await ctx.docs.appendText(str(args.docId), str(args.text))
      return { forModel: { appended: true } }
    },
  },
  {
    name: 'replace_text',
    description: 'Prepare replacing every occurrence of a phrase in a Google Doc for approval.',
    parameters: { type: 'object', properties: { docId: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' } }, required: ['docId', 'find', 'replace'] },
    async prepare(args, ctx) {
      const f = await requireFile(ctx, str(args.docId))
      if (f.mimeType !== MIME.doc) throw new ToolError('That file is not a Google Doc')
      const find = str(args.find)
      if (!find) throw new ToolError('find is required')
      const a = ctx.pending.create('replace_text', { docId: f.id, find, replace: str(args.replace) }, `Edit "${f.name}"`, {
        kind: 'edit',
        title: `Edit ${f.name}`,
        lines: [`Replace: ${clip(find, 80)}`, `With: ${clip(str(args.replace), 80) || '(nothing)'}`],
      })
      return { forModel: { status: 'awaiting_approval', actionId: a.id }, card: a.preview, pending: { id: a.id, kind: 'action', label: a.label } }
    },
    async run(args, ctx) {
      const n = await ctx.docs.replaceText(str(args.docId), str(args.find), str(args.replace))
      return { forModel: { replaced: n } }
    },
  },
]
