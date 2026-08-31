import { describe, expect, it } from 'vitest'
import { isStaffLine, scoreFromAscii } from '../ascii'

const META = { title: 'A Song', artist: 'A Player' }

/** One staff, six strings, as a chord site prints it. */
function staff(...strings: string[]) {
  return { strings }
}

function notesOf(score: ReturnType<typeof scoreFromAscii>, measureIndex: number) {
  return (score?.notes ?? [])
    .filter((n) => n.measureIndex === measureIndex)
    .map((n) => ({
      string: n.stringIdx,
      fret: n.fret,
      beat: Number((n.beat - measureIndex * (score?.beatsPerBar ?? 4)).toFixed(2)),
      ...(n.art ? { art: n.art } : {}),
      ...(n.bend ? { bend: n.bend } : {}),
      ...(n.ghost ? { ghost: true } : {}),
    }))
}

describe('recognising a staff line', () => {
  it('accepts the labels chord sites print', () => {
    expect(isStaffLine('e|----5----|')).toBe(true)
    expect(isStaffLine('E|----5----|')).toBe(true)
    expect(isStaffLine('Bb|---5----|')).toBe(true)
    expect(isStaffLine('|-------5-|')).toBe(true)
  })

  it('rejects words, headings and blank lines', () => {
    expect(isStaffLine('a line of words here')).toBe(false)
    expect(isStaffLine('[Intro]')).toBe(false)
    expect(isStaffLine('')).toBe(false)
    // A stray pipe in prose is not a staff — a staff is mostly dashes.
    expect(isStaffLine('D|verse two starts about here')).toBe(false)
  })
})

describe('building a score from plain-text tab', () => {
  it('reads frets onto the strings the app counts from the low E', () => {
    const score = scoreFromAscii(
      [
        staff(
          'e|-0--------------|',
          'B|----1-----------|',
          'G|-------2--------|',
          'D|----------3-----|',
          'A|-------------4--|',
          'E|-5--------------|',
        ),
      ],
      META,
    )
    expect(score).not.toBeNull()
    expect(notesOf(score, 0)).toEqual([
      // The top line is the high E, which is string 5; the bottom is string 0.
      // Both sit in the first column, so both fall on the downbeat.
      { string: 5, fret: 0, beat: 0 },
      { string: 0, fret: 5, beat: 0 },
      { string: 4, fret: 1, beat: 0.75 },
      { string: 3, fret: 2, beat: 1.5 },
      { string: 2, fret: 3, beat: 2.5 },
      { string: 1, fret: 4, beat: 3.25 },
    ])
  })

  it('keeps two-digit frets whole', () => {
    const score = scoreFromAscii(
      [staff('e|-12----15--|', 'B|-----------|', 'G|-----------|', 'D|-----------|', 'A|-----------|', 'E|-----------|')],
      META,
    )
    expect(notesOf(score, 0).map((n) => n.fret)).toEqual([12, 15])
  })

  it('takes the bar lines the tabber printed as the bars', () => {
    const score = scoreFromAscii(
      [
        staff(
          'e|-5-|-7-|-9-|',
          'B|---|---|---|',
          'G|---|---|---|',
          'D|---|---|---|',
          'A|---|---|---|',
          'E|---|---|---|',
        ),
      ],
      META,
    )
    expect(score?.measures).toHaveLength(3)
    expect(score?.measures.map((m) => m.startBeat)).toEqual([0, 4, 8])
    // The column after a bar line is breathing room, so this is the downbeat of
    // its own bar rather than a sixteenth into it.
    expect(notesOf(score, 1)).toEqual([{ string: 5, fret: 7, beat: 0 }])
  })

  it('cuts an unbarred run into bars so it stays readable', () => {
    // Sixty-four columns with no bar line is four bars of 4/4, not one bar
    // holding every note on the first beat.
    const long = `e|${'-'.repeat(64)}|`
    const score = scoreFromAscii(
      [staff(long, long, long, long, long, `E|${'-5'.repeat(32)}|`)],
      META,
    )
    expect(score?.measures).toHaveLength(4)
  })

  it('fits inferred bars to the notes, not to the padding', () => {
    // Tabs are padded out with dashes so every staff is the same width. Reading
    // that padding as music would add silent bars at the end of the staff, which
    // is what makes a tab look like its notes have drifted far apart.
    const padded = `e|-5-7-5-7${'-'.repeat(55)}|`
    const rest = `B|${'-'.repeat(63)}|`
    expect(padded).toHaveLength(rest.length)
    const score = scoreFromAscii([staff(padded, rest, rest, rest, rest, rest)], META)
    expect(score?.measures).toHaveLength(1)
    // Four notes two columns apart are four beats of one bar, not the opening
    // sixteenth of a staff that is mostly silence.
    expect(notesOf(score, 0).map((n) => n.beat)).toEqual([0, 1, 2, 3])
  })

  it('keeps a silent bar that the notes actually straddle', () => {
    // A gap between two notes is a rest and belongs in the score; only padding
    // at the edges is dropped.
    const long = `e|-5${'-'.repeat(30)}5-|`
    const rest = `B|${'-'.repeat(34)}|`
    const score = scoreFromAscii([staff(long, rest, rest, rest, rest, rest)], META)
    expect(score?.measures).toHaveLength(2)
    expect(score?.notes.map((n) => n.measureIndex)).toEqual([0, 1])
  })

  it('groups notes struck together into one chord', () => {
    const score = scoreFromAscii(
      [
        staff(
          'e|-0--|',
          'B|-1--|',
          'G|-0--|',
          'D|-2--|',
          'A|-3--|',
          'E|----|',
        ),
      ],
      META,
    )
    const beats = new Set(notesOf(score, 0).map((n) => n.beat))
    expect(beats.size).toBe(1)
    expect(notesOf(score, 0)).toHaveLength(5)
  })

  it('lines up a two-digit fret with a single-digit one beside it', () => {
    // Tabbers align these by the right-hand digit, so the columns differ by one
    // and the two are still one chord.
    const score = scoreFromAscii(
      [
        staff(
          'e|-10-|',
          'B|--9-|',
          'G|----|',
          'D|----|',
          'A|----|',
          'E|----|',
        ),
      ],
      META,
    )
    const beats = new Set(notesOf(score, 0).map((n) => n.beat))
    expect(beats.size).toBe(1)
  })

  it('marks the note a slur or slide leads into', () => {
    const score = scoreFromAscii(
      [
        staff(
          'e|-5h7-9p7-|',
          'B|---------|',
          'G|---------|',
          'D|---------|',
          'A|---------|',
          'E|---------|',
        ),
      ],
      META,
    )
    expect(notesOf(score, 0).map((n) => [n.fret, n.art])).toEqual([
      [5, undefined],
      [7, 'hammer'],
      [9, undefined],
      [7, 'pull'],
    ])
  })

  it('reads a slide written without a direction from its two frets', () => {
    const score = scoreFromAscii(
      [
        staff(
          'e|-4s5-7s5-|',
          'B|---------|',
          'G|---------|',
          'D|---------|',
          'A|---------|',
          'E|---------|',
        ),
      ],
      META,
    )
    expect(notesOf(score, 0).map((n) => n.art)).toEqual([
      undefined,
      'slide-up',
      undefined,
      'slide-down',
    ])
  })

  it('folds a bend target into the note that is struck', () => {
    // `15b17` is one note, pushed two semitones — not a note at 15 and a note
    // at 17.
    const score = scoreFromAscii(
      [
        staff(
          'e|-15b17-|',
          'B|-------|',
          'G|-------|',
          'D|-------|',
          'A|-------|',
          'E|-------|',
        ),
      ],
      META,
    )
    expect(notesOf(score, 0)).toEqual([
      { string: 5, fret: 15, beat: 0, bend: { semitones: 2, direction: 'up' } },
    ])
    expect(notesOf(score, 0)).toHaveLength(1)
  })

  it('reads a bend with no target as a bend of unknown depth', () => {
    const score = scoreFromAscii(
      [
        staff('e|-15^-|', 'B|-----|', 'G|-----|', 'D|-----|', 'A|-----|', 'E|-----|'),
      ],
      META,
    )
    expect(notesOf(score, 0)[0].bend).toEqual({ semitones: null, direction: 'up' })
  })

  it('reads a held fret in any bracket the tabber reached for', () => {
    const score = scoreFromAscii(
      [
        staff(
          'e|-(5)-[7]-([9])-|',
          'B|---------------|',
          'G|---------------|',
          'D|---------------|',
          'A|---------------|',
          'E|---------------|',
        ),
      ],
      META,
    )
    expect(notesOf(score, 0).map((n) => [n.fret, n.ghost])).toEqual([
      [5, true],
      [7, true],
      [9, true],
    ])
  })

  it('reads a dead note as struck with no fret', () => {
    const score = scoreFromAscii(
      [staff('e|-x-|', 'B|---|', 'G|---|', 'D|---|', 'A|---|', 'E|---|')],
      META,
    )
    expect(notesOf(score, 0)).toEqual([{ string: 5, fret: null, beat: 0 }])
  })

  it('puts vibrato on the note it is played on, not the one after', () => {
    const score = scoreFromAscii(
      [staff('e|-5~-7-|', 'B|------|', 'G|------|', 'D|------|', 'A|------|', 'E|------|')],
      META,
    )
    expect(notesOf(score, 0).map((n) => [n.fret, n.art])).toEqual([
      [5, 'vibrato'],
      [7, undefined],
    ])
  })

  it('treats padding and repeat marks as padding, not as notation', () => {
    // An em dash is a dash, and the `o` of a repeat bracket is not a note. Were
    // an undecoded `&mdash;` to reach here its `s` and `h` would read as a
    // slide and a hammer-on, inventing articulations the tab never had.
    const score = scoreFromAscii(
      [
        staff(
          'e|o-5—-—-7-|',
          'B|---------|',
          'G|---------|',
          'D|---------|',
          'A|---------|',
          'E|---------|',
        ),
      ],
      META,
    )
    expect(notesOf(score, 0).map((n) => [n.fret, n.art])).toEqual([
      [5, undefined],
      [7, undefined],
    ])
    expect(score?.unreadCount).toBe(0)
  })

  it('counts marks it could not read rather than guessing at them', () => {
    const score = scoreFromAscii(
      [staff('e|-5-?-@-|', 'B|-------|', 'G|-------|', 'D|-------|', 'A|-------|', 'E|-------|')],
      META,
    )
    expect(score?.unreadCount).toBe(2)
    expect(score?.warnings.some((w) => /could not be read/.test(w))).toBe(true)
  })

  it('says that the timing was inferred, since plain text carries no rhythm', () => {
    const score = scoreFromAscii(
      [staff('e|-5-|', 'B|---|', 'G|---|', 'D|---|', 'A|---|', 'E|---|')],
      META,
    )
    expect(score?.warnings[0]).toMatch(/no rhythm/)
  })

  it('names the first bar of each staff with its section', () => {
    const score = scoreFromAscii(
      [
        { marker: 'Intro', strings: ['e|-5-|-7-|', 'B|---|---|', 'G|---|---|', 'D|---|---|', 'A|---|---|', 'E|---|---|'] },
        { marker: 'Solo', strings: ['e|-9-|', 'B|---|', 'G|---|', 'D|---|', 'A|---|', 'E|---|'] },
      ],
      META,
    )
    expect(score?.measures.map((m) => m.marker)).toEqual(['Intro', undefined, 'Solo'])
    // Each staff is its own system, which is how the sheet lays rows out.
    expect(score?.measures.map((m) => m.systemIndex)).toEqual([0, 0, 1])
  })

  it('carries the title, artist and tuning it was given', () => {
    const score = scoreFromAscii(
      [staff('e|-5-|', 'B|---|', 'G|---|', 'D|---|', 'A|---|', 'E|---|')],
      { ...META, tuningNote: 'E A D G B E' },
    )
    expect(score?.title).toBe('A Song')
    expect(score?.artist).toBe('A Player')
    expect(score?.tuningNote).toBe('E A D G B E')
    expect(score?.beatsPerBar).toBe(4)
  })

  it('re-cuts the same staff when asked for a different bar length', () => {
    const strings = ['e|-5-|-7-|', 'B|---|---|', 'G|---|---|', 'D|---|---|', 'A|---|---|', 'E|---|---|']
    const waltz = scoreFromAscii([staff(...strings)], { ...META, beatsPerBar: 3 })
    expect(waltz?.beatsPerBar).toBe(3)
    expect(waltz?.measures.map((m) => m.startBeat)).toEqual([0, 3])
  })

  it('skips a staff of nothing but rests instead of adding empty bars', () => {
    const empty = 'e|--------|'
    const score = scoreFromAscii(
      [
        staff(empty, empty, empty, empty, empty, empty),
        staff('e|-5------|', empty, empty, empty, empty, empty),
      ],
      META,
    )
    expect(score?.measures).toHaveLength(1)
  })

  it('finds nothing playable in a page of prose', () => {
    expect(scoreFromAscii([], META)).toBeNull()
    expect(scoreFromAscii([staff('not', 'a', 'staff', 'at', 'all', 'here')], META)).toBeNull()
  })
})
