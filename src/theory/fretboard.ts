import { mod12, type PitchClass } from './notes'
import { type ScaleDef, scalePitchClasses } from './scales'

export const STANDARD_TUNING: readonly PitchClass[] = [4, 9, 2, 7, 11, 4]

export const FRET_COUNT = 22

export interface FretNote {
  stringIdx: number
  fret: number
  pitch: PitchClass
  degreeIndex: number
  isRoot: boolean
}

export interface Position {
  index: number
  label: string
  startOffset: number
  endOffset: number
}

/** A shape from `positionsForScale` pinned to concrete frets in one key. */
export interface PlacedPosition {
  /** Order on the neck, low to high — what the position chips are numbered by. */
  index: number
  /** Which shape this is, as an index into `positionsForScale`. */
  shapeIndex: number
  label: string
  startFret: number
  endFret: number
}

export function noteAt(
  stringIdx: number,
  fret: number,
  tuning: readonly PitchClass[] = STANDARD_TUNING,
): PitchClass {
  return mod12(tuning[stringIdx] + fret)
}

export function rootFretOnLowE(
  root: PitchClass,
  tuning: readonly PitchClass[] = STANDARD_TUNING,
): number {
  return mod12(root - tuning[0])
}

export function allScaleNotes(
  root: PitchClass,
  scale: ScaleDef,
  tuning: readonly PitchClass[] = STANDARD_TUNING,
  maxFret: number = FRET_COUNT,
): FretNote[] {
  const scalePcs = scalePitchClasses(root, scale)
  const pcToDegree = new Map<PitchClass, number>()
  scalePcs.forEach((pc, i) => {
    if (!pcToDegree.has(pc)) pcToDegree.set(pc, i)
  })
  const notes: FretNote[] = []
  for (let s = 0; s < tuning.length; s++) {
    for (let f = 0; f <= maxFret; f++) {
      const pitch = noteAt(s, f, tuning)
      const degree = pcToDegree.get(pitch)
      if (degree !== undefined) {
        notes.push({
          stringIdx: s,
          fret: f,
          pitch,
          degreeIndex: degree,
          isRoot: pitch === root,
        })
      }
    }
  }
  return notes
}

const PENTATONIC_WINDOWS: readonly [number, number][] = [
  [0, 3],
  [2, 5],
  [4, 8],
  [7, 10],
  [9, 12],
]

const DIATONIC_WINDOWS: readonly [number, number][] = [
  [0, 4],
  [2, 5],
  [4, 7],
  [5, 9],
  [7, 11],
  [9, 12],
  [11, 14],
]

const POSITION_LABELS_5 = ['I', 'II', 'III', 'IV', 'V'] as const
const POSITION_LABELS_7 = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'] as const

export function positionsForScale(scale: ScaleDef): Position[] {
  const windows = scale.family === 'diatonic' ? DIATONIC_WINDOWS : PENTATONIC_WINDOWS
  const labels = scale.family === 'diatonic' ? POSITION_LABELS_7 : POSITION_LABELS_5
  return windows.map(([startOffset, endOffset], index) => ({
    index,
    label: labels[index],
    startOffset,
    endOffset,
  }))
}

const OCTAVE_SHIFTS = [-24, -12, 0, 12, 24] as const

/**
 * Lowest octave that keeps `[start, end]` on the neck. `rootFretOnLowE` pins the
 * root to a single octave, which strands every box of a high-rooted key up top
 * (D sits at fret 10) and runs the last ones off the end of the board. Ascending
 * candidates plus a strict improvement test mean ties resolve downwards.
 * Same idea as `fitOctaveShift` in licks.ts.
 */
function fitOctaveShift(start: number, end: number, maxFret: number): number {
  let best = 0
  let bestPenalty = Infinity
  for (const shift of OCTAVE_SHIFTS) {
    const penalty = Math.max(0, -(start + shift)) + Math.max(0, end + shift - maxFret)
    if (penalty < bestPenalty) {
      bestPenalty = penalty
      best = shift
    }
  }
  return best
}

/**
 * The scale's shapes placed on the neck for `root`, ordered low to high, so
 * position 1 is always the box nearest the nut whatever the key.
 */
export function placedPositions(
  root: PitchClass,
  scale: ScaleDef,
  tuning: readonly PitchClass[] = STANDARD_TUNING,
  maxFret: number = FRET_COUNT,
): PlacedPosition[] {
  const rootFret = rootFretOnLowE(root, tuning)
  return positionsForScale(scale)
    .map((p) => {
      const start = rootFret + p.startOffset
      const end = rootFret + p.endOffset
      const shift = fitOctaveShift(start, end, maxFret)
      return {
        shapeIndex: p.index,
        label: p.label,
        startFret: start + shift,
        endFret: end + shift,
      }
    })
    .sort(
      (a, b) =>
        a.startFret - b.startFret || a.endFret - b.endFret || a.shapeIndex - b.shapeIndex,
    )
    .map((p, index) => ({ ...p, index }))
}

export function notesInPosition(
  root: PitchClass,
  scale: ScaleDef,
  positionIndex: number,
  tuning: readonly PitchClass[] = STANDARD_TUNING,
  maxFret: number = FRET_COUNT,
): FretNote[] {
  const position = placedPositions(root, scale, tuning, maxFret)[positionIndex]
  if (!position) return []
  return allScaleNotes(root, scale, tuning, maxFret).filter(
    (n) => n.fret >= position.startFret && n.fret <= position.endFret,
  )
}

export function positionCount(scale: ScaleDef): number {
  return positionsForScale(scale).length
}

export function scaleSequence(notes: FretNote[]): FretNote[] {
  return [...notes].sort((a, b) => {
    if (a.stringIdx !== b.stringIdx) return a.stringIdx - b.stringIdx
    return a.fret - b.fret
  })
}
