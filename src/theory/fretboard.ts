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

export function notesInPosition(
  root: PitchClass,
  scale: ScaleDef,
  positionIndex: number,
  tuning: readonly PitchClass[] = STANDARD_TUNING,
  maxFret: number = FRET_COUNT,
): FretNote[] {
  const positions = positionsForScale(scale)
  const position = positions[positionIndex]
  if (!position) return []
  const rootFret = rootFretOnLowE(root, tuning)
  const start = rootFret + position.startOffset
  const end = rootFret + position.endOffset
  return allScaleNotes(root, scale, tuning, maxFret).filter(
    (n) => n.fret >= start && n.fret <= end,
  )
}

export function positionCount(scale: ScaleDef): number {
  return positionsForScale(scale).length
}
