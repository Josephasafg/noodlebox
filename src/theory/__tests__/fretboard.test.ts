import { describe, it, expect } from 'vitest'
import {
  noteAt,
  rootFretOnLowE,
  notesInPosition,
  positionsForScale,
  STANDARD_TUNING,
} from '../fretboard'
import { SCALES } from '../scales'

function frets(notes: { stringIdx: number; fret: number }[], stringIdx: number): number[] {
  return notes
    .filter((n) => n.stringIdx === stringIdx)
    .map((n) => n.fret)
    .sort((a, b) => a - b)
}

describe('noteAt / rootFretOnLowE', () => {
  it('open strings match standard tuning', () => {
    expect(noteAt(0, 0)).toBe(4) // low E
    expect(noteAt(1, 0)).toBe(9) // A
    expect(noteAt(2, 0)).toBe(2) // D
    expect(noteAt(3, 0)).toBe(7) // G
    expect(noteAt(4, 0)).toBe(11) // B
    expect(noteAt(5, 0)).toBe(4) // high E
  })

  it('fret 5 on low E is A', () => {
    expect(noteAt(0, 5)).toBe(9)
  })

  it('rootFretOnLowE for A is 5, E is 0, G is 3, C is 8', () => {
    expect(rootFretOnLowE(9)).toBe(5)
    expect(rootFretOnLowE(4)).toBe(0)
    expect(rootFretOnLowE(7)).toBe(3)
    expect(rootFretOnLowE(0)).toBe(8)
  })
})

describe('A minor pentatonic — canonical shapes', () => {
  const scale = SCALES['minor-pentatonic']
  const rootA = 9

  it('box I contains the textbook frets 5 & 8 / 5 & 7 shape', () => {
    const notes = notesInPosition(rootA, scale, 0)
    expect(frets(notes, 0)).toEqual([5, 8]) // low E: A, C
    expect(frets(notes, 1)).toEqual([5, 7]) // A: D, E
    expect(frets(notes, 2)).toEqual([5, 7]) // D: G, A
    expect(frets(notes, 3)).toEqual([5, 7]) // G: C, D
    expect(frets(notes, 4)).toEqual([5, 8]) // B: E, G
    expect(frets(notes, 5)).toEqual([5, 8]) // e: A, C
  })

  it('box II (frets 7–10)', () => {
    const notes = notesInPosition(rootA, scale, 1)
    expect(frets(notes, 0)).toEqual([8, 10])
    expect(frets(notes, 1)).toEqual([7, 10])
    expect(frets(notes, 2)).toEqual([7, 10])
    expect(frets(notes, 3)).toEqual([7, 9])
    expect(frets(notes, 4)).toEqual([8, 10])
    expect(frets(notes, 5)).toEqual([8, 10])
  })

  it('root notes in box I are only the A notes', () => {
    const notes = notesInPosition(rootA, scale, 0)
    const roots = notes.filter((n) => n.isRoot)
    expect(roots.every((n) => n.pitch === 9)).toBe(true)
    expect(roots.length).toBe(3) // fret 5 on low E, A, and high E
  })
})

describe('transposition — same shape moves intact', () => {
  const scale = SCALES['minor-pentatonic']

  it('A min pent box I transposed by +3 semitones equals C min pent box I', () => {
    const a = notesInPosition(9, scale, 0)
    const c = notesInPosition(0, scale, 0)
    const aShape = a.map((n) => [n.stringIdx, n.fret - 5] as const).sort()
    const cShape = c.map((n) => [n.stringIdx, n.fret - 8] as const).sort()
    expect(aShape).toEqual(cShape)
  })
})

describe('E major — open position includes open strings', () => {
  const scale = SCALES['major']
  const rootE = 4

  it('box I starts at fret 0 and uses open strings', () => {
    const notes = notesInPosition(rootE, scale, 0)
    expect(rootFretOnLowE(rootE)).toBe(0)
    expect(notes.some((n) => n.stringIdx === 0 && n.fret === 0)).toBe(true)
    expect(notes.some((n) => n.stringIdx === 1 && n.fret === 0)).toBe(true)
  })
})

describe('position counts', () => {
  it('pentatonic family has 5 positions', () => {
    expect(positionsForScale(SCALES['minor-pentatonic']).length).toBe(5)
    expect(positionsForScale(SCALES['major-pentatonic']).length).toBe(5)
  })

  it('diatonic family has 7 positions', () => {
    expect(positionsForScale(SCALES['major']).length).toBe(7)
    expect(positionsForScale(SCALES['dorian']).length).toBe(7)
    expect(positionsForScale(SCALES['harmonic-minor']).length).toBe(7)
  })

  it('blues has 5 positions', () => {
    expect(positionsForScale(SCALES['blues']).length).toBe(5)
  })
})

describe('standard tuning sanity', () => {
  it('has 6 strings', () => {
    expect(STANDARD_TUNING.length).toBe(6)
  })
})
