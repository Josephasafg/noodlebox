import type { Articulation } from '../theory/licks'

/**
 * The raw drawing primitives a tab PDF is made of, in a page coordinate system
 * with y growing downward from the top edge.
 *
 * Keeping these separate from pdf.js is deliberate: every parsing decision then
 * runs on plain numbers, so the whole recogniser is testable without a PDF.
 */
export interface TabLineSeg {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface TabTextItem {
  str: string
  /** Left edge of the glyph run. */
  x: number
  /** Text baseline, measured down from the top of the page. */
  y: number
  fontSize: number
  /** Advance width of the run. */
  width: number
}

export interface TabPagePrimitives {
  pageIndex: number
  width: number
  height: number
  segments: TabLineSeg[]
  texts: TabTextItem[]
}

/**
 * A six-line tablature staff located on a page. Five equally spaced lines are a
 * standard notation staff and six are tab — that difference is what lets us find
 * the tab staves without knowing which program engraved the file.
 */
export interface TabStaffBox {
  pageIndex: number
  /** y of each line, top (highest string) first. */
  lines: number[]
  top: number
  bottom: number
  spacing: number
  x0: number
  x1: number
}

/**
 * A bend, read from the amount an engraver prints above the arrow — "Full",
 * "1/2", "1 1/2". The amount is what makes the bend nameable as `8b10`; without
 * one all that can be shown is the direction.
 */
export interface ScoreBend {
  /** Semitones the string is pushed, or null when no amount was printed. */
  semitones: number | null
  direction: 'up' | 'down'
}

/** A single fret number read off a tab staff. */
export interface ScoreNote {
  measureIndex: number
  /** 0 = lowest string (low E) … 5 = highest, matching `FretNote`. */
  stringIdx: number
  /** null for a dead/muted note, printed as `x`. */
  fret: number | null
  /** Printed in parentheses — a tie or let-ring restatement, not a new attack. */
  ghost: boolean
  /** Onset in beats from the start of the score. */
  beat: number
  length: number
  art?: Articulation
  bend?: ScoreBend
}

export interface ScoreMeasure {
  index: number
  pageIndex: number
  /** Running index of the staff system this measure was engraved on. */
  systemIndex: number
  startBeat: number
  beats: number
  /** Rehearsal marker such as "Verse" or "Chorus". */
  marker?: string
}

export interface ParsedScore {
  title: string | null
  artist: string | null
  bpm: number
  beatsPerBar: number
  /** Any tuning instruction printed on the first page, verbatim. */
  tuningNote: string | null
  /** Semitones to shift playback by, read from `tuningNote`. */
  tuningShift: number
  measures: ScoreMeasure[]
  notes: ScoreNote[]
  /** Things the reader could not be sure about, shown to the user. */
  warnings: string[]
  pageCount: number
  /** Fret numbers found but not understood, as a confidence signal. */
  unreadCount: number
}
