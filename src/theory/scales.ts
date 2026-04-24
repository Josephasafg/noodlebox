import { mod12, type PitchClass } from './notes'

export type ScaleFamily = 'pentatonic' | 'diatonic' | 'blues'

export interface ScaleDef {
  id: string
  displayName: string
  shortName: string
  intervals: readonly number[]
  family: ScaleFamily
  group: 'major' | 'minor' | 'pentatonic' | 'blues' | 'modes'
}

export const SCALES = {
  'major': {
    id: 'major', displayName: 'Major', shortName: 'major',
    intervals: [0, 2, 4, 5, 7, 9, 11], family: 'diatonic', group: 'major',
  },
  'natural-minor': {
    id: 'natural-minor', displayName: 'Natural Minor', shortName: 'nat. minor',
    intervals: [0, 2, 3, 5, 7, 8, 10], family: 'diatonic', group: 'minor',
  },
  'major-pentatonic': {
    id: 'major-pentatonic', displayName: 'Major Pentatonic', shortName: 'maj pent',
    intervals: [0, 2, 4, 7, 9], family: 'pentatonic', group: 'pentatonic',
  },
  'minor-pentatonic': {
    id: 'minor-pentatonic', displayName: 'Minor Pentatonic', shortName: 'min pent',
    intervals: [0, 3, 5, 7, 10], family: 'pentatonic', group: 'pentatonic',
  },
  'blues': {
    id: 'blues', displayName: 'Blues', shortName: 'blues',
    intervals: [0, 3, 5, 6, 7, 10], family: 'blues', group: 'blues',
  },
  'harmonic-minor': {
    id: 'harmonic-minor', displayName: 'Harmonic Minor', shortName: 'harm. minor',
    intervals: [0, 2, 3, 5, 7, 8, 11], family: 'diatonic', group: 'minor',
  },
  'melodic-minor': {
    id: 'melodic-minor', displayName: 'Melodic Minor', shortName: 'mel. minor',
    intervals: [0, 2, 3, 5, 7, 9, 11], family: 'diatonic', group: 'minor',
  },
  'dorian': {
    id: 'dorian', displayName: 'Dorian', shortName: 'dorian',
    intervals: [0, 2, 3, 5, 7, 9, 10], family: 'diatonic', group: 'modes',
  },
  'phrygian': {
    id: 'phrygian', displayName: 'Phrygian', shortName: 'phrygian',
    intervals: [0, 1, 3, 5, 7, 8, 10], family: 'diatonic', group: 'modes',
  },
  'lydian': {
    id: 'lydian', displayName: 'Lydian', shortName: 'lydian',
    intervals: [0, 2, 4, 6, 7, 9, 11], family: 'diatonic', group: 'modes',
  },
  'mixolydian': {
    id: 'mixolydian', displayName: 'Mixolydian', shortName: 'mixolydian',
    intervals: [0, 2, 4, 5, 7, 9, 10], family: 'diatonic', group: 'modes',
  },
  'locrian': {
    id: 'locrian', displayName: 'Locrian', shortName: 'locrian',
    intervals: [0, 1, 3, 5, 6, 8, 10], family: 'diatonic', group: 'modes',
  },
} as const satisfies Record<string, ScaleDef>

export type ScaleId = keyof typeof SCALES

export const SCALE_LIST: readonly ScaleDef[] = Object.values(SCALES)

export function getScale(id: string): ScaleDef | null {
  return (SCALES as Record<string, ScaleDef>)[id] ?? null
}

export function scalePitchClasses(root: PitchClass, scale: ScaleDef): PitchClass[] {
  return scale.intervals.map((iv) => mod12(root + iv))
}

export function degreeLabel(intervalIndex: number, scale: ScaleDef): string {
  const iv = scale.intervals[intervalIndex]
  const labels: Record<number, string> = {
    0: '1', 1: '♭2', 2: '2', 3: '♭3', 4: '3', 5: '4',
    6: '♭5', 7: '5', 8: '♭6', 9: '6', 10: '♭7', 11: '7',
  }
  return labels[iv] ?? String(iv)
}
