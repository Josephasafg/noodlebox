// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { NoteEditor } from '../NoteEditor'
import type { ParsedScore, ScoreNote } from '../../tabpdf/types'

/** Two notes on the D string, a bar apart from the third on the G string. */
const NOTES: ScoreNote[] = [
  { measureIndex: 0, stringIdx: 2, fret: 7, ghost: false, beat: 0, length: 1 },
  { measureIndex: 0, stringIdx: 2, fret: 9, ghost: false, beat: 1, length: 1, art: 'hammer' },
  { measureIndex: 0, stringIdx: 3, fret: 5, ghost: false, beat: 2, length: 1 },
]

const SCORE: ParsedScore = {
  title: 'A Tab',
  artist: null,
  bpm: 120,
  beatsPerBar: 4,
  tuningNote: null,
  tuningShift: 0,
  measures: [{ index: 0, pageIndex: 0, systemIndex: 0, startBeat: 0, beats: 4 }],
  notes: NOTES,
  warnings: [],
  pageCount: 1,
  unreadCount: 0,
}

/** A note near the top of the window, with room beneath it. */
const ANCHOR = { top: 100, bottom: 120, left: 200 } as DOMRect

function open(noteIndex: number, score: ParsedScore = SCORE, anchor: DOMRect = ANCHOR) {
  const onChange = vi.fn()
  const onClose = vi.fn()
  render(
    <NoteEditor
      score={score}
      noteIndex={noteIndex}
      anchor={anchor}
      onChange={onChange}
      onClose={onClose}
    />,
  )
  return { onChange, onClose, card: screen.getByRole('dialog') }
}

afterEach(cleanup)

describe('correcting a note', () => {
  it('says which note is being corrected', () => {
    open(1)
    expect(screen.getByText(/Bar 1 · beat 2 · D string/)).toBeInTheDocument()
  })

  it('marks the note as hammered on', () => {
    const { onChange } = open(2)
    fireEvent.click(screen.getByRole('radio', { name: /Hammer-on/ }))

    expect(onChange).toHaveBeenCalledWith(2, { art: 'hammer' })
  })

  it('marks a slide, either way', () => {
    const { onChange } = open(2)
    fireEvent.click(screen.getByRole('radio', { name: /Slide up/ }))
    fireEvent.click(screen.getByRole('radio', { name: /Slide down/ }))

    expect(onChange).toHaveBeenNthCalledWith(1, 2, { art: 'slide-up' })
    expect(onChange).toHaveBeenNthCalledWith(2, 2, { art: 'slide-down' })
  })

  /** A mark read from a video that was never printed has to come off again. */
  it('takes a mark off a note that is only picked', () => {
    const { onChange } = open(1)
    fireEvent.click(screen.getByRole('radio', { name: /Picked/ }))

    expect(onChange).toHaveBeenCalledWith(1, { art: null })
  })

  it('shows which mark the note already carries', () => {
    open(1)
    expect(screen.getByRole('radio', { name: /Hammer-on/ })).toBeChecked()
    expect(screen.getByRole('radio', { name: /Picked/ })).not.toBeChecked()
  })

  it('corrects a misread fret', () => {
    const { onChange } = open(0)
    fireEvent.change(screen.getByLabelText('Fret'), { target: { value: '12' } })

    expect(onChange).toHaveBeenCalledWith(0, { fret: 12 })
  })

  it('steps a fret up and down', () => {
    const { onChange } = open(0)
    fireEvent.click(screen.getByLabelText('Up a fret'))
    fireEvent.click(screen.getByLabelText('Down a fret'))

    expect(onChange).toHaveBeenNthCalledWith(1, 0, { fret: 8 })
    expect(onChange).toHaveBeenNthCalledWith(2, 0, { fret: 6 })
  })

  it('will not step below the nut or past the last fret', () => {
    const nut: ParsedScore = { ...SCORE, notes: [{ ...NOTES[0], fret: 0 }] }
    open(0, nut)
    expect(screen.getByLabelText('Down a fret')).toBeDisabled()
  })

  /**
   * The mark is written between two numbers — `7h9` — so which note it joins is
   * as much a part of the edit as the mark itself.
   */
  it('shows how the edit will read on the staff', () => {
    open(1)
    expect(screen.getByText('7h9')).toBeInTheDocument()
  })

  it('reads a note with nothing before it on its string as the number alone', () => {
    open(0)
    expect(screen.getByText('7')).toBeInTheDocument()
  })

  it('closes on Escape', () => {
    const { onClose } = open(0)
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onClose).toHaveBeenCalled()
  })

  it('closes when the click lands somewhere else', () => {
    const { onClose } = open(0)
    fireEvent.mouseDown(document.body)

    expect(onClose).toHaveBeenCalled()
  })

  it('stays open while it is being used', () => {
    const { onClose } = open(0)
    fireEvent.mouseDown(screen.getByLabelText('Fret'))

    expect(onClose).not.toHaveBeenCalled()
  })
})

/**
 * The staff runs the length of the page, so plenty of notes sit at the bottom of
 * the window. Opening downwards from one of those put the card half off screen,
 * with the marks — the whole point of it — below the fold and unreachable.
 */
describe('where the card opens', () => {
  it('opens below a note that has room beneath it', () => {
    const { card } = open(0)
    expect(card.style.top).toBe('128px')
    expect(card.style.bottom).toBe('')
  })

  it('opens upwards from a note at the bottom of the window', () => {
    const low = { top: 720, bottom: 740, left: 200 } as DOMRect
    const { card } = open(0, SCORE, low)

    // Anchored by its bottom edge, just above the note it belongs to.
    expect(card.style.bottom).toBe(`${window.innerHeight - 720 + 8}px`)
    expect(card.style.top).toBe('')
  })

  it('is never taller than the room it has, so nothing is cut off', () => {
    const low = { top: 300, bottom: 320, left: 200 } as DOMRect
    const { card } = open(0, SCORE, low)

    const maxHeight = Number.parseInt(card.style.maxHeight, 10)
    expect(maxHeight).toBeGreaterThan(0)
    expect(Number.parseInt(card.style.top, 10) + maxHeight).toBeLessThanOrEqual(
      window.innerHeight,
    )
  })

  it('keeps clear of the right edge for a note at the end of a row', () => {
    const edge = { top: 100, bottom: 120, left: window.innerWidth - 20 } as DOMRect
    const { card } = open(0, SCORE, edge)

    expect(Number.parseInt(card.style.left, 10)).toBeLessThanOrEqual(window.innerWidth - 260)
  })
})
