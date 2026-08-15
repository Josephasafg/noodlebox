import type { Articulation, LickNote } from '../../theory/licks'

/** `[string, offset]` or `[string, offset, articulation]`. */
export type Step = [number, number] | [number, number, Articulation]

/** `[string, offset, lengthInBeats]` or with a trailing articulation. */
export type Beat = [number, number, number] | [number, number, number, Articulation]

/** A run of evenly spaced notes — scale runs, sequences, repeating licks. */
export function evenRun(step: number, steps: readonly Step[], startBeat = 0): LickNote[] {
  return steps.map(([string, offset, art], i) => ({
    string,
    offset,
    beat: startBeat + i * step,
    length: step,
    art,
  }))
}

/** A melodic line with mixed note lengths; each note starts where the last ended. */
export function phrase(beats: readonly Beat[], startBeat = 0): LickNote[] {
  let beat = startBeat
  return beats.map(([string, offset, length, art]) => {
    const note = { string, offset, beat, length, art }
    beat += length
    return note
  })
}

/** Notes struck together — double stops, unison bends, chord stabs. */
export function stack(beat: number, length: number, steps: readonly Step[]): LickNote[] {
  return steps.map(([string, offset, art]) => ({ string, offset, beat, length, art }))
}
