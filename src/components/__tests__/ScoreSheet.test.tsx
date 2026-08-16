// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ScoreSheet } from '../ScoreSheet'
import type { ParsedScore, ScoreNote } from '../../tabpdf/types'

const NOTES: ScoreNote[] = [
  { measureIndex: 0, stringIdx: 2, fret: 7, ghost: false, beat: 0, length: 1 },
  { measureIndex: 0, stringIdx: 2, fret: 9, ghost: false, beat: 1, length: 1, art: 'hammer' },
  { measureIndex: 1, stringIdx: 3, fret: 5, ghost: false, beat: 4, length: 1 },
]

const SCORE: ParsedScore = {
  title: 'A Tab',
  artist: null,
  bpm: 120,
  beatsPerBar: 4,
  tuningNote: null,
  tuningShift: 0,
  measures: [
    { index: 0, pageIndex: 0, systemIndex: 0, startBeat: 0, beats: 4 },
    { index: 1, pageIndex: 0, systemIndex: 0, startBeat: 4, beats: 4 },
  ],
  notes: NOTES,
  warnings: [],
  pageCount: 1,
  unreadCount: 0,
}

function draw() {
  const onPlayFrom = vi.fn()
  const onEditNote = vi.fn()
  render(
    <ScoreSheet
      score={SCORE}
      beat={null}
      activeNotes={[]}
      playingMeasure={null}
      onPlayFrom={onPlayFrom}
      onEditNote={onEditNote}
    />,
  )
  return { onPlayFrom, onEditNote }
}

/** Shapes on the staff carry their own titles, which is how they are reached. */
function shape(title: string): Element {
  return screen.getByText(title).parentElement!
}

afterEach(cleanup)

describe('what a click on the staff does', () => {
  it('plays from a bar that is tapped', () => {
    const { onPlayFrom, onEditNote } = draw()
    fireEvent.click(shape('Play from bar 2'))

    expect(onPlayFrom).toHaveBeenCalledWith(1)
    expect(onEditNote).not.toHaveBeenCalled()
  })

  it('opens the note that is tapped, without playing the bar it sits in', () => {
    const { onPlayFrom, onEditNote } = draw()
    fireEvent.click(shape('Edit bar 1, beat 2, D string'))

    expect(onEditNote).toHaveBeenCalledWith(1, expect.anything())
    expect(onPlayFrom).not.toHaveBeenCalled()
  })

  /** The mark and the number it joins are one note, so either picks it up. */
  it('opens the same note from the mark beside it', () => {
    const { onEditNote } = draw()
    fireEvent.click(shape('Edit the mark on bar 1, beat 2, D string'))

    expect(onEditNote).toHaveBeenCalledWith(1, expect.anything())
  })

  it('opens each note under its own bar, beat and string', () => {
    const { onEditNote } = draw()
    fireEvent.click(shape('Edit bar 1, beat 1, D string'))
    fireEvent.click(shape('Edit bar 2, beat 1, G string'))

    expect(onEditNote).toHaveBeenNthCalledWith(1, 0, expect.anything())
    expect(onEditNote).toHaveBeenNthCalledWith(2, 2, expect.anything())
  })
})
