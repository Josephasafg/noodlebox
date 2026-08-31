import { TabPdfError } from '../tabpdf/load'
import { scoreFromAscii } from './ascii'
import { decodeEntities } from './html'
import type { AsciiSource, ChordPage, ChordShape, SheetBlock, SheetChord, SheetLine } from './types'

/**
 * Reading a tab4u song page.
 *
 * The pages are machine-generated with one shape: inside `#songContentTPL`,
 * each stanza is a table whose rows are single cells classed `chords`, `song`
 * (lyrics and section names) or `tabs` (plain-text tablature). A chords row
 * lines up with the lyric row under it character by character, so a chord's
 * column in its own row is where it belongs over the words. That regularity is
 * why this is read with expressions rather than a DOM — which also keeps the
 * parser runnable in tests without a browser.
 *
 * A table of `tabs` rows is not kept as text: it becomes six staff lines handed
 * to `scoreFromAscii`, so the riffs are engraved on the app's own staff instead
 * of shown as the small monospace art the page prints.
 */

const CONTENT_RE = /<div[^>]*id="songContentTPL"[^>]*>/
const TABLE_RE = /<table\b[^>]*>([\s\S]*?)<\/table>/g
const CELL_RE = /<td class="(song|chords|tabs)"[^>]*>([\s\S]*?)<\/td>/g
const SPAN_RE = /<span\b([^>]*)>([\s\S]*?)<\/span>/g
/** The page title reads `<something> לשיר <song> - <artist> | Tab4U`. */
const TITLE_RE = /<title>[^<]*?לשיר\s+(.+?)\s+-\s+(.+?)\s*\|/
/** The fingering a chord span carries: variants split by `^`, strings by `` ` ``. */
const SHAPES_RE = /sCI\('[^']*','([^']*)'/
/** One fingered string: `S<string 1..6>F<fret>E<finger>`. */
const FINGER_RE = /S(\d)F(\d+)E\d+/g

const HEBREW_RE = /[֐-׿]/
/** A repeat instruction such as `x4`, printed as if it were a lyric. */
const REPEAT_RE = /^x\s?\d+$/i
/** Six strings to a staff; tab4u prints each as its own row. */
const STRINGS = 6

/**
 * Cell markup to the text it shows. Newlines and tabs are the page's own
 * indentation, never content; spacing that matters is written as `&nbsp;`.
 */
function decode(markup: string): string {
  return decodeEntities(markup.replace(/[\r\n\t]/g, '').replace(/<[^>]+>/g, ''))
}

function shapesFrom(spanAttrs: string): ChordShape[] {
  const match = SHAPES_RE.exec(spanAttrs)
  if (!match) return []
  return match[1]
    .split('^')
    .map((variant) => {
      const frets: (number | null)[] = [null, null, null, null, null, null]
      for (const finger of variant.matchAll(FINGER_RE)) {
        const string = Number(finger[1])
        // tab4u counts strings from the high E as 1; the app counts from the
        // low E as 0. A string the variant leaves out is not played.
        if (string >= 1 && string <= 6) frets[6 - string] = Number(finger[2])
      }
      return { frets }
    })
    .filter((shape) => shape.frets.some((fret) => fret !== null))
}

/** The chords in one row, each at the column its name starts on. */
function chordsFrom(cell: string, shapes: Record<string, ChordShape[]>): SheetChord[] {
  const chords: SheetChord[] = []
  let plain = ''
  let consumed = 0
  for (const match of cell.matchAll(SPAN_RE)) {
    plain += decode(cell.slice(consumed, match.index))
    const name = decode(match[2]).trim()
    if (name.length > 0) {
      chords.push({ name, column: plain.length })
      if (!(name in shapes)) {
        const parsed = shapesFrom(match[1])
        if (parsed.length > 0) shapes[name] = parsed
      }
    }
    plain += name
    consumed = match.index + match[0].length
  }
  return chords
}

type Row =
  | { kind: 'tab'; text: string }
  | { kind: 'chords'; chords: SheetChord[] }
  | { kind: 'lyric'; text: string }
  | { kind: 'label'; text: string }
  | { kind: 'note'; text: string }

function rowFrom(kind: string, cell: string, shapes: Record<string, ChordShape[]>): Row | null {
  if (kind === 'tabs') return { kind: 'tab', text: decode(cell).trim() }
  if (kind === 'chords') return { kind: 'chords', chords: chordsFrom(cell, shapes) }
  // Trailing spaces are alignment padding; leading ones can be real indentation
  // that the chord columns above were laid out against.
  const text = decode(cell).replace(/\s+$/, '')
  const bare = text.trim()
  if (bare.length === 0) return null
  if (REPEAT_RE.test(bare)) return { kind: 'note', text: bare }
  if (bare.endsWith(':')) return { kind: 'label', text: bare.replace(/:$/, '') }
  return { kind: 'lyric', text }
}

/** Pair each chords row with the lyric row under it. */
function sheetLinesFrom(rows: Row[]): SheetLine[] {
  const lines: SheetLine[] = []
  let i = 0
  while (i < rows.length) {
    const row = rows[i]
    if (row.kind === 'chords') {
      const next = i + 1 < rows.length ? rows[i + 1] : null
      if (next && next.kind === 'lyric') {
        lines.push({ kind: 'lyrics', text: next.text, chords: row.chords })
        i += 2
        continue
      }
      lines.push({ kind: 'chords', chords: row.chords })
      i += 1
      continue
    }
    if (row.kind === 'lyric') lines.push({ kind: 'lyrics', text: row.text, chords: [] })
    else if (row.kind !== 'tab') lines.push(row)
    i += 1
  }
  return lines
}

export function parseTab4u(html: string, sourceUrl: string): ChordPage {
  const opening = CONTENT_RE.exec(html)
  if (!opening) {
    throw new TabPdfError('That page does not look like a tab4u song — it has no chords on it.')
  }
  const start = opening.index + opening[0].length
  // The song content nests no elements deeper than its tables, so the first
  // closing div after it is its own.
  const end = html.indexOf('</div>', start)
  const region = html.slice(start, end === -1 ? html.length : end)

  const shapes: Record<string, ChordShape[]> = {}
  const blocks: SheetBlock[] = []
  const staves: AsciiSource[] = []
  /** A section name printed in its own table, waiting for what it labels. */
  let pendingLabel: string | undefined

  for (const table of region.matchAll(TABLE_RE)) {
    const rows: Row[] = []
    for (const cell of table[1].matchAll(CELL_RE)) {
      const row = rowFrom(cell[1], cell[2], shapes)
      if (row) rows.push(row)
    }
    if (rows.length === 0) continue

    const tabRows = rows.filter((r) => r.kind === 'tab')
    if (tabRows.length >= STRINGS) {
      // A repeat printed beside a staff belongs to it, and the engraved bars
      // have nowhere else to say so — so it is folded into the section name.
      const repeat = rows.find((r) => r.kind === 'note')
      const label = rows.find((r) => r.kind === 'label')
      const name = label?.kind === 'label' ? label.text : pendingLabel
      const marker = [name, repeat?.kind === 'note' ? `×${repeat.text.replace(/^x\s?/i, '')}` : null]
        .filter(Boolean)
        .join(' ')
      for (let i = 0; i + STRINGS <= tabRows.length; i += STRINGS) {
        staves.push({
          strings: tabRows.slice(i, i + STRINGS).map((r) => (r.kind === 'tab' ? r.text : '')),
          // Only the first staff of a run carries the name; the rest continue it.
          marker: i === 0 && marker.length > 0 ? marker : undefined,
        })
      }
      pendingLabel = undefined
      continue
    }

    // A table holding nothing but a section name labels whatever comes next.
    if (rows.length === 1 && rows[0].kind === 'label') {
      pendingLabel = rows[0].text
      continue
    }

    const lines = sheetLinesFrom(rows)
    if (lines.length === 0) continue
    if (pendingLabel) {
      lines.unshift({ kind: 'label', text: pendingLabel })
      pendingLabel = undefined
    }
    blocks.push({ lines })
  }

  const titled = TITLE_RE.exec(html)
  const title = titled ? titled[1] : null
  const artist = titled ? titled[2] : null
  const rtl = blocks.some((block) =>
    block.lines.some((line) => line.kind === 'lyrics' && HEBREW_RE.test(line.text)),
  )

  return {
    sheet: { title, artist, sourceUrl, rtl, blocks, shapes },
    score: scoreFromAscii(staves, { title, artist }),
    blocks: staves,
  }
}
