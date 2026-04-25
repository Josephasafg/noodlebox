// src/theory/tuning.ts
// Tuning definitions + helpers used by the Tuner.

import type { PitchClass } from './notes'

export interface TargetString {
  /** Display name like "E", "A♯", "D" */
  name: string
  /** Pitch class 0..11 */
  pc: PitchClass
  /** MIDI note number (e.g. low E2 = 40) */
  midi: number
  /** Frequency in Hz at A=440 reference */
  freq: number
}

export interface TuningDef {
  id: string
  displayName: string
  /** Strings ordered low → high (string 1 = low E in standard) */
  strings: TargetString[]
}

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'] as const

export function midiToFreq(midi: number, refA = 440): number {
  return refA * Math.pow(2, (midi - 69) / 12)
}

export function freqToMidiFloat(freq: number, refA = 440): number {
  return 12 * Math.log2(freq / refA) + 69
}

function s(midi: number): TargetString {
  return {
    midi,
    pc: ((midi % 12) + 12) % 12 as PitchClass,
    name: NOTE_NAMES[((midi % 12) + 12) % 12],
    freq: midiToFreq(midi),
  }
}

// MIDI reference: E2=40, A2=45, D3=50, G3=55, B3=59, E4=64
export const TUNINGS: TuningDef[] = [
  { id: 'standard', displayName: 'Standard',     strings: [s(40), s(45), s(50), s(55), s(59), s(64)] },
  { id: 'drop-d',   displayName: 'Drop D',       strings: [s(38), s(45), s(50), s(55), s(59), s(64)] },
  { id: 'half-flat',displayName: 'Half-step ♭',  strings: [s(39), s(44), s(49), s(54), s(58), s(63)] },
  { id: 'open-g',   displayName: 'Open G',       strings: [s(38), s(43), s(50), s(55), s(59), s(62)] },
  { id: 'open-d',   displayName: 'Open D',       strings: [s(38), s(45), s(50), s(54), s(57), s(62)] },
  { id: 'dadgad',   displayName: 'DADGAD',       strings: [s(38), s(45), s(50), s(55), s(57), s(62)] },
]

export function tuningById(id: string): TuningDef {
  return TUNINGS.find((t) => t.id === id) ?? TUNINGS[0]
}

/**
 * Find which target string in the tuning is closest to the detected
 * frequency. Returns the index plus the cents offset (positive = sharp).
 */
export function nearestString(
  freq: number,
  tuning: TuningDef,
): { index: number; cents: number; target: TargetString } {
  const midiF = freqToMidiFloat(freq)
  let best = 0
  let bestDist = Infinity
  for (let i = 0; i < tuning.strings.length; i++) {
    const dist = Math.abs(midiF - tuning.strings[i].midi)
    if (dist < bestDist) {
      best = i
      bestDist = dist
    }
  }
  const target = tuning.strings[best]
  const cents = (midiF - target.midi) * 100
  return { index: best, cents, target }
}
