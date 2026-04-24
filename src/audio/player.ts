import type { FretNote } from '../theory/fretboard'

const TUNING_MIDI = [40, 45, 50, 55, 59, 64] as const

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

function midiOf(note: FretNote): number {
  return TUNING_MIDI[note.stringIdx] + note.fret
}

function midiToNoteName(midi: number): string {
  const octave = Math.floor(midi / 12) - 1
  const name = NOTE_NAMES[midi % 12]
  return `${name}${octave}`
}

let synth: import('tone').PluckSynth | null = null
let playing = false

export function isPlaying(): boolean {
  return playing
}

export async function playScale(notes: FretNote[], bpm = 200): Promise<void> {
  if (playing || notes.length === 0) return
  playing = true

  try {
    const Tone = await import('tone')
    await Tone.start()

    if (!synth) {
      synth = new Tone.PluckSynth({
        attackNoise: 0.6,
        dampening: 3500,
        resonance: 0.94,
      }).toDestination()
      synth.volume.value = -4
    }

    const uniqueMidis = [...new Set(notes.map(midiOf))].sort((a, b) => a - b)
    const ascending = uniqueMidis.map(midiToNoteName)
    const descending = [...uniqueMidis].reverse().slice(1, -1).map(midiToNoteName)
    const sequence = [...ascending, ...descending, ascending[0]]

    const beatDur = 60 / bpm
    const start = Tone.now() + 0.05
    sequence.forEach((note, i) => {
      synth!.triggerAttack(note, start + i * beatDur)
    })

    await new Promise((resolve) => {
      setTimeout(resolve, sequence.length * beatDur * 1000 + 500)
    })
  } finally {
    playing = false
  }
}
