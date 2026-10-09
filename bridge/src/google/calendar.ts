import { calendar, type calendar_v3 } from '@googleapis/calendar'
import type { InviteDraft, Meeting } from '../../../shared/protocol.ts'
import { config } from '../config.ts'
import type { GoogleAuth } from './auth.ts'
import type { CalendarPort, EventPatch } from './ports.ts'

function toMeeting(e: calendar_v3.Schema$Event): Meeting {
  return {
    id: e.id ?? '',
    title: e.summary || '(untitled)',
    start: e.start?.dateTime ?? e.start?.date ?? '',
    end: e.end?.dateTime ?? e.end?.date ?? '',
    allDay: !e.start?.dateTime,
    location: e.location ?? undefined,
    description: e.description ?? undefined,
    attendees: (e.attendees ?? [])
      .filter(a => !a.resource && a.email)
      .map(a => ({ name: a.displayName || a.email!, email: a.email! })),
  }
}

function declinedBySelf(e: calendar_v3.Schema$Event): boolean {
  return e.attendees?.some(a => a.self && a.responseStatus === 'declined') ?? false
}

export class GoogleCalendar implements CalendarPort {
  private readonly api: calendar_v3.Calendar

  constructor(private readonly auth: GoogleAuth) {
    // Both @googleapis packages wrap the same google-auth-library client.
    this.api = calendar({ version: 'v3', auth: auth.client as never })
  }

  async upcoming(days: number) {
    return this.auth.call(async () => {
      const now = new Date()
      const res = await this.api.events.list({
        calendarId: 'primary',
        timeMin: now.toISOString(),
        timeMax: new Date(now.getTime() + days * 86_400_000).toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 25,
      })
      return (res.data.items ?? [])
        .filter(e => e.status !== 'cancelled' && !declinedBySelf(e))
        .map(toMeeting)
    })
  }

  async between(fromIso: string, toIso: string, max: number) {
    return this.auth.call(async () => {
      const res = await this.api.events.list({
        calendarId: 'primary',
        timeMin: fromIso,
        timeMax: toIso,
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: max,
      })
      return (res.data.items ?? []).filter(e => e.status !== 'cancelled' && !declinedBySelf(e)).map(toMeeting)
    })
  }

  async update(id: string, patch: EventPatch) {
    return this.auth.call(async () => {
      const current = (await this.api.events.get({ calendarId: 'primary', eventId: id })).data
      const attendees = [...(current.attendees ?? [])]
      for (const a of patch.addAttendees ?? []) {
        if (!attendees.some(x => x.email?.toLowerCase() === a.email.toLowerCase())) attendees.push({ email: a.email, displayName: a.name })
      }
      const res = await this.api.events.patch({
        calendarId: 'primary',
        eventId: id,
        sendUpdates: 'all',
        requestBody: {
          ...(patch.title ? { summary: patch.title } : {}),
          ...(patch.location !== undefined ? { location: patch.location } : {}),
          ...(patch.start ? { start: { dateTime: patch.start, timeZone: config.timeZone } } : {}),
          ...(patch.end ? { end: { dateTime: patch.end, timeZone: config.timeZone } } : {}),
          ...(patch.addAttendees?.length ? { attendees } : {}),
        },
      })
      return toMeeting(res.data)
    })
  }

  async remove(id: string) {
    await this.auth.call(() => this.api.events.delete({ calendarId: 'primary', eventId: id, sendUpdates: 'all' }))
  }

  async get(id: string) {
    return this.auth.call(async () => {
      try {
        return toMeeting((await this.api.events.get({ calendarId: 'primary', eventId: id })).data)
      } catch (err) {
        if ((err as { code?: number }).code === 404) return null
        throw err
      }
    })
  }

  async create(invite: InviteDraft) {
    return this.auth.call(async () => {
      const res = await this.api.events.insert({
        calendarId: 'primary',
        sendUpdates: 'all',
        requestBody: {
          summary: invite.title,
          location: invite.location,
          start: { dateTime: invite.start, timeZone: config.timeZone },
          end: { dateTime: invite.end, timeZone: config.timeZone },
          attendees: invite.attendees.map(a => ({ email: a.email, displayName: a.name })),
        },
      })
      return { id: res.data.id ?? '' }
    })
  }
}
