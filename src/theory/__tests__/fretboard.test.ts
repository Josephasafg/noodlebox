import { describe, it, expect } from 'vitest'
import {
  FRET_COUNT,
  noteAt,
  rootFretOnLowE,
  notesInPosition,
  placedPositions,
  positionsForScale,
  STANDARD_TUNING,
} from '../fretboard'
import { SCALES, type ScaleDef } from '../scales'
import { CHROMATIC_KEYS, type PitchClass } from '../notes'

function frets(notes: { stringIdx: number; fret: number }[], stringIdx: number): number[] {
  return notes
    .filter((n) => n.stringIdx === stringIdx)
    .map((n) => n.fret)
    .sort((a, b) => a - b)
}

/** Position chips are numbered by neck order, so find a named box by its label. */
function boxIndex(root: PitchClass, scale: ScaleDef, label: string): number {
  const found = placedPositions(root, scale).find((p) => p.label === label)
  if (!found) throw new Error(`no box ${label}`)
  return found.index
}

function shapeOf(notes: { stringIdx: number; fret: number }[]): string[] {
  const low = Math.min(...notes.map((n) => n.fret))
  return notes
    .map((n) => `${n.stringIdx}:${n.fret - low}`)
    .sort()
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
    const notes = notesInPosition(rootA, scale, boxIndex(rootA, scale, 'I'))
    expect(frets(notes, 0)).toEqual([5, 8]) // low E: A, C
    expect(frets(notes, 1)).toEqual([5, 7]) // A: D, E
    expect(frets(notes, 2)).toEqual([5, 7]) // D: G, A
    expect(frets(notes, 3)).toEqual([5, 7]) // G: C, D
    expect(frets(notes, 4)).toEqual([5, 8]) // B: E, G
    expect(frets(notes, 5)).toEqual([5, 8]) // e: A, C
  })

  it('box II (frets 7–10)', () => {
    const notes = notesInPosition(rootA, scale, boxIndex(rootA, scale, 'II'))
    expect(frets(notes, 0)).toEqual([8, 10])
    expect(frets(notes, 1)).toEqual([7, 10])
    expect(frets(notes, 2)).toEqual([7, 10])
    expect(frets(notes, 3)).toEqual([7, 9])
    expect(frets(notes, 4)).toEqual([8, 10])
    expect(frets(notes, 5)).toEqual([8, 10])
  })

  it('root notes in box I are only the A notes', () => {
    const notes = notesInPosition(rootA, scale, boxIndex(rootA, scale, 'I'))
    const roots = notes.filter((n) => n.isRoot)
    expect(roots.every((n) => n.pitch === 9)).toBe(true)
    expect(roots.length).toBe(3) // fret 5 on low E, A, and high E
  })
})

describe('transposition — same shape moves intact', () => {
  const scale = SCALES['minor-pentatonic']

  it('A min pent box I transposed by +3 semitones equals C min pent box I', () => {
    const a = notesInPosition(9, scale, boxIndex(9, scale, 'I'))
    const c = notesInPosition(0, scale, boxIndex(0, scale, 'I'))
    const aShape = a.map((n) => [n.stringIdx, n.fret - 5] as const).sort()
    const cShape = c.map((n) => [n.stringIdx, n.fret - 8] as const).sort()
    expect(aShape).toEqual(cShape)
  })

  it('a box dropped an octave keeps its shape intact', () => {
    // D box II lives at frets 0–3, an octave below where the root pins it.
    const d = notesInPosition(2, scale, boxIndex(2, scale, 'II'))
    const a = notesInPosition(9, scale, boxIndex(9, scale, 'II'))
    expect(shapeOf(d)).toEqual(shapeOf(a))
  })
})

describe('octave placement — boxes sit under the hand, not off the neck', () => {
  const minPent = SCALES['minor-pentatonic']
  const rootD = 2

  it('D min pent runs up the neck from the nut, not from fret 10', () => {
    const placed = placedPositions(rootD, minPent)
    expect(placed.map((p) => p.startFret)).toEqual([0, 2, 5, 7, 10])
    // The root only appears at fret 10 on the low E, so box I stays up there
    // and the four boxes below it are the ones that dropped an octave.
    expect(placed.map((p) => p.label)).toEqual(['II', 'III', 'IV', 'V', 'I'])
  })

  it('D blues position 1 is the low box, not frets 10–13', () => {
    const notes = notesInPosition(rootD, SCALES['blues'], 0)
    expect(notes.length).toBeGreaterThan(0)
    expect(Math.max(...notes.map((n) => n.fret))).toBeLessThanOrEqual(3)
  })

  it('positions are ordered low to high for every key', () => {
    for (const scale of [minPent, SCALES['blues'], SCALES['major']]) {
      for (const root of CHROMATIC_KEYS) {
        const starts = placedPositions(root, scale).map((p) => p.startFret)
        const ascending = [...starts].sort((a, b) => a - b)
        expect(starts).toEqual(ascending)
      }
    }
  })

  it('no box falls off either end of the neck', () => {
    for (const scale of [minPent, SCALES['major-pentatonic'], SCALES['blues'], SCALES['major']]) {
      for (const root of CHROMATIC_KEYS) {
        for (const p of placedPositions(root, scale)) {
          expect(p.startFret).toBeGreaterThanOrEqual(0)
          expect(p.endFret).toBeLessThanOrEqual(FRET_COUNT)
        }
      }
    }
  })

  it('every position still yields notes on all six strings', () => {
    for (const scale of [minPent, SCALES['blues'], SCALES['major']]) {
      for (const root of CHROMATIC_KEYS) {
        placedPositions(root, scale).forEach((p) => {
          const strings = new Set(notesInPosition(root, scale, p.index).map((n) => n.stringIdx))
          expect(strings.size).toBe(6)
        })
      }
    }
  })

  it('E major keeps its open position at index 0', () => {
    const placed = placedPositions(4, SCALES['major'])
    expect(placed[0].label).toBe('I')
    expect(placed[0].startFret).toBe(0)
  })

  it('D major top box no longer overflows the 22nd fret', () => {
    // Anchored at the low-E root (fret 10) this box spanned frets 21–24.
    const placed = placedPositions(rootD, SCALES['major'])
    const seventh = placed.find((p) => p.label === 'VII')!
    expect(seventh.endFret).toBeLessThanOrEqual(FRET_COUNT)
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
