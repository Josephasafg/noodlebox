import { describe, expect, it } from 'vitest'
import { applyNoteChange } from '../edit'
import { legatoSpans } from '../notation'
import type { ParsedScore, ScoreNote } from '../types'

const NOTES: ScoreNote[] = [
  { measureIndex: 0, stringIdx: 2, fret: 7, ghost: false, beat: 0, length: 1 },
  { measureIndex: 0, stringIdx: 2, fret: 9, ghost: false, beat: 1, length: 1, art: 'hammer' },
]

const SCORE: ParsedScore = {
  title: 'A Tab',
  artist: null,
  bpm: 120,
  beatsPerBar: 4,
  tuningNote: null,
  tuningShift: 0,
  measures: [{ index: 0, pageIndex: 0, systemIndex: 0, startBeat: 0, beats: 4 }],
  notes: NOTES,
  warnings: [],
  pageCount: 1,
  unreadCount: 0,
}

describe('correcting a note', () => {
  it('gives a note the mark it was printed with', () => {
    const next = applyNoteChange(SCORE, 0, { art: 'slide-up' })
    expect(next.notes[0].art).toBe('slide-up')
  })

  /**
   * A reader that imagined a slur has to be as easy to correct as one that
   * missed it, so "picked" is a value and not just the absence of one.
   */
  it('takes a mark off again', () => {
    const next = applyNoteChange(SCORE, 1, { art: null })
    expect(next.notes[1]).not.toHaveProperty('art')
  })

  it('corrects a misread fret', () => {
    const next = applyNoteChange(SCORE, 0, { fret: 12 })
    expect(next.notes[0].fret).toBe(12)
  })

  it('changes only what it was asked to', () => {
    const next = applyNoteChange(SCORE, 1, { fret: 10 })
    expect(next.notes[1].art).toBe('hammer')
    expect(next.notes[1].beat).toBe(1)
    expect(next.notes[0]).toBe(SCORE.notes[0])
  })

  it('leaves the score it was given alone', () => {
    applyNoteChange(SCORE, 0, { fret: 3, art: 'pull' })
    expect(SCORE.notes[0].fret).toBe(7)
    expect(SCORE.notes[0]).not.toHaveProperty('art')
  })

  /** A click that arrives after the tab has been re-read names no note. */
  it('is a no-op when the note is not there', () => {
    expect(applyNoteChange(SCORE, 99, { art: 'pull' })).toBe(SCORE)
  })

  /**
   * The mark is engraved between two numbers, so a correction has to reach the
   * notation and not just the note it was made on.
   */
  it('writes the mark into the notation between the two numbers', () => {
    const before = legatoSpans(applyNoteChange(SCORE, 1, { art: null }).notes)
    expect(before).toHaveLength(0)

    const after = legatoSpans(applyNoteChange(SCORE, 1, { art: 'pull' }).notes)
    expect(after).toEqual([{ symbol: 'p', target: 1, source: 0 }])
  })
})
