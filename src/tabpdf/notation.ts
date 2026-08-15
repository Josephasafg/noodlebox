import type { Articulation } from '../theory/licks'
import type { ScoreNote } from './types'

/**
 * How each articulation is written between two fret numbers, following the
 * convention plain-text tab uses: 7h9, 9p7, 7/9, 9\7.
 */
export const LEGATO_SYMBOL: Partial<Record<Articulation, string>> = {
  hammer: 'h',
  pull: 'p',
  'slide-up': '/',
  'slide-down': '\\',
  vibrato: '~',
}

/** Shown when a bend has no fret to name — the direction is all there is. */
const BEND_ARROW = { up: '↑', down: '↓' } as const

/**
 * How a bend is written after its fret number: `8b10`, the way plain-text tab
 * names the pitch a string is pushed to.
 *
 * A quarter-tone bend lands between two frets and a bend with no printed amount
 * has no target at all, so both fall back to an arrow — `8↑` — which says what
 * the file actually provided rather than inventing a fret.
 *
 * A tied note gets nothing: engravers repeat the amount over every note a bend
 * is held across, where plain-text tab writes it once, on the note that is
 * actually struck.
 */
export function bendMark(note: ScoreNote): string | null {
  const bend = note.bend
  if (!bend || note.ghost) return null
  const { semitones, direction } = bend
  if (
    direction === 'up' &&
    note.fret !== null &&
    semitones !== null &&
    Number.isInteger(semitones)
  ) {
    return `b${note.fret + semitones}`
  }
  return BEND_ARROW[direction]
}

/** A legato symbol and the two notes it joins. */
export interface LegatoSpan {
  symbol: string
  /** Index of the note the symbol leads into. */
  target: number
  /** Index of the note it leads from, or null when nothing precedes it. */
  source: number | null
}

/** Beyond this many beats apart, two notes are not really joined by a slur. */
const MAX_SPAN_BEATS = 8

/**
 * Work out where each legato symbol belongs.
 *
 * The parser marks the note being hammered onto, pulled off to or slid into, so
 * the symbol sits between that note and whatever last sounded on the same
 * string — the `7` and the `9` of `7h9`. A note with nothing before it on its
 * string keeps the symbol on its left, as `/9` is written.
 */
export function legatoSpans(notes: readonly ScoreNote[]): LegatoSpan[] {
  const spans: LegatoSpan[] = []
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i]
    if (!note.art) continue
    const symbol = LEGATO_SYMBOL[note.art]
    if (!symbol) continue

    let source: number | null = null
    for (let j = i - 1; j >= 0; j--) {
      const candidate = notes[j]
      if (note.beat - candidate.beat > MAX_SPAN_BEATS) break
      if (candidate.stringIdx !== note.stringIdx) continue
      if (candidate.beat >= note.beat) continue
      source = j
      break
    }
    spans.push({ symbol, target: i, source })
  }
  return spans
}
