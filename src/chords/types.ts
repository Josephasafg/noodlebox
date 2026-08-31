import type { ParsedScore } from '../tabpdf/types'

/**
 * A song laid out as chords over lyrics — the format chord sites publish —
 * rather than engraved tablature. It carries no rhythm, so it is for reading
 * along, not for playback.
 *
 * Tablature printed on the same page does not live here: it is converted to a
 * real `ParsedScore` (see `ascii.ts`) so it is engraved, playable and editable
 * like any other imported tab, rather than shown as the small monospace art it
 * arrived as.
 */

/** A chord name anchored to a character column of the line it sits above. */
export interface SheetChord {
  name: string
  /** Character index into the lyric line under it. */
  column: number
}

export type SheetLine =
  | { kind: 'lyrics'; text: string; chords: SheetChord[] }
  /** A run of chords with no words under them, such as an ending vamp. */
  | { kind: 'chords'; chords: SheetChord[] }
  /** A section name, such as an intro or chorus heading. */
  | { kind: 'label'; text: string }
  /** A playing instruction printed among the lyrics, such as `x4`. */
  | { kind: 'note'; text: string }

/** One stanza: the lines that were printed together between gaps. */
export interface SheetBlock {
  lines: SheetLine[]
}

/**
 * How a chord is fingered. Index 0 is the lowest string (low E), matching
 * `FretNote.stringIdx`; null is a string that is not played.
 */
export interface ChordShape {
  frets: (number | null)[]
}

export interface ChordSheet {
  title: string | null
  artist: string | null
  /** The page this was read from, for going back to it. */
  sourceUrl: string
  /** Whether the lyrics read right to left, which sets the sheet's direction. */
  rtl: boolean
  blocks: SheetBlock[]
  /** Fingerings by chord name, first variant first, where the page had them. */
  shapes: Record<string, ChordShape[]>
}

/**
 * What a song page yields: the words to sing, and the tablature to play.
 *
 * Either half can be missing — an instrumental has no words, and a chord-only
 * song has no tablature — so both are optional and the app shows whichever
 * arrived.
 */
export interface ChordPage {
  sheet: ChordSheet
  score: ParsedScore | null
  /** The plain-text staves the score was built from, kept so it can be re-read. */
  blocks: AsciiSource[]
}

/** A staff of plain text as it was found on the page, with its section name. */
export interface AsciiSource {
  strings: string[]
  marker?: string
}

/** What the library list says about a sheet: lyric lines and chord marks. */
export function sheetStats(sheet: ChordSheet): { lines: number; chords: number } {
  let lines = 0
  let chords = 0
  for (const block of sheet.blocks) {
    for (const line of block.lines) {
      if (line.kind === 'lyrics') lines += 1
      if (line.kind === 'lyrics' || line.kind === 'chords') chords += line.chords.length
    }
  }
  return { lines, chords }
}

/** Whether there is anything to sing, which is what the sheet view is for. */
export function sheetHasWords(sheet: ChordSheet): boolean {
  return sheet.blocks.some((block) =>
    block.lines.some((line) => line.kind === 'lyrics' || line.kind === 'chords'),
  )
}
