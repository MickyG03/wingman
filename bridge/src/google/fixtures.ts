// Demo data for FAKE_GOOGLE=1. Times are relative to when the bridge starts,
// so there is always a meeting about to begin.

import type { Meeting, Person } from '../../../shared/protocol.ts'
import type { RawEmail } from './ports.ts'

export const SELF: Person = { name: 'Me', email: 'me@example.com' }

const P = {
  priya: { name: 'Priya Sharma', email: 'priya@acme.example' },
  priyaP: { name: 'Priya Patel', email: 'priya.patel@mail.example' },
  sam: { name: 'Sam Lee', email: 'sam.lee@acme.example' },
  alex: { name: 'Alex Chen', email: 'alex@vendorco.example' },
  jordan: { name: 'Jordan Kim', email: 'jordan@acme.example' },
  github: { name: 'GitHub', email: 'notifications@github.example' },
  brew: { name: 'Morning Brew', email: 'crew@morningbrew.example' },
} satisfies Record<string, Person>

const MIN = 60_000
const iso = (t: number) => new Date(t).toISOString()

function atTomorrow(now: number, hours: number, minutes = 0): number {
  const d = new Date(now)
  d.setDate(d.getDate() + 1)
  d.setHours(hours, minutes, 0, 0)
  return d.getTime()
}

export function buildMeetings(now: number): Meeting[] {
  const tomorrow = new Date(atTomorrow(now, 0))
  const dayAfter = new Date(tomorrow)
  dayAfter.setDate(dayAfter.getDate() + 1)
  const ymd = (d: Date) => d.toISOString().slice(0, 10)
  return [
    {
      id: 'evt-design-review',
      title: 'Design review: onboarding v2',
      start: iso(now + 7 * MIN),
      end: iso(now + 37 * MIN),
      allDay: false,
      location: 'Room 4B / Meet',
      description: 'Walk through the new onboarding flows and decide on a launch date.',
      attendees: [P.priya, P.sam, SELF],
    },
    {
      id: 'evt-alex-1on1',
      title: '1:1 Alex - vendor contract',
      start: iso(now + 180 * MIN),
      end: iso(now + 210 * MIN),
      allDay: false,
      attendees: [P.alex, SELF],
    },
    {
      id: 'evt-priya-ooo',
      title: 'Priya OOO',
      start: ymd(tomorrow),
      end: ymd(dayAfter),
      allDay: true,
      attendees: [],
    },
    {
      id: 'evt-standup',
      title: 'Team standup',
      start: iso(atTomorrow(now, 9, 30)),
      end: iso(atTomorrow(now, 9, 45)),
      allDay: false,
      attendees: [P.priya, P.sam, P.jordan, SELF],
    },
  ]
}

function mail(
  id: string,
  threadId: string,
  from: Person,
  to: Person[],
  subject: string,
  minutesAgo: number,
  now: number,
  bodyText: string,
  unread: boolean,
): RawEmail {
  return {
    id,
    threadId,
    from,
    to,
    cc: [],
    subject,
    date: iso(now - minutesAgo * MIN),
    snippet: bodyText.replace(/\s+/g, ' ').slice(0, 140),
    bodyText,
    messageId: `<${id}@fixtures.example>`,
    unread,
  }
}

/** All fixture messages: inbox ones plus older sent mail used for threads and contacts. */
export function buildEmails(now: number): { inbox: RawEmail[]; other: RawEmail[] } {
  const inbox = [
    mail('m-priya-mocks', 't-onboarding', P.priya, [SELF, P.sam], 'Onboarding v2 - final mocks before review', 25, now,
      "Hi! Final mocks for today's review are in the Figma link. Main open question: do we launch on Oct 20, or wait for the analytics hooks and launch Oct 27? Sam thinks we should wait. Could you take a look before the meeting?\n\nPriya", true),
    mail('m-sam-lunch', 't-lunch', P.sam, [SELF], 'Lunch Thursday?', 62, now,
      "Want to grab lunch Thursday around 12:30? There's a new ramen place two blocks from the office.\n\nSam", true),
    mail('m-alex-contract', 't-contract', P.alex, [SELF], 'Contract renewal - updated numbers', 190, now,
      "Hi,\n\nFollowing up on our call. Next year's renewal comes to $48,000, a 6% increase. You can also lock in a 2-year term at $46,500 per year. We'd need a decision by Oct 31. Happy to go through it in our 1:1 today.\n\nBest,\nAlex", true),
    mail('m-gh-ci', 't-gh', P.github, [SELF], '[wingman] CI passed on feat/copilot', 240, now,
      'All checks have passed on feat/copilot. View the run on GitHub.', false),
    mail('m-brew', 't-brew', P.brew, [SELF], 'Markets rally on rate-cut hopes', 380, now,
      "Good morning. Stocks climbed yesterday as investors bet on a rate cut next month. Plus: the best gadgets of the fall and a crossword.", false),
    mail('m-jordan-offsite', 't-offsite', P.jordan, [SELF, P.priya], 'Offsite venue options', 1500, now,
      'Three venue options for the November offsite: the lakeside lodge ($$, 2h drive), the downtown loft ($, walkable), or the vineyard ($$$, 1h). Which do you prefer? I need to book by Friday.\n\nJordan', false),
  ]
  const other = [
    mail('m-me-onboarding', 't-onboarding', SELF, [P.priya, P.sam], 'Onboarding v2 - final mocks before review', 1440 * 2, now,
      "Thanks Priya. I'll review the flows tonight. Let's make the launch date call in Thursday's review.", false),
    mail('m-me-priyap', 't-weekend', SELF, [P.priyaP], 'Hiking this weekend?', 1440 * 9, now,
      'Are you still up for the ridge trail on Saturday?', false),
    mail('m-priyap-reply', 't-weekend', P.priyaP, [SELF], 'Re: Hiking this weekend?', 1440 * 9 - 30, now,
      "Yes! Let's meet at 8.", false),
  ]
  return { inbox, other }
}
