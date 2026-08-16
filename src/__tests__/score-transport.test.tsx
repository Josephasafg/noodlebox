// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { ParsedScore } from '../tabpdf/types'
import type { ResolvedLickNote } from '../theory/licks'

/**
 * Where the transport picks a tab up after it has been stopped.
 *
 * The audio is a stand-in that records the notes it was handed, so the bar a
 * press starts from can be read off the first note of the run.
 */
const audio = vi.hoisted(() => {
  const stop = vi.fn()
  const start = vi.fn(async (notes: { beat: number; length: number }[], bpm = 120) => {
    // The run has to last as long as the real one would, so that letting it play
    // out and stopping it partway are different things here as well.
    const beats = notes.reduce((most, n) => Math.max(most, n.beat + n.length), 0)
    return {
      stop,
      visualStartPerf: performance.now(),
      durationMs: Number.isFinite(beats) ? (beats * 60_000) / bpm : 0,
    }
  })
  return { start, stop }
})

/** Eight bars of four beats, one note per bar, fretted with its own bar number. */
const SCORE: ParsedScore = {
  title: 'Eight Bars',
  artist: null,
  bpm: 120,
  beatsPerBar: 4,
  tuningNote: null,
  tuningShift: 0,
  measures: Array.from({ length: 8 }, (_, i) => ({
    index: i,
    pageIndex: 0,
    systemIndex: 0,
    startBeat: i * 4,
    beats: 4,
  })),
  notes: Array.from({ length: 8 }, (_, i) => ({
    measureIndex: i,
    stringIdx: 0,
    fret: i,
    ghost: false,
    beat: i * 4,
    length: 1,
  })),
  warnings: [],
  pageCount: 1,
  unreadCount: 0,
}

vi.mock('../audio/guitar', () => ({
  playScaleAudio: audio.start,
  playLickAudio: audio.start,
  preloadGuitar: vi.fn(),
}))

vi.mock('../hooks/useScoreLibrary', () => ({
  useScoreLibrary: () => ({
    entries: [],
    entry: null,
    score: SCORE,
    status: 'idle',
    error: null,
    progress: null,
    videoJob: null,
    videoReady: null,
    videoNamesShapes: false,
    checkVideoServer: vi.fn(),
    nameShapes: vi.fn(),
    cancelVideo: vi.fn(),
    importFile: vi.fn(),
    importUrl: vi.fn(),
    open: vi.fn(),
    remove: vi.fn(),
    rename: vi.fn(),
    close: vi.fn(),
    setBpm: vi.fn(),
    setTuningShift: vi.fn(),
    setBeatsPerBar: vi.fn(),
    dismissError: vi.fn(),
  }),
}))

// jsdom has no media queries, and the tuner asks for one as it renders.
window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia

const { App } = await import('../App')

function mount() {
  render(
    <MemoryRouter initialEntries={['/a/minor-pentatonic/1']}>
      <Routes>
        <Route path="/:keySlug/:scaleId/:positionIdx" element={<App />} />
      </Routes>
    </MemoryRouter>,
  )
}

async function pressSpace() {
  await act(async () => {
    fireEvent.keyDown(window, { key: ' ' })
  })
}

/** Let the playhead run, in bars. At 120bpm a four-beat bar takes two seconds. */
async function playFor(bars: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(bars * 2000)
  })
}

/**
 * The clickable background of a bar in the sheet. Its title is engraved inside
 * the shape rather than on the `<svg>`, so it is reached through its text.
 */
function bar(n: number): Element {
  const title = screen.getByText(`Play from bar ${n}`)
  return title.parentElement!
}

/** The bar a run started from, read off the fret of its first note. */
function startedAtBar(call: number): number {
  const notes = audio.start.mock.calls[call][0] as unknown as ResolvedLickNote[]
  return notes[0].fret + 1
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  audio.start.mockClear()
  audio.stop.mockClear()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('stopping a tab and picking it up again', () => {
  it('resumes from the bar it was stopped in', async () => {
    mount()
    await pressSpace()
    expect(startedAtBar(0)).toBe(1)

    await playFor(3.5)
    await pressSpace()
    await pressSpace()

    expect(startedAtBar(1)).toBe(4)
  })

  it('stands the tab at the bar it stopped in, so the next press is no surprise', async () => {
    mount()
    await pressSpace()
    await playFor(2.5)
    await pressSpace()

    expect(screen.getByText(/bar 3 of 8/)).toBeInTheDocument()
  })

  /** The checkpoint is where you stopped, not the furthest you ever got. */
  it('moves the checkpoint on to wherever it is stopped next', async () => {
    mount()
    await pressSpace()
    await playFor(4.5)
    await pressSpace()
    await pressSpace()
    await playFor(1.5)
    await pressSpace()

    expect(screen.getByText(/bar 6 of 8/)).toBeInTheDocument()
  })

  it('starts a new checkpoint at a bar that is tapped', async () => {
    mount()
    await pressSpace()
    await playFor(3.5)
    await pressSpace()

    await act(async () => {
      fireEvent.click(bar(2))
    })
    expect(startedAtBar(1)).toBe(2)

    await pressSpace()
    await pressSpace()
    expect(startedAtBar(2)).toBe(2)
  })

  /** Reaching the end of the run is not a stop; the section stays where it was. */
  it('leaves the checkpoint alone when a run finishes on its own', async () => {
    mount()
    await act(async () => {
      fireEvent.click(bar(3))
    })
    await playFor(40)
    await pressSpace()

    expect(startedAtBar(1)).toBe(3)
  })
})
