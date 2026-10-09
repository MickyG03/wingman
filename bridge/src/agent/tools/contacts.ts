import type { Person } from '../../../../shared/protocol.ts'
import { str, type AgentTool } from '../types.ts'

export const contactTools: AgentTool[] = [
  {
    name: 'search_contacts',
    description: 'Find people the user knows by name (or part of one). Returns names and email addresses.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    progress: 'Looking up contacts...',
    async run(args, ctx) {
      const name = str(args.name)
      const m = ctx.contacts.match(name)
      const people: Person[] = m.kind === 'one' ? [m.person] : m.kind === 'many' ? m.candidates : []
      return {
        forModel: { query: name, contacts: people.map(p => ({ id: p.email, name: p.name, email: p.email })) },
        card: { kind: 'list', title: people.length ? `Contacts: ${name}` : `No contact "${name}"`, items: people.map(p => ({ id: p.email, kind: 'contact', title: p.name, detail: p.email })) },
      }
    },
  },
]
