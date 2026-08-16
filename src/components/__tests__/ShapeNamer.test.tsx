// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ShapeNamer } from '../ShapeNamer'
import type { VideoJob, VideoShape } from '../../tabpdf/videoServer'

const PNG = 'aGVsbG8='

function shape(over: Partial<VideoShape> = {}): VideoShape {
  return {
    index: 0,
    count: 10,
    png: PNG,
    label: null,
    remembered: false,
    suggested: false,
    ...over,
  }
}

function job(shapes: VideoShape[]): VideoJob {
  return {
    id: 'j1',
    state: 'naming',
    stage: 'naming',
    progress: null,
    title: 'A Lesson',
    error: null,
    systems: 29,
    staves: 29,
    shapeCount: shapes.length,
    rememberedCount: shapes.filter((s) => s.remembered).length,
    autoNamedCount: shapes.filter((s) => s.suggested).length,
    unresolvedCount: shapes.filter((s) => s.label === null).length,
    shapes,
    pages: null,
    unreadCount: null,
    silentTechniqueCount: null,
    splitRunCount: null,
  }
}

function open(shapes: VideoShape[], busy = false) {
  const onSubmit = vi.fn()
  const onCancel = vi.fn()
  render(<ShapeNamer job={job(shapes)} busy={busy} onSubmit={onSubmit} onCancel={onCancel} />)
  return { onSubmit, onCancel }
}

function boxFor(index: number) {
  return screen.getByLabelText(new RegExp(`Name for shape ${index}\\b`))
}

afterEach(cleanup)

describe('naming the shapes found in a video', () => {
  it('shows a picture of each shape and how often it occurs', () => {
    open([shape({ index: 0, count: 53 }), shape({ index: 1, count: 4 })])
    expect(screen.getAllByRole('img')).toHaveLength(2)
    expect(screen.getByText('×53')).toBeInTheDocument()
  })

  it('pre-fills a name carried over from an earlier video', () => {
    open([shape({ index: 0, label: '7', remembered: true })])
    expect((boxFor(0) as HTMLInputElement).value).toBe('7')
  })

  it('accepts a fret number, a muted note, and a ghost note bracket', () => {
    open([shape({ index: 0 })])
    const box = boxFor(0) as HTMLInputElement
    for (const value of ['7', '12', 'x', '(']) {
      fireEvent.change(box, { target: { value } })
      expect(box.value).toBe(value)
    }
  })

  it('accepts a technique name, including every state passed through typing it', () => {
    open([shape({ index: 0 })])
    const box = boxFor(0) as HTMLInputElement
    // Typing "12p10" passes through each prefix, and each must be allowed or
    // the full name could never be entered at all.
    for (const value of ['1', '12', '12p', '12p1', '12p10']) {
      fireEvent.change(box, { target: { value } })
      expect(box.value).toBe(value)
    }
    for (const value of ['4h6', '12-', '-12', '-', '~', '4~', '~4', '12b', 'b']) {
      fireEvent.change(box, { target: { value } })
      expect(box.value).toBe(value)
    }
  })

  it('refuses a name that could not be printed on a tab staff', () => {
    open([shape({ index: 0 })])
    const box = boxFor(0) as HTMLInputElement
    fireEvent.change(box, { target: { value: '7' } })
    // A letter that is not `x` is not something a fret number is spelled with, and
    // letting it through would put a wrong note everywhere that shape occurs.
    fireEvent.change(box, { target: { value: 'q' } })
    expect(box.value).toBe('7')
  })

  it('says how much of the notation the names cover, so naming can stop', () => {
    // The tail is long — mostly slur and beam fragments — so the useful signal is
    // the share of marks accounted for, not the number of shapes left.
    open([shape({ index: 0, count: 75 }), shape({ index: 1, count: 25 })])
    fireEvent.change(boxFor(0), { target: { value: '7' } })
    expect(screen.getByText(/75% of the notation/)).toBeInTheDocument()
    fireEvent.change(boxFor(1), { target: { value: '5' } })
    expect(screen.getByText(/100% of the notation/)).toBeInTheDocument()
  })

  it('counts a remembered name towards the coverage straight away', () => {
    open([shape({ index: 0, count: 90, label: '7', remembered: true }), shape({ index: 1, count: 10 })])
    expect(screen.getByText(/90% of the notation/)).toBeInTheDocument()
  })

  it('fills in what a model read, and says it has not been checked', () => {
    // A machine's reading and a name someone confirmed must not look alike: the
    // whole point of showing this screen is that these are the ones to look at.
    open([shape({ index: 0, label: '7', suggested: true })])
    expect((boxFor(0) as HTMLInputElement).value).toBe('7')
    expect(screen.getByTitle(/read automatically/i)).toBeInTheDocument()
    expect(screen.getByText(/nobody has checked them/i)).toBeInTheDocument()
  })

  it('says nothing about automatic reading when there was none', () => {
    open([shape({ index: 0, label: '7', remembered: true })])
    expect(screen.queryByText(/nobody has checked them/i)).not.toBeInTheDocument()
  })

  it('will not build a tab with nothing named', () => {
    open([shape({ index: 0 })])
    expect(screen.getByRole('button', { name: /Build the tab/ })).toBeDisabled()
  })

  it('hands over only what was typed, leaving the rest to be reported unread', () => {
    const { onSubmit } = open([shape({ index: 0 }), shape({ index: 1 })])
    fireEvent.change(boxFor(0), { target: { value: '7' } })
    fireEvent.click(screen.getByRole('button', { name: /Build the tab/ }))
    expect(onSubmit).toHaveBeenCalledWith({ '0': '7' })
  })

  it('lets an extraction be walked away from', () => {
    const { onCancel } = open([shape({ index: 0 })])
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('does not accept more typing while the tab is being built', () => {
    open([shape({ index: 0, label: '7' })], true)
    expect(boxFor(0)).toBeDisabled()
    expect(screen.getByRole('button', { name: /Building/ })).toBeDisabled()
  })
})
