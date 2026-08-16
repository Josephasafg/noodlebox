import type { Articulation } from '../theory/licks'
import type { ParsedScore } from './types'

/**
 * A correction to one note of a tab.
 *
 * `art` is cleared with null rather than by leaving the field out, so "this note
 * is only picked" is something that can be said — the mark a video reader
 * imagined has to come off as easily as a missing one goes on.
 */
export interface NoteChange {
  fret?: number | null
  art?: Articulation | null
}

/**
 * Apply a correction, returning a new score.
 *
 * What a video was read from is usually right about where the notes are and
 * wrong about how they are joined, so a single note is the unit that gets fixed.
 * An index that names no note leaves the score exactly as it was, so a stale
 * click cannot damage a tab.
 */
export function applyNoteChange(
  score: ParsedScore,
  index: number,
  change: NoteChange,
): ParsedScore {
  const note = score.notes[index]
  if (!note) return score

  const edited = { ...note }
  if ('fret' in change) edited.fret = change.fret ?? null
  if ('art' in change) {
    if (change.art) edited.art = change.art
    else delete edited.art
  }

  return { ...score, notes: score.notes.map((n, i) => (i === index ? edited : n)) }
}
