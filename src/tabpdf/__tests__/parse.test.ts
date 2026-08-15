import { describe, expect, it } from 'vitest'
import {
  bendSemitones,
  calibrateLineOffset,
  findBarlines,
  findTabStaves,
  joinTextLines,
  parseScore,
  tuningShiftFrom,
} from '../parse'
import type { TabLineSeg, TabPagePrimitives, TabTextItem } from '../types'

// A stand-in for a page of engraved tab. Numbers mirror the proportions of a
// real letter-size tab PDF: a five-line notation staff over a six-line tab
// staff, with fret numbers sitting a little under two thirds of a glyph below
// each line.
const PAGE_W = 612
const PAGE_H = 792
const X0 = 40
const X1 = 560
const NOTATION_TOP = 60
const NOTATION_SPACING = 4.3
const TAB_TOP = 100
const SPACING = 6.5
const TAB_BOTTOM = TAB_TOP + SPACING * 5
/** How far a fret number's baseline sits below the line it belongs to. */
const BASELINE_DROP = 2.9
const FONT = 8

function hline(y: number, x0 = X0, x1 = X1): TabLineSeg {
  return { x0, y0: y, x1, y1: y }
}

function vline(x: number, y0: number, y1: number): TabLineSeg {
  return { x0: x, y0, x1: x, y1 }
}

function staff(top: number, spacing: number, count: number, x0 = X0, x1 = X1): TabLineSeg[] {
  return Array.from({ length: count }, (_, i) => hline(top + i * spacing, x0, x1))
}

/** A fret number on `line` (0 = top string) centred at `cx`. */
function fret(line: number, cx: number, label: string, fontSize = FONT): TabTextItem {
  const width = label.length * fontSize * 0.55
  return {
    str: label,
    x: cx - width / 2,
    y: TAB_TOP + line * SPACING + BASELINE_DROP,
    fontSize,
    width,
  }
}

/**
 * A bend amount printed over the staff. Engravers set the amount above the
 * arrow, whose foot is the middle of the note, so its left edge lands on `cx`.
 */
function over(cx: number, label: string): TabTextItem {
  return {
    str: label,
    x: cx,
    y: TAB_TOP - SPACING * 2.2,
    fontSize: 7,
    width: label.length * 3.9,
  }
}

/** A legato letter printed under the staff at `cx`. */
function under(cx: number, label: string): TabTextItem {
  const width = label.length * 4
  return { str: label, x: cx - width / 2, y: TAB_BOTTOM + SPACING * 1.5, fontSize: 7, width }
}

interface PageOpts {
  barlines?: number[]
  texts?: TabTextItem[]
  extraSegments?: TabLineSeg[]
  withNotation?: boolean
}

function page({
  barlines = [213, 386],
  texts = [],
  extraSegments = [],
  withNotation = true,
}: PageOpts = {}): TabPagePrimitives {
  return {
    pageIndex: 0,
    width: PAGE_W,
    height: PAGE_H,
    segments: [
      ...(withNotation ? staff(NOTATION_TOP, NOTATION_SPACING, 5) : []),
      ...staff(TAB_TOP, SPACING, 6),
      ...barlines.map((x) => vline(x, TAB_TOP, TAB_BOTTOM)),
      ...extraSegments,
    ],
    texts,
  }
}

describe('findTabStaves', () => {
  it('finds the six-line staff and ignores the five-line one', () => {
    const staves = findTabStaves(page())
    expect(staves).toHaveLength(1)
    expect(staves[0].top).toBeCloseTo(TAB_TOP)
    expect(staves[0].bottom).toBeCloseTo(TAB_BOTTOM)
    expect(staves[0].spacing).toBeCloseTo(SPACING)
  })

  it('ignores a rule that happens to sit one string-space above a staff', () => {
    // Same y rhythm as the staff but a different width, so it is not part of it.
    const stray = hline(TAB_TOP - SPACING, 120, 300)
    const staves = findTabStaves(page({ extraSegments: [stray] }))
    expect(staves).toHaveLength(1)
    expect(staves[0].top).toBeCloseTo(TAB_TOP)
  })

  it('ignores a page border as wide as the sheet', () => {
    const border: TabLineSeg = { x0: 0, y0: 400, x1: PAGE_W, y1: 400 }
    expect(findTabStaves(page({ extraSegments: [border] }))).toHaveLength(1)
  })

  it('finds several staves on one page', () => {
    const second = staff(400, SPACING, 6)
    expect(findTabStaves(page({ extraSegments: second }))).toHaveLength(2)
  })

  it('reports no staff for a page with no tab on it', () => {
    const bare: TabPagePrimitives = {
      pageIndex: 0,
      width: PAGE_W,
      height: PAGE_H,
      segments: staff(NOTATION_TOP, NOTATION_SPACING, 5),
      texts: [],
    }
    expect(findTabStaves(bare)).toEqual([])
  })
})

describe('findBarlines', () => {
  it('returns the staff edges along with the bar lines between them', () => {
    const p = page()
    const [box] = findTabStaves(p)
    expect(findBarlines(p, box)).toEqual([X0, 213, 386, X1])
  })

  it('merges the strokes of a double bar into one boundary', () => {
    const p = page({ barlines: [213, 215.5, 386] })
    const [box] = findTabStaves(p)
    expect(findBarlines(p, box)).toHaveLength(4)
  })

  it('ignores a stem that does not span the staff', () => {
    const stem = vline(300, TAB_TOP + SPACING * 2, TAB_BOTTOM)
    const p = page({ extraSegments: [stem] })
    const [box] = findTabStaves(p)
    expect(findBarlines(p, box)).toEqual([X0, 213, 386, X1])
  })
})

describe('calibrateLineOffset', () => {
  it('recovers the common offset of the fret numbers', () => {
    expect(calibrateLineOffset([0.45, 0.44, 0.46])).toBeCloseTo(0.45, 2)
  })

  it('averages around the wrap point rather than through the middle', () => {
    // 0.99 and 0.01 are neighbours, so the mean is 0, not 0.5.
    const offset = calibrateLineOffset([0.99, 0.01])
    expect(Math.min(offset, 1 - offset)).toBeLessThan(0.05)
  })

  it('returns zero when there is nothing to calibrate from', () => {
    expect(calibrateLineOffset([])).toBe(0)
  })
})

describe('joinTextLines', () => {
  it('rejoins a title stored as separate words', () => {
    const items: TabTextItem[] = [
      { str: 'BOLD', x: 100, y: 50, fontSize: 20, width: 40 },
      { str: 'AS', x: 143, y: 50, fontSize: 20, width: 18 },
      { str: 'LOVE', x: 164, y: 50, fontSize: 20, width: 42 },
    ]
    expect(joinTextLines(items)[0].str).toBe('BOLD AS LOVE')
  })

  it('keeps runs far apart on the same baseline separate', () => {
    const items: TabTextItem[] = [
      { str: 'left', x: 40, y: 50, fontSize: 8, width: 16 },
      { str: 'right', x: 500, y: 50, fontSize: 8, width: 18 },
    ]
    expect(joinTextLines(items).map((l) => l.str)).toEqual(['left', 'right'])
  })

  it('keeps different baselines apart', () => {
    const items: TabTextItem[] = [
      { str: 'one', x: 40, y: 50, fontSize: 8, width: 14 },
      { str: 'two', x: 40, y: 62, fontSize: 8, width: 14 },
    ]
    expect(joinTextLines(items)).toHaveLength(2)
  })
})

describe('tuningShiftFrom', () => {
  it('reads a half step down', () => {
    expect(tuningShiftFrom('Tune down 1/2 step (low to high: Eb Ab Db Gb Bb Eb)')).toBe(-1)
  })

  it('reads a whole step down', () => {
    expect(tuningShiftFrom('Tune down 1 step')).toBe(-2)
  })

  it('reads a step and a half down', () => {
    expect(tuningShiftFrom('Tune down 1 1/2 steps')).toBe(-3)
  })

  it('reads nothing from an instruction with no amount', () => {
    expect(tuningShiftFrom('Tune down')).toBe(0)
  })

  it('ignores text that is not about tuning', () => {
    expect(tuningShiftFrom('Slow down at the end')).toBe(0)
  })
})

describe('parseScore string assignment', () => {
  it('reads the top staff line as the high E and the bottom as the low E', () => {
    const score = parseScore([
      page({
        texts: [fret(0, 100, '3'), fret(5, 120, '7'), fret(2, 229, '5'), fret(3, 402, '9')],
      }),
    ])
    const byFret = new Map(score.notes.map((n) => [n.fret, n.stringIdx]))
    // stringIdx counts up from the low E, so the top tab line is 5.
    expect(byFret.get(3)).toBe(5)
    expect(byFret.get(7)).toBe(0)
    expect(byFret.get(5)).toBe(3)
    expect(byFret.get(9)).toBe(2)
  })

  it('reads every line of a six-note chord onto its own string', () => {
    const texts = [0, 1, 2, 3, 4, 5].map((line) => fret(line, 100, String(line + 1)))
    const score = parseScore([page({ texts: [...texts, fret(0, 229, '1'), fret(0, 402, '1')] })])
    const chord = score.notes.filter((n) => n.measureIndex === 0)
    expect(chord.map((n) => n.stringIdx).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('reads a two-digit fret as one number', () => {
    const score = parseScore([
      page({ texts: [fret(5, 100, '12'), fret(0, 229, '1'), fret(0, 402, '1')] }),
    ])
    expect(score.notes[0].fret).toBe(12)
  })

  it('marks a parenthesised number as a ghost note', () => {
    const score = parseScore([
      page({ texts: [fret(3, 100, '(7)'), fret(0, 229, '1'), fret(0, 402, '1')] }),
    ])
    expect(score.notes[0]).toMatchObject({ fret: 7, ghost: true })
  })

  it('keeps a dead note as a position with no fret', () => {
    const score = parseScore([
      page({ texts: [fret(4, 100, 'x'), fret(0, 229, '1'), fret(0, 402, '1')] }),
    ])
    expect(score.notes[0]).toMatchObject({ fret: null, stringIdx: 1 })
  })

  it('still places numbers when a staff uses two glyph sizes', () => {
    // Grace notes are engraved smaller and sit slightly differently on the line.
    const score = parseScore([
      page({
        texts: [
          fret(1, 100, '5'),
          fret(1, 120, '7'),
          fret(1, 140, '5'),
          fret(1, 160, '7'),
          { ...fret(1, 180, '9', 6.4), y: TAB_TOP + SPACING + 2.1 },
          fret(0, 229, '1'),
          fret(0, 402, '1'),
        ],
      }),
    ])
    expect(score.notes.every((n) => n.stringIdx === 4 || n.fret === 1)).toBe(true)
  })
})

describe('parseScore timing', () => {
  const timed = () =>
    parseScore([
      page({
        texts: [
          // Bar 1 opens after the clef, so its first note sits well right of the edge.
          fret(0, 100, '1'),
          fret(0, 150, '2'),
          // Bars 2 and 3 start a normal engraving pad past their bar line.
          fret(0, 229, '3'),
          fret(0, 315, '4'),
          fret(0, 402, '5'),
        ],
      }),
    ])

  it('puts the first note of each bar on the downbeat', () => {
    const score = timed()
    const first = (measureIndex: number) =>
      score.notes.find((n) => n.measureIndex === measureIndex)
    expect(first(0)?.beat).toBe(0)
    expect(first(1)?.beat).toBe(4)
    expect(first(2)?.beat).toBe(8)
  })

  it('places a note halfway through a bar near the middle of it', () => {
    const score = timed()
    const middle = score.notes.find((n) => n.fret === 4)
    expect(middle?.beat).toBeGreaterThan(4.5)
    expect(middle?.beat).toBeLessThan(7)
  })

  it('numbers bars continuously so timing errors cannot accumulate', () => {
    const score = timed()
    expect(score.measures.map((m) => m.startBeat)).toEqual([0, 4, 8])
  })

  it('keeps onsets strictly in order even when two notes nearly coincide', () => {
    const score = parseScore([
      page({
        texts: [
          fret(0, 100, '1'),
          // Far enough apart to be separate attacks, close enough to quantise alike.
          fret(1, 104.5, '2'),
          fret(0, 229, '3'),
          fret(0, 402, '4'),
        ],
      }),
    ])
    const bar = score.notes.filter((n) => n.measureIndex === 0)
    expect(bar).toHaveLength(2)
    expect(bar[1].beat).toBeGreaterThan(bar[0].beat)
  })

  it('gives notes struck together the same onset', () => {
    const score = parseScore([
      page({
        texts: [
          fret(0, 100, '5'),
          fret(1, 100, '5'),
          fret(2, 100, '6'),
          fret(0, 229, '1'),
          fret(0, 402, '1'),
        ],
      }),
    ])
    const chord = score.notes.filter((n) => n.measureIndex === 0)
    expect(new Set(chord.map((n) => n.beat)).size).toBe(1)
  })

  it('scales bar length with the beats-per-bar option', () => {
    const score = parseScore(
      [page({ texts: [fret(0, 100, '1'), fret(0, 229, '2'), fret(0, 402, '3')] })],
      { beatsPerBar: 3 },
    )
    expect(score.beatsPerBar).toBe(3)
    expect(score.measures.map((m) => m.startBeat)).toEqual([0, 3, 6])
  })
})

describe('parseScore articulations', () => {
  const withMark = (label: string, frets: [string, string]) =>
    parseScore([
      page({
        texts: [
          fret(2, 240, frets[0]),
          under(260, label),
          fret(2, 280, frets[1]),
          fret(0, 100, '1'),
          fret(0, 402, '1'),
        ],
      }),
    ])

  it('gives a hammer-on to the note the mark points at', () => {
    const score = withMark('H', ['5', '7'])
    const target = score.notes.find((n) => n.fret === 7)
    const source = score.notes.find((n) => n.fret === 5)
    expect(target?.art).toBe('hammer')
    expect(source?.art).toBeUndefined()
  })

  it('gives a pull-off to the note the mark points at', () => {
    const score = withMark('P', ['7', '5'])
    expect(score.notes.find((n) => n.fret === 5)?.art).toBe('pull')
  })

  it('reads a slide up when the target fret is higher', () => {
    const score = withMark('sl.', ['5', '9'])
    expect(score.notes.find((n) => n.fret === 9)?.art).toBe('slide-up')
  })

  it('reads a slide down when the target fret is lower', () => {
    const score = withMark('sl.', ['9', '5'])
    expect(score.notes.find((n) => n.fret === 5)?.art).toBe('slide-down')
  })

  it('leaves notes plain when nothing is printed under the staff', () => {
    const score = parseScore([
      page({ texts: [fret(2, 240, '5'), fret(0, 100, '1'), fret(0, 402, '1')] }),
    ])
    expect(score.notes.every((n) => n.art === undefined)).toBe(true)
  })
})

describe('bendSemitones', () => {
  it('reads Full as a whole tone', () => {
    expect(bendSemitones('Full')).toBe(2)
    expect(bendSemitones('full')).toBe(2)
  })

  it('reads the printed fractions', () => {
    expect(bendSemitones('1/2')).toBe(1)
    expect(bendSemitones('1/4')).toBe(0.5)
    expect(bendSemitones('3/4')).toBe(1.5)
  })

  it('reads a mixed amount such as 1 1/2', () => {
    expect(bendSemitones('1 1/2')).toBe(3)
    expect(bendSemitones('2 1/2')).toBe(5)
  })

  it('reads the single-glyph fractions', () => {
    expect(bendSemitones('½')).toBe(1)
    expect(bendSemitones('1½')).toBe(3)
  })

  it('ignores text that is not an amount, bare numbers included', () => {
    // A lone digit over a staff is a tuplet or a fingering far more often than
    // it is a bend of that many tones.
    expect(bendSemitones('2')).toBeNull()
    expect(bendSemitones('3')).toBeNull()
    expect(bendSemitones('sl.')).toBeNull()
    expect(bendSemitones('')).toBeNull()
  })
})

describe('parseScore bends', () => {
  const withBend = (label: string, extra: TabTextItem[] = []) =>
    parseScore([
      page({
        texts: [fret(1, 240, '8'), over(240, label), fret(0, 100, '1'), fret(0, 402, '1'), ...extra],
      }),
    ])

  it('reads Full as a whole-tone bend on the note under it', () => {
    const score = withBend('Full')
    expect(score.notes.find((n) => n.fret === 8)?.bend).toEqual({
      semitones: 2,
      direction: 'up',
    })
  })

  it('reads a half-step bend', () => {
    expect(withBend('1/2').notes.find((n) => n.fret === 8)?.bend?.semitones).toBe(1)
  })

  it('reassembles an amount printed as two runs', () => {
    const score = parseScore([
      page({
        texts: [
          fret(1, 240, '8'),
          { ...over(240, '1'), width: 3.9 },
          { ...over(243.9, '1/2') },
          fret(0, 100, '1'),
          fret(0, 402, '1'),
        ],
      }),
    ])
    expect(score.notes.find((n) => n.fret === 8)?.bend?.semitones).toBe(3)
  })

  it('leaves notes with nothing printed over them unbent', () => {
    const score = withBend('Full')
    expect(score.notes.filter((n) => n.bend !== undefined)).toHaveLength(1)
  })

  it('attaches a label set between two notes to the one it rises from', () => {
    // A bend that is released again puts the amount over the middle of the arc.
    const score = parseScore([
      page({
        texts: [
          fret(1, 240, '8'),
          fret(1, 260, '8'),
          over(250, 'Full'),
          fret(0, 100, '1'),
          fret(0, 402, '1'),
        ],
      }),
    ])
    const bent = score.notes.filter((n) => n.bend !== undefined)
    expect(bent).toHaveLength(1)
    expect(bent[0].beat).toBe(score.notes.filter((n) => n.fret === 8)[0].beat)
  })

  it('gives a chord bend to the highest string, which is the one a hand pushes', () => {
    const score = parseScore([
      page({
        texts: [
          fret(1, 240, '8'),
          fret(3, 240, '5'),
          over(240, 'Full'),
          fret(0, 100, '1'),
          fret(0, 402, '1'),
        ],
      }),
    ])
    expect(score.notes.find((n) => n.fret === 8)?.bend?.semitones).toBe(2)
    expect(score.notes.find((n) => n.fret === 5)?.bend).toBeUndefined()
  })

  it('keeps a label at the start of a bar off the last note of the one before', () => {
    const score = parseScore([
      page({
        texts: [fret(1, 205, '5'), fret(1, 225, '8'), over(225, 'Full'), fret(0, 402, '1')],
      }),
    ])
    expect(score.notes.find((n) => n.fret === 8)?.bend?.semitones).toBe(2)
    expect(score.notes.find((n) => n.fret === 5)?.bend).toBeUndefined()
  })

  it('says so when an amount cannot be matched to a note', () => {
    const score = parseScore([
      page({ texts: [fret(1, 400, '8'), over(120, 'Full'), fret(0, 402, '1')] }),
    ])
    expect(score.notes.every((n) => n.bend === undefined)).toBe(true)
    expect(score.warnings.some((w) => /bend amount/i.test(w))).toBe(true)
  })
})

describe('parseScore metadata', () => {
  it('reads the title, artist and tempo off the first page', () => {
    const header: TabTextItem[] = [
      { str: 'BOLD', x: 300, y: 40, fontSize: 21, width: 40 },
      { str: 'AS', x: 343, y: 40, fontSize: 21, width: 18 },
      { str: 'LOVE', x: 364, y: 40, fontSize: 21, width: 42 },
      { str: 'As', x: 300, y: 58, fontSize: 12, width: 10 },
      { str: 'recorded', x: 312, y: 58, fontSize: 12, width: 40 },
      { str: 'by', x: 354, y: 58, fontSize: 12, width: 9 },
      { str: 'John', x: 365, y: 58, fontSize: 12, width: 20 },
      { str: 'Mayer', x: 387, y: 58, fontSize: 12, width: 26 },
      { str: '=', x: 200, y: 80, fontSize: 9, width: 5 },
      { str: '132', x: 207, y: 80, fontSize: 9, width: 14 },
    ]
    const score = parseScore([
      page({ texts: [...header, fret(0, 100, '1'), fret(0, 229, '1'), fret(0, 402, '1')] }),
    ])
    expect(score.title).toBe('BOLD AS LOVE')
    expect(score.artist).toBe('John Mayer')
    expect(score.bpm).toBe(132)
  })

  it('prefers an explicit tempo over the one printed on the page', () => {
    const texts = [
      { str: '= 132', x: 200, y: 80, fontSize: 9, width: 20 },
      fret(0, 100, '1'),
      fret(0, 229, '1'),
      fret(0, 402, '1'),
    ]
    expect(parseScore([page({ texts })], { bpm: 96 }).bpm).toBe(96)
  })

  it('labels a bar with the section printed above it', () => {
    const marker: TabTextItem = { str: 'A Verse', x: 41, y: 30, fontSize: 9, width: 33 }
    const score = parseScore([
      page({ texts: [marker, fret(0, 100, '1'), fret(0, 229, '1'), fret(0, 402, '1')] }),
    ])
    expect(score.measures[0].marker).toBe('A Verse')
    expect(score.measures[1].marker).toBeUndefined()
  })

  it('warns and returns nothing readable for a page with no tab staff', () => {
    const scanned: TabPagePrimitives = {
      pageIndex: 0,
      width: PAGE_W,
      height: PAGE_H,
      segments: [],
      texts: [],
    }
    const score = parseScore([scanned])
    expect(score.measures).toEqual([])
    expect(score.notes).toEqual([])
    expect(score.warnings.join(' ')).toMatch(/scan|image/i)
  })

  it('always says how the rhythm was arrived at', () => {
    const score = parseScore([
      page({ texts: [fret(0, 100, '1'), fret(0, 229, '1'), fret(0, 402, '1')] }),
    ])
    expect(score.warnings.join(' ')).toMatch(/rhythm/i)
  })

  it('counts marks on the staff it could not read', () => {
    const odd: TabTextItem = { str: '3x5', x: 300, y: TAB_TOP + SPACING * 2 + 2.9, fontSize: 8, width: 12 }
    const score = parseScore([
      page({ texts: [odd, fret(0, 100, '1'), fret(0, 229, '1'), fret(0, 402, '1')] }),
    ])
    expect(score.unreadCount).toBe(1)
    expect(score.warnings.join(' ')).toMatch(/could not be read/i)
  })
})
