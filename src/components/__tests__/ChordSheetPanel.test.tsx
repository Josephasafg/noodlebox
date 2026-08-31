// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChordSheetPanel } from '../ChordSheetPanel'
import type { ChordSheet } from '../../chords/types'

/** Placeholder words: what is under test is the layout, not any song. */
const SHEET: ChordSheet = {
  title: 'שיר לדוגמה',
  artist: 'נגן לדוגמה',
  sourceUrl: 'https://www.tab4u.com/tabs/songs/66169_song.html',
  rtl: true,
  blocks: [
    {
      lines: [
        { kind: 'label', text: 'פתיחה' },
        {
          kind: 'lyrics',
          text: 'מילה אחת ועוד אחת',
          chords: [
            { name: 'A7', column: 0 },
            { name: 'G7', column: 8 },
          ],
        },
        { kind: 'chords', chords: [{ name: 'E', column: 0 }] },
        { kind: 'note', text: 'x4' },
      ],
    },
  ],
  shapes: {
    A7: [{ frets: [null, 0, 2, 0, 2, 0] }],
    G7: [{ frets: [3, 2, 0, 0, 0, 1] }],
    E: [{ frets: [0, 2, 2, 1, 0, 0] }],
  },
}

function draw(sheet: ChordSheet = SHEET, onClose = vi.fn()) {
  render(<ChordSheetPanel sheet={sheet} onClose={onClose} />)
  return onClose
}

afterEach(cleanup)

describe('ChordSheetPanel', () => {
  it('shows the song, the artist, and where it came from', () => {
    draw()
    expect(screen.getByRole('heading', { name: /שיר לדוגמה/ })).toBeInTheDocument()
    expect(screen.getByText('נגן לדוגמה')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'tab4u' })).toHaveAttribute('href', SHEET.sourceUrl)
  })

  it('lays a Hebrew song out right to left', () => {
    draw()
    expect(screen.getByText(/מילה אחת/).closest('[dir="rtl"]')).not.toBeNull()
  })

  it('puts every chord of the song on the sheet', () => {
    draw()
    // Once in the diagram strip, and once over the words or in the run.
    expect(screen.getAllByText('A7')).toHaveLength(2)
    expect(screen.getAllByText('G7')).toHaveLength(2)
    expect(screen.getAllByText('E')).toHaveLength(2)
  })

  it('draws a diagram for each distinct chord', () => {
    draw()
    expect(screen.getByRole('img', { name: 'A7 chord shape' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'G7 chord shape' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'E chord shape' })).toBeInTheDocument()
  })

  it('names a chord it has no fingering for without drawing a box', () => {
    draw({ ...SHEET, shapes: {} })
    expect(screen.queryByRole('img', { name: 'A7 chord shape' })).not.toBeInTheDocument()
    expect(screen.getAllByText('A7').length).toBeGreaterThan(0)
  })

  it('shows section labels and repeat marks', () => {
    draw()
    expect(screen.getByRole('heading', { name: 'פתיחה' })).toBeInTheDocument()
    expect(screen.getByText('x4')).toBeInTheDocument()
  })

  it('closes from its own button', () => {
    const onClose = draw()
    fireEvent.click(screen.getByRole('button', { name: 'Close sheet' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
