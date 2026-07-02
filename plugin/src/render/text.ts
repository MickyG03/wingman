// Text layout for the G2's proportional firmware font, using Even's pixel
// metrics so lines never wrap or overflow unexpectedly on the glasses.

import { getTextWidth, pxTruncate } from '@evenrealities/pretext'

export const SCREEN_W = 576
export const LINE_H = 27
export const PAD = 4
/** The icon column on the left of every normal screen (display.ts INSET). */
export const INSET = 30
/** Usable text width inside the body (minus the icon column, padding and a safety margin). */
export const TEXT_W = SCREEN_W - INSET - 2 * PAD - 8
export const BODY_LINES = 8

export const width = (s: string) => getTextWidth(s)

export function truncate(s: string, maxPx = TEXT_W): string {
  return pxTruncate(s, maxPx)
}

/** Greedy word wrap to pixel width. Respects \n, hard-breaks words that are too long. */
export function wrap(text: string, maxPx = TEXT_W): string[] {
  const out: string[] = []
  for (const para of text.replace(/\r\n/g, '\n').split('\n')) {
    if (para.trim() === '') {
      out.push('')
      continue
    }
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word
      if (width(candidate) <= maxPx) {
        line = candidate
        continue
      }
      if (line) out.push(line)
      // A single word wider than the line: break it by characters.
      let rest = word
      while (width(rest) > maxPx) {
        let n = rest.length - 1
        while (n > 1 && width(rest.slice(0, n)) > maxPx) n--
        out.push(rest.slice(0, n))
        rest = rest.slice(n)
      }
      line = rest
    }
    if (line) out.push(line)
  }
  return out
}

export function paginate(lines: string[], perPage = BODY_LINES): string[][] {
  if (lines.length === 0) return [[]]
  const pages: string[][] = []
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage))
  return pages
}

/** `left` and `right` on one line, separated by spaces to push `right` to the edge. */
export function spread(left: string, right: string, maxPx = TEXT_W): string {
  const r = right.trim()
  const rw = width(r)
  const l = truncate(left, Math.max(40, maxPx - rw - width('  ')))
  const space = width(' ') || 5
  const gap = Math.max(1, Math.floor((maxPx - width(l) - rw) / space))
  return r ? `${l}${' '.repeat(gap)}${r}` : l
}

export interface ListEntry {
  lines: string[] // first line is the selectable title; the rest are details
}

/**
 * Renders entries with a `>` cursor, scrolling so the selected entry stays
 * visible within `maxLines`. `entryOfLine` maps each output line to its entry.
 */
export function renderListRows(entries: ListEntry[], cursor: number, maxLines = BODY_LINES, maxPx = TEXT_W): { lines: string[]; entryOfLine: number[] } {
  const blocks = entries.map((e, i) =>
    e.lines.map((l, j) => (j === 0 ? `${i === cursor ? '>' : '  '} ${truncate(l, maxPx - 24)}` : `      ${truncate(l, maxPx - 40)}`)),
  )
  // Pick the first entry to show so that the cursor's block fits.
  let start = 0
  const used = (from: number, to: number) => blocks.slice(from, to + 1).reduce((n, b) => n + b.length, 0)
  while (start < cursor && used(start, cursor) > maxLines) start++
  const lines: string[] = []
  const entryOfLine: number[] = []
  for (let i = start; i < blocks.length && lines.length + blocks[i].length <= maxLines; i++) {
    lines.push(...blocks[i])
    entryOfLine.push(...blocks[i].map(() => i))
  }
  return { lines, entryOfLine }
}

export function renderList(entries: ListEntry[], cursor: number, maxLines = BODY_LINES, maxPx = TEXT_W): string[] {
  return renderListRows(entries, cursor, maxLines, maxPx).lines
}
