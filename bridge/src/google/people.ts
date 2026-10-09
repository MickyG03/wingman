import { people, type people_v1 } from '@googleapis/people'
import type { Person } from '../../../shared/protocol.ts'
import type { GoogleAuth } from './auth.ts'
import type { ContactsPort } from './ports.ts'

function toPeople(list: people_v1.Schema$Person[] | undefined): Person[] {
  const out: Person[] = []
  for (const p of list ?? []) {
    const name = p.names?.[0]?.displayName ?? ''
    for (const e of p.emailAddresses ?? []) {
      if (e.value) out.push({ name: name || e.value, email: e.value })
    }
  }
  return out
}

/**
 * Google Contacts plus "Other contacts" (addresses Gmail saved automatically
 * because you emailed them). Needs the contacts.readonly and
 * contacts.other.readonly scopes.
 */
export class GooglePeople implements ContactsPort {
  private readonly api: people_v1.People

  constructor(private readonly auth: GoogleAuth) {
    this.api = people({ version: 'v1', auth: auth.client as never })
  }

  async list(): Promise<Person[]> {
    return this.auth.call(async () => {
      const all: Person[] = []
      let pageToken: string | undefined
      do {
        const res = await this.api.people.connections.list({
          resourceName: 'people/me',
          personFields: 'names,emailAddresses',
          pageSize: 1000,
          pageToken,
        })
        all.push(...toPeople(res.data.connections))
        pageToken = res.data.nextPageToken ?? undefined
      } while (pageToken)
      do {
        const res = await this.api.otherContacts.list({ readMask: 'names,emailAddresses', pageSize: 1000, pageToken })
        all.push(...toPeople(res.data.otherContacts))
        pageToken = res.data.nextPageToken ?? undefined
      } while (pageToken)
      return all
    })
  }
}
