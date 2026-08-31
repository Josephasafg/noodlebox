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

/**
 * Rhythm is recovered from spacing and snapped to sixteenths, so a figure that
 * was engraved as one tight group — `4p2`, `2h4p2` — comes back as notes a
 * sixteenth or more apart. Drawn on those beats they stand well clear of each
 * other with the mark adrift between them, which is not how tab prints a slur.
 */
describe('how a legato figure is set', () => {
  /** Where a glyph is centred, read off the hit target that covers it. */
  function centre(title: string): number {
    const rect = screen.getByText(title).parentElement!
    return Number(rect.getAttribute('x')) + Number(rect.getAttribute('width')) / 2
  }

  function drawScore(notes: ScoreNote[]) {
    render(
      <ScoreSheet
        score={{ ...SCORE, notes }}
        beat={null}
        activeNotes={[]}
        playingMeasure={null}
        onPlayFrom={vi.fn()}
        onEditNote={vi.fn()}
      />,
    )
  }

  /** `2h4p2`, quantised a whole beat apart in a bar with nothing else in it. */
  const FIGURE: ScoreNote[] = [
    { measureIndex: 0, stringIdx: 2, fret: 2, ghost: false, beat: 0, length: 1 },
    { measureIndex: 0, stringIdx: 2, fret: 4, ghost: false, beat: 1, length: 1, art: 'hammer' },
    { measureIndex: 0, stringIdx: 2, fret: 2, ghost: false, beat: 2, length: 1, art: 'pull' },
  ]

  it('sets the whole figure as one cluster', () => {
    drawScore(FIGURE)
    const first = centre('Edit bar 1, beat 1, D string')
    const second = centre('Edit bar 1, beat 2, D string')
    const third = centre('Edit bar 1, beat 3, D string')

    // Each number just clear of the last, with room for the mark between them.
    expect(second - first).toBe(23)
    expect(third - second).toBe(23)
  })

  it('keeps the mark between the two numbers it joins', () => {
    drawScore(FIGURE)
    const first = centre('Edit bar 1, beat 1, D string')
    const mark = centre('Edit the mark on bar 1, beat 2, D string')
    const second = centre('Edit bar 1, beat 2, D string')

    expect(mark).toBeGreaterThan(first)
    expect(mark).toBeLessThan(second)
  })

  it('leaves notes that are not slurred together on their own beats', () => {
    drawScore(FIGURE.map((n) => ({ ...n, art: undefined })))
    const first = centre('Edit bar 1, beat 1, D string')
    const second = centre('Edit bar 1, beat 2, D string')

    expect(second - first).toBeGreaterThan(23)
  })

  /** A note struck with others belongs in their column, slur or no slur. */
  it('leaves a chord voice in its column', () => {
    const chord: ScoreNote[] = [
      ...FIGURE.slice(0, 2),
      { measureIndex: 0, stringIdx: 1, fret: 5, ghost: false, beat: 1, length: 1 },
    ]
    drawScore(chord)

    expect(centre('Edit bar 1, beat 2, D string')).toBe(
      centre('Edit bar 1, beat 2, A string'),
    )
  })

  /** A slur out of a note two beats back is not one gesture to be clustered. */
  it('leaves a note far from what it is slurred out of where its beat puts it', () => {
    const far: ScoreNote[] = [
      { measureIndex: 0, stringIdx: 2, fret: 2, ghost: false, beat: 0, length: 1 },
      { measureIndex: 0, stringIdx: 2, fret: 4, ghost: false, beat: 3, length: 1, art: 'hammer' },
    ]
    drawScore(far)

    const gap = centre('Edit bar 1, beat 4, D string') - centre('Edit bar 1, beat 1, D string')
    expect(gap).toBeGreaterThan(23)
  })
})
