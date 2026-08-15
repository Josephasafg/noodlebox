import { describe, expect, it } from 'vitest'
import { notesAtBeat } from '../useBeatPlayhead'

const NOTES = [
  { beat: 0, length: 0.5 },
  { beat: 0.5, length: 0.5 },
  // A double stop: two notes struck together.
  { beat: 1, length: 1 },
  { beat: 1, length: 1 },
]

describe('notesAtBeat', () => {
  it('returns nothing when the playhead is idle', () => {
    expect(notesAtBeat(NOTES, null)).toEqual([])
  })

  it('picks the note sounding at the playhead', () => {
    expect(notesAtBeat(NOTES, 0)).toEqual([0])
    expect(notesAtBeat(NOTES, 0.25)).toEqual([0])
    expect(notesAtBeat(NOTES, 0.5)).toEqual([1])
  })

  it('returns every note of a double stop at once', () => {
    expect(notesAtBeat(NOTES, 1.5)).toEqual([2, 3])
  })

  it('treats a note as ending exactly at its length', () => {
    // Beat 0.5 belongs to the second note, not the first.
    expect(notesAtBeat(NOTES, 0.5)).not.toContain(0)
  })

  it('returns nothing past the end of the timeline', () => {
    expect(notesAtBeat(NOTES, 2)).toEqual([])
    expect(notesAtBeat(NOTES, 99)).toEqual([])
  })

  it('returns nothing for an empty lick', () => {
    expect(notesAtBeat([], 0)).toEqual([])
  })
})
