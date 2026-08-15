import { describe, expect, it } from 'vitest'
import { fretNotesInRange, sliceScore } from '../playable'
import { lickSchedule } from '../../audio/guitar'
import { STANDARD_TUNING, noteAt } from '../../theory/fretboard'
import { mod12 } from '../../theory/notes'
import type { ParsedScore, ScoreNote } from '../types'

function note(over: Partial<ScoreNote> = {}): ScoreNote {
  return {
    measureIndex: 0,
    stringIdx: 0,
    fret: 5,
    ghost: false,
    beat: 0,
    length: 1,
    ...over,
  }
}

function score(notes: ScoreNote[], measureCount = 4): ParsedScore {
  return {
    title: 'Test',
    artist: null,
    bpm: 120,
    beatsPerBar: 4,
    tuningNote: null,
    tuningShift: 0,
    measures: Array.from({ length: measureCount }, (_, i) => ({
      index: i,
      pageIndex: 0,
      systemIndex: 0,
      startBeat: i * 4,
      beats: 4,
    })),
    notes,
    warnings: [],
    pageCount: 1,
    unreadCount: 0,
  }
}

describe('sliceScore', () => {
  it('takes only the bars asked for', () => {
    const s = score([
      note({ measureIndex: 0, beat: 0 }),
      note({ measureIndex: 1, beat: 4 }),
      note({ measureIndex: 2, beat: 8 }),
    ])
    expect(sliceScore(s, 1, 1).notes).toHaveLength(1)
    expect(sliceScore(s, 1, 2).notes).toHaveLength(2)
  })

  it('rebases beats so the slice starts at zero', () => {
    const s = score([note({ measureIndex: 2, beat: 9.5 })])
    expect(sliceScore(s, 2, 2).notes[0].beat).toBe(1.5)
  })

  it('reports the length of the slice in beats', () => {
    const s = score([note()])
    expect(sliceScore(s, 0, 2).totalBeats).toBe(12)
  })

  it('drops dead notes rather than sounding a pitch the tab never printed', () => {
    const s = score([note({ fret: null }), note({ fret: 7, beat: 1 })])
    const slice = sliceScore(s, 0, 0)
    expect(slice.notes.map((n) => n.fret)).toEqual([7])
  })

  it('points each playable note back at its place in the score', () => {
    const s = score([note({ fret: null }), note({ fret: 7, beat: 1 })])
    const slice = sliceScore(s, 0, 0)
    // Index 1, not 0 — the dead note was dropped but did not shift the mapping.
    expect(slice.notes[0].noteIndex).toBe(1)
    expect(s.notes[slice.notes[0].noteIndex].fret).toBe(7)
  })

  it('sorts notes by onset so the schedule runs forward', () => {
    const s = score([
      note({ beat: 2, fret: 9 }),
      note({ beat: 0, fret: 5 }),
      note({ beat: 1, fret: 7 }),
    ])
    expect(sliceScore(s, 0, 0).notes.map((n) => n.beat)).toEqual([0, 1, 2])
  })

  it('clamps a range that runs past the end of the score', () => {
    const s = score([note({ measureIndex: 3, beat: 12 })])
    const slice = sliceScore(s, 3, 99)
    expect(slice.toMeasure).toBe(3)
    expect(slice.notes).toHaveLength(1)
  })

  it('gives an empty slice for bars with nothing in them', () => {
    const s = score([note({ measureIndex: 0 })])
    expect(sliceScore(s, 2, 2).notes).toEqual([])
  })

  it('carries the pitch of the printed fret', () => {
    const s = score([note({ stringIdx: 2, fret: 7 })])
    expect(sliceScore(s, 0, 0).notes[0].pitch).toBe(noteAt(2, 7, STANDARD_TUNING))
  })
})

describe('imported tab playback matches the notation', () => {
  const s = score([
    note({ stringIdx: 5, fret: 3, beat: 0 }),
    note({ stringIdx: 5, fret: 5, beat: 1, art: 'hammer' }),
    note({ stringIdx: 0, fret: 12, beat: 2 }),
    note({ stringIdx: 3, fret: 0, beat: 3 }),
  ])

  it('sounds exactly one attack per printed note', () => {
    const slice = sliceScore(s, 0, 0)
    expect(lickSchedule(slice.notes, 120)).toHaveLength(slice.notes.length)
  })

  it('sounds each note at the pitch its fret number produces', () => {
    const slice = sliceScore(s, 0, 0)
    for (const scheduled of lickSchedule(slice.notes, 120)) {
      const source = s.notes[scheduled.noteIndex]
      expect(mod12(scheduled.midi)).toBe(
        mod12(STANDARD_TUNING[source.stringIdx] + (source.fret ?? 0)),
      )
    }
  })

  it('detunes every string together for a tab written in a lower tuning', () => {
    const slice = sliceScore(s, 0, 0)
    const standard = lickSchedule(slice.notes, 120)
    const halfDown = lickSchedule(slice.notes, 120, -1)
    expect(halfDown.map((n) => n.midi)).toEqual(standard.map((n) => n.midi - 1))
  })

  it('keeps the notes of a chord simultaneous', () => {
    const chord = score([
      note({ stringIdx: 2, fret: 5, beat: 1 }),
      note({ stringIdx: 3, fret: 5, beat: 1 }),
      note({ stringIdx: 4, fret: 6, beat: 1 }),
    ])
    const offsets = lickSchedule(sliceScore(chord, 0, 0).notes, 120).map(
      (n) => n.offsetSeconds,
    )
    expect(new Set(offsets).size).toBe(1)
  })
})

describe('fretNotesInRange', () => {
  it('collects the positions used in the range', () => {
    const s = score([
      note({ measureIndex: 0, stringIdx: 0, fret: 5 }),
      note({ measureIndex: 1, stringIdx: 1, fret: 7 }),
    ])
    expect(fretNotesInRange(s, 0, 1)).toHaveLength(2)
    expect(fretNotesInRange(s, 0, 0)).toHaveLength(1)
  })

  it('lists a repeated position once', () => {
    const s = score([
      note({ stringIdx: 2, fret: 5 }),
      note({ stringIdx: 2, fret: 5, beat: 1 }),
    ])
    expect(fretNotesInRange(s, 0, 0)).toHaveLength(1)
  })

  it('leaves out dead notes, which have no position on the neck', () => {
    const s = score([note({ fret: null })])
    expect(fretNotesInRange(s, 0, 0)).toEqual([])
  })
})
