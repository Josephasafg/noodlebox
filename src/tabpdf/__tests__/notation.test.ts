import { describe, expect, it } from 'vitest'
import { LEGATO_SYMBOL, bendMark, legatoSpans } from '../notation'
import type { Articulation } from '../../theory/licks'
import type { ScoreNote } from '../types'

function note(over: Partial<ScoreNote> = {}): ScoreNote {
  return { measureIndex: 0, stringIdx: 2, fret: 5, ghost: false, beat: 0, length: 1, ...over }
}

/** Render a run of notes the way plain-text tab writes it, for readability. */
function asText(notes: ScoreNote[]): string {
  const spans = legatoSpans(notes)
  return notes
    .map((n, i) => {
      const span = spans.find((s) => s.target === i)
      return `${span?.symbol ?? ''}${n.fret ?? 'x'}`
    })
    .join('')
}

describe('legato symbols', () => {
  it('uses the conventional letters and slashes', () => {
    expect(LEGATO_SYMBOL.hammer).toBe('h')
    expect(LEGATO_SYMBOL.pull).toBe('p')
    expect(LEGATO_SYMBOL['slide-up']).toBe('/')
    expect(LEGATO_SYMBOL['slide-down']).toBe('\\')
  })
})

describe('bendMark', () => {
  it('names the pitch a whole-step bend reaches, as 8b10', () => {
    expect(bendMark(note({ fret: 8, bend: { semitones: 2, direction: 'up' } }))).toBe('b10')
  })

  it('names a half-step bend as 8b9', () => {
    expect(bendMark(note({ fret: 8, bend: { semitones: 1, direction: 'up' } }))).toBe('b9')
  })

  it('names a bend and a half from the fret it starts on', () => {
    expect(bendMark(note({ fret: 7, bend: { semitones: 3, direction: 'up' } }))).toBe('b10')
  })

  it('shows an arrow for a quarter bend, which lands between two frets', () => {
    expect(bendMark(note({ fret: 8, bend: { semitones: 0.5, direction: 'up' } }))).toBe('↑')
  })

  it('shows an arrow when no amount was printed', () => {
    expect(bendMark(note({ fret: 8, bend: { semitones: null, direction: 'up' } }))).toBe('↑')
    expect(bendMark(note({ fret: 8, bend: { semitones: null, direction: 'down' } }))).toBe('↓')
  })

  it('shows an arrow rather than a fret for a released bend', () => {
    expect(bendMark(note({ fret: 8, bend: { semitones: 2, direction: 'down' } }))).toBe('↓')
  })

  it('shows an arrow on a dead note, which has no fret to bend from', () => {
    expect(bendMark(note({ fret: null, bend: { semitones: 2, direction: 'up' } }))).toBe('↑')
  })

  it('leaves an unbent note unmarked', () => {
    expect(bendMark(note())).toBeNull()
  })

  it('writes the amount once, not again on the tie it is held across', () => {
    const held = note({ fret: 8, ghost: true, bend: { semitones: 2, direction: 'up' } })
    expect(bendMark(held)).toBeNull()
  })
})

describe('legatoSpans', () => {
  it('writes a hammer-on as 7h9', () => {
    const notes = [note({ fret: 7, beat: 0 }), note({ fret: 9, beat: 1, art: 'hammer' })]
    expect(asText(notes)).toBe('7h9')
    expect(legatoSpans(notes)).toEqual([{ symbol: 'h', target: 1, source: 0 }])
  })

  it('writes a pull-off as 9p7', () => {
    const notes = [note({ fret: 9, beat: 0 }), note({ fret: 7, beat: 1, art: 'pull' })]
    expect(asText(notes)).toBe('9p7')
  })

  it('writes a slide up as 7/9 and a slide down as 9\\7', () => {
    expect(
      asText([note({ fret: 7, beat: 0 }), note({ fret: 9, beat: 1, art: 'slide-up' })]),
    ).toBe('7/9')
    expect(
      asText([note({ fret: 9, beat: 0 }), note({ fret: 7, beat: 1, art: 'slide-down' })]),
    ).toBe('9\\7')
  })

  it('joins across a bar line, since a slur can straddle one', () => {
    const notes = [
      note({ measureIndex: 0, fret: 7, beat: 3 }),
      note({ measureIndex: 1, fret: 9, beat: 4, art: 'hammer' }),
    ]
    expect(legatoSpans(notes)[0].source).toBe(0)
  })

  it('leaves the source empty when nothing precedes the note on its string', () => {
    const notes = [note({ fret: 9, beat: 0, art: 'slide-up' })]
    expect(legatoSpans(notes)).toEqual([{ symbol: '/', target: 0, source: null }])
  })

  it('joins to the last note on the same string, not the nearest on another', () => {
    const notes = [
      note({ stringIdx: 2, fret: 7, beat: 0 }),
      note({ stringIdx: 4, fret: 5, beat: 0.5 }),
      note({ stringIdx: 2, fret: 9, beat: 1, art: 'hammer' }),
    ]
    expect(legatoSpans(notes)[0].source).toBe(0)
  })

  it('does not reach back to a note a long way behind it', () => {
    const notes = [
      note({ fret: 7, beat: 0 }),
      note({ fret: 9, beat: 40, art: 'hammer' }),
    ]
    expect(legatoSpans(notes)[0].source).toBeNull()
  })

  it('ignores a note struck at the same moment, which cannot be its source', () => {
    const notes = [
      note({ stringIdx: 2, fret: 7, beat: 1 }),
      note({ stringIdx: 2, fret: 9, beat: 1, art: 'hammer' }),
    ]
    expect(legatoSpans(notes)[0].source).toBeNull()
  })

  it('marks a whole run of hammers and pulls', () => {
    const notes = [
      note({ fret: 5, beat: 0 }),
      note({ fret: 7, beat: 0.5, art: 'hammer' }),
      note({ fret: 5, beat: 1, art: 'pull' }),
    ]
    expect(asText(notes)).toBe('5h7p5')
  })

  it('leaves plain notes alone', () => {
    expect(legatoSpans([note(), note({ beat: 1 })])).toEqual([])
  })

  it('skips articulations that have no written symbol', () => {
    const notes = [note({ art: 'bend-full' as Articulation, beat: 1 })]
    expect(legatoSpans(notes)).toEqual([])
  })
})
