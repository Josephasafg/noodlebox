export type PitchClass = number

export const PITCH_NAMES_SHARP = [
  'C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B',
] as const

export const PITCH_NAMES_FLAT = [
  'C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B',
] as const

export const CHROMATIC_KEYS: readonly PitchClass[] = [
  9, 10, 11, 0, 1, 2, 3, 4, 5, 6, 7, 8,
] as const

export function mod12(n: number): PitchClass {
  return ((n % 12) + 12) % 12
}

export function noteName(pc: PitchClass, spelling: 'sharp' | 'flat' = 'sharp'): string {
  const names = spelling === 'sharp' ? PITCH_NAMES_SHARP : PITCH_NAMES_FLAT
  return names[mod12(pc)]
}

const NAME_TO_PC: Record<string, PitchClass> = {
  c: 0, 'c#': 1, 'c♯': 1, db: 1, 'd♭': 1,
  d: 2, 'd#': 3, 'd♯': 3, eb: 3, 'e♭': 3,
  e: 4, f: 5, 'f#': 6, 'f♯': 6, gb: 6, 'g♭': 6,
  g: 7, 'g#': 8, 'g♯': 8, ab: 8, 'a♭': 8,
  a: 9, 'a#': 10, 'a♯': 10, bb: 10, 'b♭': 10,
  b: 11,
}

export function pcFromName(name: string): PitchClass | null {
  const key = name.trim().toLowerCase().replace('-sharp', '#').replace('-flat', 'b')
  return NAME_TO_PC[key] ?? null
}

export function pcToSlug(pc: PitchClass): string {
  const name = PITCH_NAMES_SHARP[mod12(pc)]
  return name.replace('♯', '-sharp').toLowerCase()
}

export function transpose(pc: PitchClass, semitones: number): PitchClass {
  return mod12(pc + semitones)
}
