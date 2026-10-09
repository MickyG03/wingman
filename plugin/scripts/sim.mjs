// Drive the desktop simulator through its automation API (npm run simulate).
//   node scripts/sim.mjs shot out.png        glasses screenshot
//   node scripts/sim.mjs up|down|click|double_click [more actions...]
//   node scripts/sim.mjs console             recent console output
// Actions run in order with a pause between them.

import { writeFile } from 'node:fs/promises'

const BASE = `http://127.0.0.1:${process.env.SIM_PORT ?? 9898}`
const [, , cmd, ...rest] = process.argv
const sleep = ms => new Promise(r => setTimeout(r, ms))

if (cmd === 'shot') {
  const res = await fetch(`${BASE}/api/screenshot/glasses`)
  await writeFile(rest[0] ?? 'glasses.png', Buffer.from(await res.arrayBuffer()))
  console.log(`saved ${rest[0] ?? 'glasses.png'}`)
} else if (cmd === 'console') {
  const { entries } = await (await fetch(`${BASE}/api/console`)).json()
  for (const e of entries.slice(-Number(rest[0] ?? 30))) console.log(`[${e.level}] ${e.message}`)
} else if (cmd) {
  for (const action of [cmd, ...rest]) {
    if (/^\d+$/.test(action)) {
      await sleep(Number(action))
      continue
    }
    await fetch(`${BASE}/api/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    await sleep(400)
  }
} else {
  console.log('usage: node scripts/sim.mjs shot [file] | console [n] | <up|down|click|double_click|ms>...')
}
