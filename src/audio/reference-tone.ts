// src/audio/reference-tone.ts
// Plays a sustained guitar reference tone for a given target string.
// Reuses the smplr soundfont path established in audio/guitar.ts so we
// don't double-load samples.

import type { TargetString } from '../theory/tuning'

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

function midiToSmplrName(midi: number): string {
  const octave = Math.floor(midi / 12) - 1
  return `${NOTE_NAMES[midi % 12]}${octave}`
}

type Soundfont = {
  context: AudioContext
  loaded: () => Promise<Soundfont>
  start: (opts: {
    note: string
    time?: number
    duration?: number
    velocity?: number
  }) => (time?: number) => void
  stop: () => void
}

let context: AudioContext | null = null
let instrument: Soundfont | null = null
let loadingPromise: Promise<Soundfont> | null = null

async function getInstrument(): Promise<Soundfont> {
  if (instrument) return instrument
  if (loadingPromise) return loadingPromise
  loadingPromise = (async () => {
    if (!context) {
      const AC = window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      context = new AC()
    }
    const { Soundfont: SoundfontCtor } = await import('smplr')
    const guitar = new SoundfontCtor(context, {
      instrument: 'acoustic_guitar_steel',
    }) as unknown as Soundfont
    await guitar.loaded()
    instrument = guitar
    return guitar
  })()
  return loadingPromise
}

export interface ToneHandle {
  stop: () => void
}

export async function playReferenceTone(
  target: TargetString,
  durationSec = 2.4,
): Promise<ToneHandle> {
  const guitar = await getInstrument()
  if (context!.state === 'suspended') {
    await context!.resume()
  }
  const stop = guitar.start({
    note: midiToSmplrName(target.midi),
    time: context!.currentTime + 0.02,
    duration: durationSec,
    velocity: 100,
  })
  return {
    stop: () => {
      try {
        stop?.(context!.currentTime + 0.02)
      } catch {
        /* ignore */
      }
    },
  }
}
