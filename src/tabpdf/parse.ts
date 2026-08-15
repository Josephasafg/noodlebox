import type { Articulation } from '../theory/licks'
import type {
  ParsedScore,
  ScoreBend,
  ScoreMeasure,
  ScoreNote,
  TabLineSeg,
  TabPagePrimitives,
  TabStaffBox,
  TabTextItem,
} from './types'

/** Lines thinner than this in the off-axis are treated as truly horizontal/vertical. */
const AXIS_TOL = 0.8

/** A staff line runs the width of its system; short rules and ties do not. */
const MIN_STAFF_LINE_FRACTION = 0.2

/** Tab staves have six lines. Five is standard notation, which we ignore. */
const TAB_STAFF_LINES = 6
const NOTATION_STAFF_LINES = 5

/** Rhythm is recovered from horizontal spacing, so it is snapped to 16ths. */
const BEAT_GRID = 0.25

const DEFAULT_BPM = 90
const DEFAULT_BEATS_PER_BAR = 4

const FRET_RE = /^\((\d{1,2})\)$|^(\d{1,2})$/
const DEAD_RE = /^\(?[xX×]\)?$/
const MARKER_RE =
  /\b(verse|chorus|intro|bridge|solo|outro|pre-chorus|prechorus|interlude|coda|ending|riff|refrain)\b/i

/** Bend amounts are printed a couple of staff spaces above the tab staff. */
const BEND_BAND_LOW = 0.5
const BEND_BAND_HIGH = 4.5
const FRACTION_RE = /^(1\/4|1\/2|3\/4)$/

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function isHorizontal(s: TabLineSeg): boolean {
  return Math.abs(s.y1 - s.y0) <= AXIS_TOL
}

function isVertical(s: TabLineSeg): boolean {
  return Math.abs(s.x1 - s.x0) <= AXIS_TOL
}

interface Rule {
  y: number
  x0: number
  x1: number
}

/**
 * Collapse the long horizontal strokes into one rule per y. Engravers often draw
 * a staff line as several abutting segments, and the same line can be stroked
 * twice; both would otherwise break the equal-spacing test below.
 */
function horizontalRules(page: TabPagePrimitives): Rule[] {
  const wide = page.width * MIN_STAFF_LINE_FRACTION
  const out: Rule[] = []
  for (const s of page.segments) {
    if (!isHorizontal(s)) continue
    const x0 = Math.min(s.x0, s.x1)
    const x1 = Math.max(s.x0, s.x1)
    if (x1 - x0 < wide) continue
    const y = (s.y0 + s.y1) / 2
    // Ignore the page border, which is as wide as the sheet itself.
    if (x1 - x0 > page.width * 0.98) continue
    const hit = out.find((r) => Math.abs(r.y - y) < AXIS_TOL && Math.abs(r.x0 - x0) < 3)
    if (hit) {
      hit.x1 = Math.max(hit.x1, x1)
      continue
    }
    out.push({ y, x0, x1 })
  }
  return out.sort((a, b) => a.y - b.y)
}

/**
 * Split rules into runs that are evenly spaced and share a horizontal extent.
 * Both conditions matter: spacing alone would swallow a stray rule that happens
 * to sit a staff-space above a staff.
 */
function evenlySpacedRuns(rules: Rule[]): Rule[][] {
  const runs: Rule[][] = []
  let run: Rule[] = []
  let spacing = 0

  const sameSystem = (a: Rule, b: Rule) =>
    Math.abs(a.x0 - b.x0) <= 2.5 && Math.abs(a.x1 - b.x1) <= 2.5

  for (const rule of rules) {
    if (run.length === 0) {
      run = [rule]
      spacing = 0
      continue
    }
    const prev = run[run.length - 1]
    const gap = rule.y - prev.y
    const fits =
      sameSystem(prev, rule) &&
      gap > AXIS_TOL &&
      (run.length === 1 ? true : Math.abs(gap - spacing) <= Math.max(0.7, spacing * 0.16))
    if (fits) {
      run.push(rule)
      if (run.length === 2) spacing = gap
      continue
    }
    runs.push(run)
    run = [rule]
    spacing = 0
  }
  if (run.length > 0) runs.push(run)
  return runs
}

/** Locate every six-line tab staff on a page, in reading order. */
export function findTabStaves(page: TabPagePrimitives): TabStaffBox[] {
  return evenlySpacedRuns(horizontalRules(page))
    .filter((run) => run.length === TAB_STAFF_LINES)
    .map((run) => ({
      pageIndex: page.pageIndex,
      lines: run.map((r) => r.y),
      top: run[0].y,
      bottom: run[run.length - 1].y,
      spacing: (run[run.length - 1].y - run[0].y) / (TAB_STAFF_LINES - 1),
      x0: Math.min(...run.map((r) => r.x0)),
      x1: Math.max(...run.map((r) => r.x1)),
    }))
}

/** The notation staff a tab staff is paired with, if one was engraved above it. */
function notationStaffAbove(page: TabPagePrimitives, staff: TabStaffBox): Rule[] | null {
  const candidates = evenlySpacedRuns(horizontalRules(page)).filter(
    (run) =>
      run.length === NOTATION_STAFF_LINES &&
      run[run.length - 1].y < staff.top &&
      run[0].x1 > staff.x0 &&
      run[0].x0 < staff.x1,
  )
  if (candidates.length === 0) return null
  return candidates[candidates.length - 1]
}

/**
 * Barlines, as x positions, including the staff's own left and right edges.
 * Only strokes spanning essentially the whole staff height count, which keeps
 * note stems and slur ends out of the measure grid.
 */
export function findBarlines(page: TabPagePrimitives, staff: TabStaffBox): number[] {
  const xs: number[] = [staff.x0, staff.x1]
  for (const s of page.segments) {
    if (!isVertical(s)) continue
    const top = Math.min(s.y0, s.y1)
    const bottom = Math.max(s.y0, s.y1)
    const covers =
      top <= staff.top + staff.spacing * 0.5 && bottom >= staff.bottom - staff.spacing * 0.5
    if (!covers) continue
    const x = (s.x0 + s.x1) / 2
    if (x < staff.x0 - 3 || x > staff.x1 + 3) continue
    xs.push(x)
  }
  xs.sort((a, b) => a - b)
  // Repeat signs and double bars are several strokes a hair apart.
  const merged: number[] = []
  for (const x of xs) {
    if (merged.length === 0 || x - merged[merged.length - 1] > 4) merged.push(x)
    else merged[merged.length - 1] = x
  }
  return merged
}

// ---------------------------------------------------------------------------
// Reading fret numbers off a staff
// ---------------------------------------------------------------------------

interface RawNote {
  /** Horizontal centre of the glyph, which is where the note sits in time. */
  cx: number
  /** Line index from the top of the staff: 0 = highest string. */
  line: number
  fret: number | null
  ghost: boolean
}

/**
 * Recover the baseline-to-staff-line offset from the document itself.
 *
 * Fret numbers are centred on their line, so their baseline sits a fixed
 * fraction of the glyph height below it. That fraction depends on the font, so
 * rather than hard-code one engraver's metrics we take the circular mean of
 * where the numbers actually fall between lines and use it as the correction.
 */
export function calibrateLineOffset(fractions: number[]): number {
  if (fractions.length === 0) return 0
  let sx = 0
  let sy = 0
  for (const f of fractions) {
    sx += Math.cos(2 * Math.PI * f)
    sy += Math.sin(2 * Math.PI * f)
  }
  if (sx === 0 && sy === 0) return 0
  const angle = Math.atan2(sy, sx)
  return (angle / (2 * Math.PI) + 1) % 1
}

interface StaffText {
  notes: TabTextItem[]
  below: TabTextItem[]
  /** Marks in the band over the staff, where bend amounts are printed. */
  above: TabTextItem[]
  unread: number
}

/** Split the text around a staff into fret numbers and the marks either side. */
function textForStaff(page: TabPagePrimitives, staff: TabStaffBox): StaffText {
  const notes: TabTextItem[] = []
  const below: TabTextItem[] = []
  const above: TabTextItem[] = []
  let unread = 0
  for (const item of page.texts) {
    const str = item.str.trim()
    if (str.length === 0) continue
    const cx = item.x + item.width / 2
    if (cx < staff.x0 - 4 || cx > staff.x1 + 4) continue
    // Baselines sit below the glyph centre, so the band is offset downward.
    const inStaff =
      item.y > staff.top - staff.spacing * 0.35 &&
      item.y < staff.bottom + staff.spacing * 0.9
    if (inStaff) {
      if (FRET_RE.test(str) || DEAD_RE.test(str)) notes.push({ ...item, str })
      else if (/^\d/.test(str)) unread += 1
      continue
    }
    if (item.y >= staff.bottom + staff.spacing * 0.9 && item.y <= staff.bottom + staff.spacing * 4) {
      below.push({ ...item, str })
    }
    if (
      item.y <= staff.top - staff.spacing * BEND_BAND_LOW &&
      item.y >= staff.top - staff.spacing * BEND_BAND_HIGH
    ) {
      above.push({ ...item, str })
    }
  }
  return { notes, below, above, unread }
}

/** Assign each fret number to a string by snapping its baseline to a staff line. */
function readNotes(staff: TabStaffBox, items: TabTextItem[]): RawNote[] {
  // Calibrate per font size: an engraver can mix sizes (grace notes, ghost
  // notes) whose baselines sit differently against the same line.
  const bySize = new Map<number, TabTextItem[]>()
  for (const it of items) {
    const size = Math.round(it.fontSize * 2) / 2
    const bucket = bySize.get(size)
    if (bucket) bucket.push(it)
    else bySize.set(size, [it])
  }

  const rawFraction = (it: TabTextItem) => {
    const r = (it.y - staff.top) / staff.spacing
    return r - Math.floor(r)
  }
  const pooled = calibrateLineOffset(items.map(rawFraction))

  const offsetFor = new Map<number, number>()
  for (const [size, bucket] of bySize) {
    offsetFor.set(size, bucket.length >= 4 ? calibrateLineOffset(bucket.map(rawFraction)) : pooled)
  }

  const out: RawNote[] = []
  for (const it of items) {
    const size = Math.round(it.fontSize * 2) / 2
    const offset = offsetFor.get(size) ?? pooled
    const r = (it.y - staff.top) / staff.spacing - offset
    const line = Math.min(TAB_STAFF_LINES - 1, Math.max(0, Math.round(r)))
    const match = FRET_RE.exec(it.str)
    const digits = match ? (match[1] ?? match[2]) : null
    out.push({
      cx: it.x + it.width / 2,
      line,
      fret: digits === null ? null : Number(digits),
      ghost: it.str.startsWith('('),
    })
  }
  return out.sort((a, b) => a.cx - b.cx)
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

interface Onset {
  cx: number
  notes: RawNote[]
}

/** Group notes struck together. Anything on the same vertical is one chord. */
function groupOnsets(notes: RawNote[], spacing: number): Onset[] {
  const tol = Math.max(1.2, spacing * 0.3)
  const out: Onset[] = []
  for (const n of notes) {
    const last = out[out.length - 1]
    if (last && n.cx - last.cx <= tol) {
      last.notes.push(n)
      continue
    }
    out.push({ cx: n.cx, notes: [n] })
  }
  return out
}

function quantise(beat: number): number {
  return Math.round(beat / BEAT_GRID) * BEAT_GRID
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))
  return sorted[idx]
}

// ---------------------------------------------------------------------------
// Header metadata
// ---------------------------------------------------------------------------

/**
 * Rejoin text that the PDF stores as separate runs back into readable lines.
 *
 * A title is often drawn one word at a time, so "BOLD AS LOVE" arrives as three
 * items. Notes are read from the individual runs, but anything meant to be read
 * as prose — the title, the tempo mark, a tuning instruction — has to be
 * reassembled first. Runs are grouped when they share a baseline and a size and
 * are not separated by more than a couple of characters' worth of space.
 */
export function joinTextLines(items: readonly TabTextItem[]): TabTextItem[] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x)
  const lines: TabTextItem[] = []
  for (const item of sorted) {
    const open = lines[lines.length - 1]
    const sameLine =
      open !== undefined &&
      Math.abs(open.y - item.y) <= 1.2 &&
      Math.abs(open.fontSize - item.fontSize) <= Math.max(0.6, open.fontSize * 0.15)
    const gap = open === undefined ? Infinity : item.x - (open.x + open.width)
    if (sameLine && gap <= open.fontSize * 2.5) {
      // Runs continuing a word abut or overlap slightly through kerning; a real
      // word space measures nearer a fifth of an em, so the two are far apart.
      open.str += gap > open.fontSize * 0.06 ? ` ${item.str}` : item.str
      open.width = item.x + item.width - open.x
      continue
    }
    lines.push({ ...item })
  }
  return lines
}

function readTempo(lines: readonly TabTextItem[]): number | null {
  for (const it of lines) {
    const m = /=\s*(\d{2,3})\b/.exec(it.str)
    if (m) {
      const bpm = Number(m[1])
      if (bpm >= 30 && bpm <= 320) return bpm
    }
  }
  return null
}

/** Semitones of detune described by a tuning instruction, e.g. "down 1/2 step". */
export function tuningShiftFrom(text: string): number {
  const t = text.toLowerCase()
  if (!/tune|tuning/.test(t)) return 0
  const down = /down/.test(t)
  if (!down) return 0
  if (/(1\s*1\/2|1½|one and a half|minor third)/.test(t)) return -3
  if (/(whole step|full step|1 step|one step)/.test(t)) return -2
  if (/(1\/2|½|half)/.test(t)) return -1
  return 0
}

function readHeader(page: TabPagePrimitives | undefined): {
  title: string | null
  artist: string | null
  tuningNote: string | null
} {
  if (!page) return { title: null, artist: null, tuningNote: null }
  const meaningful = joinTextLines(page.texts)
    .map((t) => ({ ...t, str: t.str.trim() }))
    .filter((t) => t.str.length > 1 && /[A-Za-z]/.test(t.str))

  let title: string | null = null
  let biggest = 0
  for (const t of meaningful) {
    if (t.fontSize > biggest) {
      biggest = t.fontSize
      title = t.str
    }
  }

  let artist: string | null = null
  for (const t of meaningful) {
    const m = /^as\s+(?:recorded|performed|played)\s+by\s+(.+)$/i.exec(t.str)
    if (m) {
      artist = m[1].trim()
      break
    }
  }

  const tuning = meaningful.find((t) => /tune\s*down|tuning\s*[:=]/i.test(t.str))
  return { title, artist, tuningNote: tuning ? tuning.str : null }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface ParseOptions {
  beatsPerBar?: number
  bpm?: number
}

/**
 * Read a tab score out of the drawing primitives of a PDF.
 *
 * Strings and frets come out exact: they are read from glyphs snapped to staff
 * lines whose positions are drawn in the file. Rhythm is an approximation —
 * engraved spacing is only roughly proportional to time — so onsets are derived
 * from horizontal position within each measure and snapped to a 16th grid.
 */
export function parseScore(
  pages: readonly TabPagePrimitives[],
  options: ParseOptions = {},
): ParsedScore {
  const header = readHeader(pages[0])
  const beatsPerBar = options.beatsPerBar ?? DEFAULT_BEATS_PER_BAR
  const bpm =
    options.bpm ?? (pages[0] ? readTempo(joinTextLines(pages[0].texts)) : null) ?? DEFAULT_BPM

  const warnings: string[] = []
  const measures: ScoreMeasure[] = []
  const notes: ScoreNote[] = []
  let unreadCount = 0

  interface Pending {
    measureIndex: number
    staff: TabStaffBox
    firstInSystem: boolean
    xStart: number
    xEnd: number
    onsets: Onset[]
    below: TabTextItem[]
    marker?: string
  }
  const pending: Pending[] = []
  /**
   * Bends are keyed by onset rather than by measure: a label can hang past the
   * barline it started before, and the onsets a measure holds are the very same
   * objects the staff-wide pass matched against.
   */
  const bendFor = new Map<Onset, ScoreBend>()
  let unattachedBends = 0

  for (const page of pages) {
    const staves = findTabStaves(page)
    if (staves.length === 0) continue
    const lines = joinTextLines(page.texts)

    let previousBottom = 0
    for (const staff of staves) {
      const boundaries = findBarlines(page, staff)
      const { notes: items, below, above, unread } = textForStaff(page, staff)
      unreadCount += unread
      const raw = readNotes(staff, items)
      const onsets = groupOnsets(raw, staff.spacing)

      const bends = buildBends(above, onsets, staff.spacing)
      for (const [onset, bend] of bends.bends) bendFor.set(onset, bend)
      unattachedBends += bends.unattached

      // Section names are printed well above the staff, so the search window
      // runs from the previous system down to this one's notation staff. Bounding
      // it by the previous staff keeps a system from claiming its neighbour's.
      const notation = notationStaffAbove(page, staff)
      const ceiling = notation ? notation[0].y : staff.top - staff.spacing * 2
      const markerItems = lines.filter(
        (t) => t.y > previousBottom && t.y < ceiling && MARKER_RE.test(t.str),
      )
      previousBottom = staff.bottom

      for (let i = 0; i < boundaries.length - 1; i++) {
        const xStart = boundaries[i]
        const xEnd = boundaries[i + 1]
        // A barline pair narrower than a note is a repeat glyph, not a measure.
        if (xEnd - xStart < staff.spacing * 2) continue
        const inside = onsets.filter((o) => o.cx >= xStart && o.cx < xEnd)
        // A rehearsal mark is set just left of the barline it opens, so match on
        // proximity to the measure's start rather than containment.
        const marker = markerItems.find(
          (m) => Math.abs(m.x - xStart) <= staff.spacing * 6,
        )
        pending.push({
          measureIndex: -1,
          staff,
          firstInSystem: i === 0,
          xStart,
          xEnd,
          onsets: inside,
          below,
          marker: marker ? marker.str.trim().slice(0, 28) : undefined,
        })
      }
    }
  }

  if (pending.length === 0) {
    return {
      ...header,
      bpm,
      beatsPerBar,
      tuningShift: header.tuningNote ? tuningShiftFrom(header.tuningNote) : 0,
      measures: [],
      notes: [],
      warnings: [
        'No tablature staff was found in this PDF. It is most likely a scan or an image — the reader needs a PDF whose fret numbers are real text.',
      ],
      pageCount: pages.length,
      unreadCount,
    }
  }

  /**
   * A barline is followed by a sliver of engraving space before the first note,
   * which carries no time — left uncorrected it lands every downbeat a
   * sixteenth late. Measure that gap where it can be trusted, then treat beat
   * one of a measure as starting that far past its barline.
   */
  const ordinaryPads = pending
    .filter((p) => !p.firstInSystem && p.onsets.length > 0)
    .map((p) => p.onsets[0].cx - p.xStart)
  const basePad = ordinaryPads.length > 0 ? percentile(ordinaryPads, 0.25) : 0

  let measureIndex = 0
  let systemsSeen = 0
  for (const p of pending) {
    if (p.firstInSystem) systemsSeen += 1
    const systemCursor = systemsSeen - 1

    const startBeat = measureIndex * beatsPerBar
    // The opening measure of a system also carries the clef, key and time
    // signature, so its barline is much further left than its first beat. Place
    // that beat by the same pad instead, measured back from the first note.
    const origin =
      p.firstInSystem && p.onsets.length > 0
        ? Math.max(p.xStart, p.onsets[0].cx - basePad)
        : p.xStart
    const xStart = origin + basePad
    const span = p.xEnd + basePad - xStart
    const beatAt = (cx: number) =>
      span <= 0 ? 0 : Math.min(beatsPerBar, Math.max(0, ((cx - xStart) / span) * beatsPerBar))

    // Onsets, quantised but kept strictly in order so no two collapse together.
    const onsetBeats: number[] = []
    for (const o of p.onsets) {
      let beat = quantise(beatAt(o.cx))
      const prev = onsetBeats[onsetBeats.length - 1]
      if (prev !== undefined && beat <= prev) beat = prev + BEAT_GRID
      onsetBeats.push(Math.min(beat, beatsPerBar - BEAT_GRID))
    }

    const articulationFor = buildArticulations(p.below, p.onsets, p.staff.spacing)

    p.onsets.forEach((onset, i) => {
      const beat = onsetBeats[i]
      const next = onsetBeats[i + 1] ?? beatsPerBar
      const length = Math.max(BEAT_GRID, next - beat)
      const art = articulationFor.get(i)
      const bend = bendFor.get(onset)
      // One amount is printed over the arrow, and nothing in it says which
      // string was pushed. On a chord the highest string is by far the likeliest,
      // and it is the one the label sits closest to.
      const bentLine = bend ? Math.min(...onset.notes.map((n) => n.line)) : -1
      for (const n of onset.notes) {
        notes.push({
          measureIndex,
          // Tab is written high string on top; the app counts from the low E.
          stringIdx: TAB_STAFF_LINES - 1 - n.line,
          fret: n.fret,
          ghost: n.ghost,
          beat: startBeat + beat,
          length,
          art,
          bend: n.line === bentLine ? bend : undefined,
        })
      }
    })

    measures.push({
      index: measureIndex,
      pageIndex: p.staff.pageIndex,
      systemIndex: systemCursor,
      startBeat,
      beats: beatsPerBar,
      marker: p.marker,
    })
    measureIndex += 1
  }

  if (unreadCount > 0) {
    warnings.push(
      `${unreadCount} mark${unreadCount === 1 ? '' : 's'} on the tab staff could not be read and were skipped.`,
    )
  }
  if (unattachedBends > 0) {
    const plural = unattachedBends === 1 ? '' : 's'
    warnings.push(
      `${unattachedBends} bend amount${plural} could not be matched to a note, so ${unattachedBends === 1 ? 'it is' : 'they are'} not shown.`,
    )
  }
  const tuningShift = header.tuningNote ? tuningShiftFrom(header.tuningNote) : 0
  if (header.tuningNote && tuningShift === 0) {
    warnings.push(
      `This tab prints a tuning instruction — "${header.tuningNote}" — that the reader could not turn into a pitch shift. Fret numbers are still correct; playback assumes standard tuning.`,
    )
  }
  warnings.push(
    'Strings and frets are read from the file exactly. Rhythm is inferred from note spacing, so it follows the shape of the phrasing rather than the printed note values.',
  )

  return {
    ...header,
    bpm,
    beatsPerBar,
    tuningShift,
    measures,
    notes,
    warnings,
    pageCount: pages.length,
    unreadCount,
  }
}

/**
 * Map the legato marks printed under the staff onto the notes they belong to.
 * An `H` or `P` sits between the two notes it joins, so it belongs to the note
 * that follows it — the one that is hammered onto or pulled off to.
 */
function buildArticulations(
  below: readonly TabTextItem[],
  onsets: readonly Onset[],
  spacing: number,
): Map<number, Articulation> {
  const out = new Map<number, Articulation>()
  if (onsets.length === 0) return out

  for (const mark of below) {
    const str = mark.str.trim()
    let art: Articulation | null = null
    if (/^[Hh]$/.test(str)) art = 'hammer'
    else if (/^[Pp]$/.test(str)) art = 'pull'
    else if (/^sl\.?$/i.test(str)) art = 'slide-up'
    if (art === null) continue

    const mx = mark.x + mark.width / 2
    let target = -1
    for (let i = 0; i < onsets.length; i++) {
      if (onsets[i].cx > mx) {
        target = i
        break
      }
    }
    if (target === -1) continue
    // A mark far from any note is more likely a stray letter than a slur.
    if (onsets[target].cx - mx > spacing * 8) continue

    if (art === 'slide-up') {
      const from = onsets[target - 1]
      const to = onsets[target]
      const fromFret = from ? highestFret(from) : null
      const toFret = highestFret(to)
      if (fromFret !== null && toFret !== null && toFret < fromFret) art = 'slide-down'
    }
    out.set(target, art)
  }
  return out
}

/**
 * Semitones described by a printed bend amount, or null when the text is not
 * one. "Full" is a whole tone, the convention every tab engraver uses.
 *
 * Bare integers are deliberately not accepted: a lone "2" above a staff is far
 * more often a tuplet or a fingering than a two-tone bend.
 */
export function bendSemitones(text: string): number | null {
  const t = text.trim().replace(/½/g, '1/2').replace(/¼/g, '1/4').replace(/¾/g, '3/4')
  if (/^full$/i.test(t)) return 2
  const m = /^(?:([1-4])\s*)?(1\/4|1\/2|3\/4)$/.exec(t)
  if (!m) return null
  const whole = m[1] === undefined ? 0 : Number(m[1])
  const fraction = m[2] === '1/4' ? 0.5 : m[2] === '1/2' ? 1 : 1.5
  return whole * 2 + fraction
}

/** How far left of its label a bend's own note may sit, in staff spaces. */
const BEND_REACH = 3.5

/**
 * Attach the bend amounts printed above a staff to the notes they belong to.
 *
 * The arrow rises from the note that is bent, and the amount is set over the
 * arrow, so the label lands above its own note — or, when the bend is released
 * again, midway between the note and where it lands. Either way the bent note is
 * the last one starting at or before the label.
 */
function buildBends(
  above: readonly TabTextItem[],
  onsets: readonly Onset[],
  spacing: number,
): { bends: Map<Onset, ScoreBend>; unattached: number } {
  const bends = new Map<Onset, ScoreBend>()
  let unattached = 0
  if (above.length === 0) return { bends, unattached }

  for (const mark of above) {
    const str = mark.str.trim()
    // "1 1/2" is drawn as two runs, so a bare fraction takes any whole number
    // written immediately before it on the same line.
    let text = str
    let x = mark.x
    if (FRACTION_RE.test(str)) {
      const lead = above.find(
        (t) =>
          /^[1-4]$/.test(t.str.trim()) &&
          Math.abs(t.y - mark.y) <= 1.2 &&
          mark.x - (t.x + t.width) >= -0.5 &&
          mark.x - (t.x + t.width) <= mark.fontSize * 0.5,
      )
      if (lead) {
        text = `${lead.str.trim()} ${str}`
        x = lead.x
      }
    }
    const semitones = bendSemitones(text)
    if (semitones === null) continue

    let target = -1
    for (let i = 0; i < onsets.length; i++) {
      if (onsets[i].cx > x + spacing * 0.5) break
      target = i
    }
    if (target === -1 || x - onsets[target].cx > spacing * BEND_REACH) {
      unattached += 1
      continue
    }
    bends.set(onsets[target], { semitones, direction: 'up' })
  }
  return { bends, unattached }
}

function highestFret(onset: Onset): number | null {
  const frets = onset.notes.map((n) => n.fret).filter((f): f is number => f !== null)
  return frets.length === 0 ? null : Math.max(...frets)
}
