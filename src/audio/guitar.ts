import type { FretNote } from '../theory/fretboard'
import { type ResolvedLickNote } from '../theory/licks'

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

export interface ScheduledNote {
  midi: number
  /** Seconds after playback start. */
  offsetSeconds: number
  durationSeconds: number
  velocity: number
  /** Index of the notated note this attack came from. */
  noteIndex: number
}

/**
 * Turn notated notes into the exact attacks to schedule — one per note, at the
 * pitch its printed fret number produces, so what you hear always matches what
 * the tab shows.
 *
 * Bends are notated but not sounded. The soundfont cannot glide pitch, and
 * faking one by retriggering the bent-to pitch would sound a note the tab never
 * printed, which is precisely the mismatch this function exists to prevent.
 */
export function lickSchedule(
  notes: readonly ResolvedLickNote[],
  bpm: number,
  /** Semitones to detune every string by, for tabs written in a lower tuning. */
  semitoneShift = 0,
): ScheduledNote[] {
  const secPerBeat = 60 / bpm
  return notes.map((n, i) => ({
    midi: midiOf(n) + semitoneShift,
    offsetSeconds: n.beat * secPerBeat,
    durationSeconds: Math.max(0.08, n.length * secPerBeat * 1.1),
    // Legato marks are quieter — they are not picked.
    velocity: n.art === 'hammer' || n.art === 'pull' ? 72 : 92,
    noteIndex: n.noteIndex ?? i,
  }))
}

/** Play a lick using its own rhythm rather than a fixed step. */
export async function playLickAudio(
  notes: readonly ResolvedLickNote[],
  bpm: number,
  semitoneShift = 0,
): Promise<ScalePlayback> {
  const guitar = await getInstrument()
  if (context!.state === 'suspended') {
    await context!.resume()
  }

  const schedule = lickSchedule(notes, bpm, semitoneShift)
  const audioStart = context!.currentTime + LOOKAHEAD_S
  const visualStartPerf = performance.now() + LOOKAHEAD_S * 1000
  const stoppers: Array<(time?: number) => void> = []

  for (const s of schedule) {
    const stop = guitar.start({
      note: midiToNoteName(s.midi),
      time: audioStart + s.offsetSeconds,
      duration: s.durationSeconds,
      velocity: s.velocity,
    })
    if (stop) stoppers.push(stop)
  }

  const secPerBeat = 60 / bpm
  const totalBeats = notes.reduce((max, n) => Math.max(max, n.beat + n.length), 0)

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
    durationMs: totalBeats * secPerBeat * 1000,
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
