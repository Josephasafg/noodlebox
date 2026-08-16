// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

/**
 * The audio itself needs a sound card and a sample library, neither of which a
 * test has. What matters here is which press reaches the transport, so the voice
 * is a stand-in that records being started and stopped.
 */
const audio = vi.hoisted(() => {
  const stop = vi.fn()
  const start = vi.fn(async () => ({ stop, visualStartPerf: 0, durationMs: 4000 }))
  return { start, stop }
})

vi.mock('../audio/guitar', () => ({
  playScaleAudio: audio.start,
  playLickAudio: audio.start,
  preloadGuitar: vi.fn(),
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

/** Playback starts asynchronously, so the press has to settle before asserting. */
async function press(init: KeyboardEventInit = {}) {
  await act(async () => {
    fireEvent.keyDown(window, { key: ' ', ...init })
  })
}

beforeEach(() => {
  audio.start.mockClear()
  audio.stop.mockClear()
})

afterEach(cleanup)

describe('playing and stopping with Space', () => {
  it('starts the transport', async () => {
    mount()
    await press()

    expect(audio.start).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('Stop playback')).toBeInTheDocument()
  })

  it('stops what is sounding on a second press', async () => {
    mount()
    await press()
    await press()

    expect(audio.stop).toHaveBeenCalled()
    expect(screen.getByLabelText('Play scale')).toBeInTheDocument()
  })

  /** Held down, Space would otherwise restart the scale several times a second. */
  it('ignores the repeats of a held key', async () => {
    mount()
    await press()
    await press({ repeat: true })
    await press({ repeat: true })

    expect(audio.start).toHaveBeenCalledTimes(1)
    expect(audio.stop).not.toHaveBeenCalled()
  })

  /**
   * The browser clicks a focused button on Space by itself. Answering the same
   * press here as well would start the audio and stop it again in one go.
   */
  it('leaves the press to a focused button', async () => {
    mount()
    const pill = screen.getByLabelText('Play scale')
    pill.focus()
    await act(async () => {
      fireEvent.keyDown(pill, { key: ' ' })
    })

    expect(audio.start).not.toHaveBeenCalled()
  })

  it('leaves the press to a field being typed into', async () => {
    mount()
    fireEvent.click(screen.getByLabelText('Tab library'))
    const field = screen.getByLabelText('Import a tab from a link')
    await act(async () => {
      fireEvent.keyDown(field, { key: ' ' })
    })

    expect(audio.start).not.toHaveBeenCalled()
  })

  /** An overlay is in front and holding the keyboard; the app is not. */
  it('does not play from behind an open overlay', async () => {
    mount()
    fireEvent.click(screen.getByLabelText('Tab library'))
    await press()

    expect(audio.start).not.toHaveBeenCalled()
  })
})
