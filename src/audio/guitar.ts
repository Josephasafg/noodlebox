import type { FretNote } from '../theory/fretboard'

const TUNING_MIDI = [40, 45, 50, 55, 59, 64] as const
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

function midiOf(note: FretNote): number {
  return TUNING_MIDI[note.stringIdx] + note.fret
}

function midiToNoteName(midi: number): string {
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
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
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

export interface ScalePlayback {
  stop: () => void
  durationMs: number
  visualStartPerf: number
}

const LOOKAHEAD_S = 0.08

export async function playScaleAudio(
  sequence: FretNote[],
  stepSeconds = 0.26,
): Promise<ScalePlayback> {
  const guitar = await getInstrument()
  if (context!.state === 'suspended') {
    await context!.resume()
  }

  const audioStart = context!.currentTime + LOOKAHEAD_S
  const visualStartPerf = performance.now() + LOOKAHEAD_S * 1000
  const stoppers: Array<(time?: number) => void> = []

  sequence.forEach((n, i) => {
    const name = midiToNoteName(midiOf(n))
    const stop = guitar.start({
      note: name,
      time: audioStart + i * stepSeconds,
      duration: stepSeconds * 1.2,
      velocity: 90,
    })
    if (stop) stoppers.push(stop)
  })

  const durationMs = sequence.length * stepSeconds * 1000

  return {
    stop: () => {
      const fadeAt = context!.currentTime + 0.02
      stoppers.forEach((s) => {
        try {
          s(fadeAt)
        } catch {
          /* ignore */
        }
      })
    },
    durationMs,
    visualStartPerf,
  }
}

export function preloadGuitar(): void {
  // Best-effort warm-up; safe to call before user gesture because it
  // just starts the fetch. AudioContext creation only happens inside
  // getInstrument when the first click lands.
  if (instrument || loadingPromise) return
  import('smplr').catch(() => {
    /* ignore — will retry on click */
  })
}
