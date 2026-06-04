import { sheets, type sheets_v4 } from '@googleapis/sheets'
import type { GoogleAuth } from './auth.ts'
import type { SheetsPort } from './ports.ts'

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v))

export class GoogleSheets implements SheetsPort {
  private readonly api: sheets_v4.Sheets

  constructor(private readonly auth: GoogleAuth) {
    this.api = sheets({ version: 'v4', auth: auth.client as never })
  }

  async info(sheetId: string) {
    return this.auth.call(async () => {
      const res = await this.api.spreadsheets.get({ spreadsheetId: sheetId, fields: 'properties.title,sheets.properties.title' })
      return {
        title: res.data.properties?.title ?? '(untitled)',
        sheets: (res.data.sheets ?? []).map(s => s.properties?.title ?? '').filter(Boolean),
      }
    })
  }

  async readRange(sheetId: string, range?: string) {
    return this.auth.call(async () => {
      const r = range ?? `'${(await this.info(sheetId)).sheets[0] ?? 'Sheet1'}'!A1:J40`
      const res = await this.api.spreadsheets.values.get({ spreadsheetId: sheetId, range: r })
      return { range: res.data.range ?? r, values: (res.data.values ?? []).map(row => row.map(str)) }
    })
  }

  async appendRows(sheetId: string, sheet: string | undefined, rows: string[][]) {
    return this.auth.call(async () => {
      const tab = sheet ?? (await this.info(sheetId)).sheets[0] ?? 'Sheet1'
      const res = await this.api.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: `'${tab}'!A1`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: rows },
      })
      return { range: res.data.updates?.updatedRange ?? tab }
    })
  }

  async updateRange(sheetId: string, range: string, values: string[][]) {
    return this.auth.call(async () => {
      const res = await this.api.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values },
      })
      return { range: res.data.updatedRange ?? range }
    })
  }
}
