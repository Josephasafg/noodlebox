import { STANDARD_TUNING, noteAt, type FretNote } from '../theory/fretboard'
import type { ResolvedLickNote } from '../theory/licks'
import type { ParsedScore, ScoreNote } from './types'

/** A stretch of an imported score, ready for the audio engine and fretboard. */
export interface PlayableSlice {
  /** Audible notes with beats rebased so the slice starts at zero. */
  notes: ResolvedLickNote[]
  totalBeats: number
  fromMeasure: number
  toMeasure: number
}

/**
 * Turn score notes into the note shape the rest of the app already plays.
 *
 * `noteIndex` carries the position in `score.notes` rather than in the slice, so
 * the sheet can light up the right fret number while the playhead moves.
 */
function toResolved(note: ScoreNote, index: number, baseBeat: number): ResolvedLickNote | null {
  if (note.fret === null) return null
  return {
    noteIndex: index,
    stringIdx: note.stringIdx,
    fret: note.fret,
    pitch: noteAt(note.stringIdx, note.fret, STANDARD_TUNING),
    degreeIndex: 0,
    isRoot: false,
    beat: note.beat - baseBeat,
    length: note.length,
    art: note.art,
  }
}

/**
 * Collect the measures `[fromMeasure, toMeasure]` as a playable slice.
 *
 * Dead notes are dropped: an `x` is a muted string, and sounding a pitch for it
 * would play something the tab does not print.
 */
export function sliceScore(
  score: ParsedScore,
  fromMeasure: number,
  toMeasure: number,
): PlayableSlice {
  const from = Math.max(0, Math.min(fromMeasure, toMeasure))
  const to = Math.min(score.measures.length - 1, Math.max(fromMeasure, toMeasure))
  const baseBeat = from * score.beatsPerBar
  const notes: ResolvedLickNote[] = []

  score.notes.forEach((note, index) => {
    if (note.measureIndex < from || note.measureIndex > to) return
    const resolved = toResolved(note, index, baseBeat)
    if (resolved) notes.push(resolved)
  })

  notes.sort((a, b) => a.beat - b.beat)
  const totalBeats = (to - from + 1) * score.beatsPerBar
  return { notes, totalBeats, fromMeasure: from, toMeasure: to }
}

/** Every distinct fretboard position used in a measure range, for the diagram. */
export function fretNotesInRange(
  score: ParsedScore,
  fromMeasure: number,
  toMeasure: number,
): FretNote[] {
  const seen = new Set<string>()
  const out: FretNote[] = []
  for (const note of score.notes) {
    if (note.fret === null) continue
    if (note.measureIndex < fromMeasure || note.measureIndex > toMeasure) continue
    const key = `${note.stringIdx}-${note.fret}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      stringIdx: note.stringIdx,
      fret: note.fret,
      pitch: noteAt(note.stringIdx, note.fret, STANDARD_TUNING),
      degreeIndex: 0,
      isRoot: false,
    })
  }
  return out
}
