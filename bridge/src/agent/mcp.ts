// Optional: Google's hosted Workspace MCP servers (Developer Preview). Their
// tools are added next to the built-in ones; anything that fails is skipped.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { GoogleAuth } from '../google/auth.ts'
import { ToolError, type AgentTool, type JsonSchema } from './types.ts'

const SERVERS = {
  drive: 'https://drivemcp.googleapis.com/mcp/v1',
  docs: 'https://docsmcp.googleapis.com/mcp/v1',
  sheets: 'https://sheetsmcp.googleapis.com/mcp/v1',
} as const

const READ_ONLY = /^(get|list|search|read|fetch|find|download)/i

function textOf(result: unknown): unknown {
  const r = result as { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean }
  if (r?.structuredContent) return r.structuredContent
  const text = (r?.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n')
  try {
    return JSON.parse(text)
  } catch {
    return { text: text.slice(0, 2000) }
  }
}

export async function attachWorkspaceMcp(auth: GoogleAuth): Promise<AgentTool[]> {
  const tools: AgentTool[] = []
  for (const [product, url] of Object.entries(SERVERS)) {
    try {
      const client = new Client({ name: 'wingman', version: '0.3.0' })
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        // Each request fetches a fresh access token so refreshes are transparent.
        fetch: async (input, init) => {
          const token = (await auth.client.getAccessToken()).token
          const headers = new Headers(init?.headers)
          headers.set('Authorization', `Bearer ${token}`)
          return fetch(input, { ...init, headers })
        },
      })
      await client.connect(transport)
      const { tools: remote } = await client.listTools()
      for (const t of remote) {
        const name = `mcp_${product}_${t.name}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 60)
        const mutation = !READ_ONLY.test(t.name)
        const call = async (args: Record<string, unknown>) => textOf(await client.callTool({ name: t.name, arguments: args }))
        tools.push({
          name,
          description: `[Google ${product} MCP] ${t.description ?? t.name}`.slice(0, 500),
          parameters: (t.inputSchema as JsonSchema) ?? { type: 'object', properties: {} },
          progress: `${product}: ${t.name}...`,
          ...(mutation
            ? {
                async prepare(args, ctx) {
                  const a = ctx.pending.create(name, args, `${product}: ${t.name}`, {
                    kind: 'edit',
                    title: `${product} ${t.name}`,
                    lines: Object.entries(args).map(([k, v]) => `${k}: ${String(JSON.stringify(v)).slice(0, 60)}`).slice(0, 6),
                  })
                  return { forModel: { status: 'awaiting_approval', actionId: a.id }, card: a.preview, pending: { id: a.id, kind: 'action', label: a.label } }
                },
              }
            : {}),
          async run(args) {
            const out = await call(args)
            if ((out as { isError?: boolean })?.isError) throw new ToolError(JSON.stringify(out).slice(0, 200))
            return { forModel: out }
          },
        })
      }
      console.log(`[mcp] ${product}: ${remote.length} tool(s) attached`)
    } catch (err) {
      console.warn(`[mcp] ${product} unavailable (${(err as Error).message.slice(0, 120)}); using built-in tools`)
    }
  }
  return tools
}
