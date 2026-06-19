import type { AgentTool } from '../types.ts'
import { calendarTools } from './calendar.ts'
import { contactTools } from './contacts.ts'
import { docsTools } from './docs.ts'
import { driveTools } from './drive.ts'
import { emailTools } from './email.ts'
import { sheetsTools } from './sheets.ts'
import { uiTools } from './ui.ts'

/** Every built-in tool, with names checked for uniqueness. */
export function builtinTools(): AgentTool[] {
  const all = [...emailTools, ...calendarTools, ...contactTools, ...driveTools, ...docsTools, ...sheetsTools, ...uiTools]
  const seen = new Set<string>()
  for (const t of all) {
    if (seen.has(t.name)) throw new Error(`duplicate tool name: ${t.name}`)
    seen.add(t.name)
  }
  return all
}
