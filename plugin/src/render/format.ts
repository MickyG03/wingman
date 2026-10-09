import type { Person } from '../../../shared/protocol'

const MIN = 60_000

export const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

export const timeOf = (iso: string) => clock(Date.parse(iso))

/** "now", "in 6 min", "in 2 h 15", "started 4 min ago", "Thu 9:30 AM" */
export function relative(startIso: string, now: number, endIso?: string): string {
  const start = Date.parse(startIso)
  const diff = start - now
  if (diff <= 0) {
    const end = endIso ? Date.parse(endIso) : start
    const ago = Math.round(-diff / MIN)
    return now < end ? (ago < 1 ? 'now' : `started ${ago} min ago`) : 'ended'
  }
  const mins = Math.round(diff / MIN)
  if (mins < 60) return `in ${Math.max(1, mins)} min`
  if (new Date(start).toDateString() === new Date(now).toDateString()) {
    return `in ${Math.floor(mins / 60)} h${mins % 60 >= 5 ? ` ${mins % 60}` : ''}`
  }
  return new Date(start).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

/** Compact email age: "now", "25m", "3h", "Tue", "Sep 30" */
export function age(iso: string, now: number): string {
  const t = Date.parse(iso)
  const mins = Math.floor((now - t) / MIN)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}h`
  if (mins < 6 * 24 * 60) return new Date(t).toLocaleDateString([], { weekday: 'short' })
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** "Thu, Oct 15, 12:30 - 1:30 PM" */
export function whenRange(startIso: string, endIso: string): string {
  const s = new Date(startIso)
  const e = new Date(endIso)
  const day = s.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
  return `${day}, ${clock(s.getTime())} - ${clock(e.getTime())}`
}

export const firstName = (p: Person) => (p.name && p.name !== p.email ? p.name.split(/\s+/)[0] : p.email.split('@')[0])

export const names = (people: Person[], max = 3) => {
  const shown = people.slice(0, max).map(firstName).join(', ')
  return people.length > max ? `${shown} +${people.length - max}` : shown
}
