import type { Articulation } from '../theory/licks'
import type { ParsedScore, ScoreBend, ScoreMeasure, ScoreNote } from '../tabpdf/types'

/**
 * Turning plain-text tablature into the app's own score, so a tab copied off a
 * song page is engraved on the same staff as one read from a PDF or a video —
 * and is playable, editable and tappable in exactly the same way.
 *
 * Plain text carries no rhythm. What it does carry is spacing: tabbers lay a
 * line out on a sixteenth grid, four columns to the beat, and align notes struck
 * together in one column. So a note's onset is recovered from where it sits
 * between the barlines around it, the same way the PDF reader recovers it from x
 * position. Bar lines printed in the tab are authoritative; a line with none is
 * cut into bars at the nominal width, which keeps a long run readable instead of
 * crushing it into a single bar.
 */

const STRINGS = 6
/** Rhythm is inferred from spacing, so it is snapped to sixteenths. */
const BEAT_GRID = 0.25
const DEFAULT_BPM = 90
const DEFAULT_BEATS_PER_BAR = 4
/** Plain-text tab is written on a sixteenth grid: four columns to the beat. */
const COLS_PER_BEAT = 4
/** Two-digit frets are aligned by their right edge, so allow a column of slack. */
const CHORD_TOL = 1
/**
 * A bar line is followed by a column of breathing room before the first note,
 * which carries no time. Left uncorrected it lands every downbeat a sixteenth
 * late — the same correction the PDF reader makes for engraving space.
 */
const BAR_PAD_COLS = 1
/** A bar line has to show on most strings; one missing is a typo, not a bar. */
const BAR_LINE_MIN_STRINGS = 4

/** The label a staff line opens with: `e|`, `E|`, `Bb|`, `D#|`, or nothing. */
const STAFF_HEAD_RE = /^[ \t]*(?:[A-Ga-g][#b]?\d?)?[ \t]*\|/
/** Fret numbers only go to 24, so a run of digits is at most two long. */
const FRET_RE = /^\d{1,2}/
/**
 * A fret in brackets is held rather than struck again. Tabbers reach for
 * whichever bracket is to hand, and nest them — `(15)`, `[15]`, `([15])` all
 * mean the same thing.
 */
const HELD_RE = /^[([]+\s*(\d{1,2}|[xX])\s*[)\]]+/
const HARMONIC_RE = /^<(\d{1,2})>/

/**
 * Padding and marks that carry no note: rules, hold lines, and the `o` of a
 * repeat bracket. Dashes are typed as hyphens, en dashes and em dashes
 * interchangeably, and all three are just the string sounding on.
 */
const FILLER = new Set([
  '-',
  '–',
  '—',
  ' ',
  '\t',
  '|',
  '=',
  '*',
  '.',
  ',',
  ':',
  ';',
  "'",
  '"',
  '+',
  '_',
  'o',
  'O',
])

/**
 * Where a staff line's content starts.
 *
 * The label and the `|` that opens the staff are not part of the grid, so they
 * are cut off before any column is counted. A line written without a label
 * starts at its first `|`.
 */
function staffBody(line: string): string {
  const head = STAFF_HEAD_RE.exec(line)
  const body = head ? line.slice(head[0].length) : line
  // A trailing carriage return is an artefact of the page, not a column.
  return body.replace(/\r$/, '')
}

/**
 * Whether a line is one string of a tablature staff.
 *
 * Judged on the shape of the whole line rather than its label, because the
 * labels vary and some tabs leave them off. Dashes are what make it a staff: a
 * lyric line with a stray `|` has none.
 */
export function isStaffLine(line: string): boolean {
  if (!STAFF_HEAD_RE.test(line)) return false
  const body = staffBody(line)
  if (body.length < 4) return false
  const dashes = (body.match(/[-–—]/g) ?? []).length
  return dashes >= body.length * 0.3
}

function artFor(symbol: string, from: number | null, to: number | null): Articulation | undefined {
  switch (symbol) {
    // A tap arrives on the fret without being picked, which is what a hammer-on
    // sounds like, and the app has no separate mark for it — so `t` joins `h`.
    case 'h':
    case 'H':
    case 't':
    case 'T':
      return 'hammer'
    case 'p':
    case 'P':
      return 'pull'
    case '/':
      return 'slide-up'
    case '\\':
      return 'slide-down'
    case 's':
    case 'S':
      // A slide is written without a direction; the two frets say which way.
      return from !== null && to !== null && to < from ? 'slide-down' : 'slide-up'
    default:
      return undefined
  }
}

interface RawNote {
  col: number
  fret: number | null
  ghost: boolean
  art?: Articulation
  bend?: ScoreBend
}

/**
 * Read one string of a staff.
 *
 * A symbol between two frets belongs to the fret it leads into — `7h9` marks the
 * `9` — which is the same convention the rest of the app follows, so the sheet
 * can pair it back up with the note before it. A bend is the exception: `15b17`
 * is one note struck at 15 and pushed two semitones, so the second number is
 * absorbed into the first note rather than sounded on its own.
 */
function readStaffLine(body: string): { notes: RawNote[]; unread: number } {
  const notes: RawNote[] = []
  let unread = 0
  /**
   * The scan carries two things forward: a symbol waiting for the note it leads
   * into, and the last note placed. They live on an object because they are
   * written inside `place` and read back in the loop around it.
   */
  const scan: { pending: string | null; last: RawNote | null } = { pending: null, last: null }
  const bending = () => scan.pending === 'b' || scan.pending === 'B' || scan.pending === '^'

  const place = (fret: number | null, col: number, ghost: boolean, art?: Articulation) => {
    const from = scan.last
    if (bending() && from && from.fret !== null && fret !== null) {
      from.bend = { semitones: fret - from.fret, direction: fret >= from.fret ? 'up' : 'down' }
      scan.pending = null
      return
    }
    const note: RawNote = { col, fret, ghost }
    const resolved =
      art ?? (scan.pending ? artFor(scan.pending, from?.fret ?? null, fret) : undefined)
    if (resolved) note.art = resolved
    notes.push(note)
    scan.last = note
    scan.pending = null
  }

  let i = 0
  while (i < body.length) {
    const ch = body[i]
    if (FILLER.has(ch)) {
      i += 1
      continue
    }
    const rest = body.slice(i)

    const held = HELD_RE.exec(rest)
    if (held) {
      const inner = held[1]
      place(inner === 'x' || inner === 'X' ? null : Number(inner), i, true)
      i += held[0].length
      continue
    }

    const harmonic = HARMONIC_RE.exec(rest)
    if (harmonic) {
      place(Number(harmonic[1]), i, false, 'harmonic')
      i += harmonic[0].length
      continue
    }

    const fret = FRET_RE.exec(rest)
    if (fret) {
      place(Number(fret[0]), i, false)
      i += fret[0].length
      continue
    }

    if (ch === 'x' || ch === 'X') {
      place(null, i, false)
      i += 1
      continue
    }

    // Vibrato trails the note it is played on rather than leading into one.
    if (ch === '~') {
      const sounding = scan.last
      if (sounding) sounding.art = sounding.art ?? 'vibrato'
      i += 1
      continue
    }

    // A release just ends a bend that is already recorded on its note.
    if (ch === 'r' || ch === 'R') {
      scan.pending = null
      i += 1
      continue
    }

    if ('hHpPbBsStT/\\^'.includes(ch)) {
      scan.pending = ch
      i += 1
      continue
    }

    unread += 1
    i += 1
  }

  // A bend written with no target — `15^` — says the string was pushed without
  // saying how far. That is worth keeping as a bend with no amount.
  const trailing = scan.last
  if (bending() && trailing && trailing.fret !== null) {
    trailing.bend = { semitones: null, direction: 'up' }
  }
  return { notes, unread }
}

interface Segment {
  start: number
  end: number
  /** Whether this bar opens on a bar line, whose clearance carries no time. */
  padded: boolean
}

/**
 * Cut a staff into bars.
 *
 * Bar lines the tabber printed are taken as given. A staff with none is cut at
 * the nominal bar width instead: a sixty-column run is four bars of 4/4, and
 * treating it as one would stack every note onto the first beat.
 *
 * Those inferred bars are laid over the notes rather than over the line. Tabs
 * are padded out with dashes so every staff is the same width, and measuring
 * the padding as though it were music invents silent bars at the end of each
 * staff — which reads as a tab whose notes have drifted far apart.
 */
function barSegments(
  bodies: string[],
  width: number,
  beatsPerBar: number,
  content: Content,
): Segment[] {
  const cuts: number[] = []
  for (let c = 0; c < width; c++) {
    let hits = 0
    for (const body of bodies) if (body[c] === '|') hits += 1
    if (hits >= BAR_LINE_MIN_STRINGS) cuts.push(c)
  }

  const segments: Segment[] = []
  let start = 0
  for (const cut of cuts) {
    if (cut - start >= 2) segments.push({ start, end: cut, padded: true })
    start = cut + 1
  }
  if (width - start >= 2) segments.push({ start, end: width, padded: true })
  if (segments.length === 0) return []

  // Only a staff whose bars were never marked is cut by width — once there is
  // one real bar line, the tabber's own bars are the truth. A bar line counts as
  // the tabber's when it falls between the first and last note; the one closing
  // the staff sits past them, and staves are not always padded to the same
  // length, so its column cannot be relied on to be the last.
  const marked = cuts.some((cut) => cut > content.start && cut < content.last)
  if (marked) return segments

  // No bar lines: fit the bars to the notes. The first note opens the bar, so
  // there is no bar-line clearance to discount here.
  // Rounded to the nearest whole bar on the tab's own grid: one column is a
  // sixteenth, so notes written two apart are eighths and sixteen columns are a
  // bar of 4/4. Rounding down instead would fold a staff of fifteen eighths into
  // one bar and print them as sixteenths.
  const nominal = beatsPerBar * COLS_PER_BEAT
  const span = content.end - content.start
  const bars = Math.max(1, Math.round(span / nominal))
  const step = span / bars
  return Array.from({ length: bars }, (_, i) => ({
    start: content.start + Math.round(i * step),
    // The last bar runs to the end of the notes, whatever rounding did.
    end: i === bars - 1 ? content.end : content.start + Math.round((i + 1) * step),
    padded: false,
  }))
}

/**
 * The stretch of a staff that actually holds music.
 *
 * It runs from the first onset to one grid step past the last, because the
 * closing note occupies its own time: ending the region on that note would push
 * it to the end of the bar and drag everything before it late, so four evenly
 * spaced notes would not come out on four even beats. The step is the tightest
 * gap between onsets — the grid the tabber wrote on — capped at a beat, since a
 * staff holding only a couple of notes says nothing about the grid and its one
 * huge gap would otherwise stretch the whole staff.
 */
interface Content {
  /** Column of the first onset. */
  start: number
  /** Column of the last onset, which is where the music stops. */
  last: number
  /** One grid step past the last onset, so the closing note has its own time. */
  end: number
}

function contentExtent(columns: number[]): Content {
  const starts = onsetGroups(columns).map((group) => group[0])
  const gaps = starts.slice(1).map((col, i) => col - starts[i])
  const step = Math.min(gaps.length > 0 ? Math.min(...gaps) : COLS_PER_BEAT, COLS_PER_BEAT)
  const last = starts[starts.length - 1]
  return { start: starts[0], last, end: last + step }
}

/** Columns close enough together to be one chord, grouped and in order. */
function onsetGroups(columns: number[]): number[][] {
  const sorted = [...new Set(columns)].sort((a, b) => a - b)
  const groups: number[][] = []
  for (const col of sorted) {
    const open = groups[groups.length - 1]
    if (open && col - open[0] <= CHORD_TOL) open.push(col)
    else groups.push([col])
  }
  return groups
}

function quantise(beat: number): number {
  return Math.round(beat / BEAT_GRID) * BEAT_GRID
}

/** One staff of plain-text tab, with whatever was printed above it. */
export interface AsciiBlock {
  /** The six string lines, highest string first, as printed. */
  strings: string[]
  /** A section name printed above the staff, such as `Intro`. */
  marker?: string
}

export interface AsciiMeta {
  title: string | null
  artist: string | null
  /** A tuning instruction printed with the tab, verbatim. */
  tuningNote?: string | null
  bpm?: number
  beatsPerBar?: number
}

/**
 * Build a score from plain-text staves.
 *
 * Returns null when nothing playable was found, so a page of prose cannot enter
 * the library as a tab with no notes in it.
 */
export function scoreFromAscii(
  blocks: readonly AsciiBlock[],
  meta: AsciiMeta,
): ParsedScore | null {
  const beatsPerBar = meta.beatsPerBar ?? DEFAULT_BEATS_PER_BAR
  const measures: ScoreMeasure[] = []
  const notes: ScoreNote[] = []
  let unreadCount = 0
  let systemIndex = 0

  for (const block of blocks) {
    if (block.strings.length !== STRINGS) continue
    const bodies = block.strings.map(staffBody)
    const width = Math.max(...bodies.map((b) => b.length))
    if (width === 0) continue

    const onStrings: Array<RawNote & { stringIdx: number }> = []
    bodies.forEach((body, line) => {
      const read = readStaffLine(body)
      unreadCount += read.unread
      // Tab is written with the highest string on top; the app counts up from
      // the low E.
      for (const note of read.notes) onStrings.push({ ...note, stringIdx: STRINGS - 1 - line })
    })
    // A staff of nothing but rests would only add empty bars to the score.
    if (onStrings.length === 0) continue

    // Where the music actually sits on the line, which is what bars are fitted
    // to when the tabber marked none.
    const segments = barSegments(
      bodies,
      width,
      beatsPerBar,
      contentExtent(onStrings.map((n) => n.col)),
    )
    let firstOfBlock = true
    for (const segment of segments) {
      const measureIndex = measures.length
      const startBeat = measureIndex * beatsPerBar
      const inBar = onStrings.filter((n) => n.col >= segment.start && n.col < segment.end)
      const span = segment.end - segment.start
      const origin = segment.start + (segment.padded ? BAR_PAD_COLS : 0)
      const groups = onsetGroups(inBar.map((n) => n.col))

      const onsetBeats: number[] = []
      for (const group of groups) {
        const raw = span <= 0 ? 0 : ((group[0] - origin) / span) * beatsPerBar
        let beat = quantise(Math.min(beatsPerBar, Math.max(0, raw)))
        const prev = onsetBeats[onsetBeats.length - 1]
        // Kept strictly in order, so two onsets never collapse onto one beat.
        if (prev !== undefined && beat <= prev) beat = prev + BEAT_GRID
        onsetBeats.push(Math.min(beat, beatsPerBar - BEAT_GRID))
      }

      groups.forEach((group, i) => {
        const beat = onsetBeats[i]
        const next = onsetBeats[i + 1] ?? beatsPerBar
        const length = Math.max(BEAT_GRID, next - beat)
        for (const note of inBar) {
          if (!group.includes(note.col)) continue
          notes.push({
            measureIndex,
            stringIdx: note.stringIdx,
            fret: note.fret,
            ghost: note.ghost,
            beat: startBeat + beat,
            length,
            art: note.art,
            bend: note.bend,
          })
        }
      })

      measures.push({
        index: measureIndex,
        pageIndex: 0,
        systemIndex,
        startBeat,
        beats: beatsPerBar,
        marker: firstOfBlock ? block.marker : undefined,
      })
      firstOfBlock = false
    }
    systemIndex += 1
  }

  if (notes.length === 0) return null

  const warnings = [
    'Plain-text tab carries no rhythm, so the timing here was inferred from how the notes ' +
      'are spaced. The frets are exactly as written; the tempo is a starting guess.',
  ]
  if (unreadCount > 0) {
    warnings.push(
      `${unreadCount} mark${unreadCount === 1 ? '' : 's'} in the tab could not be read and ` +
        'were skipped.',
    )
  }

  return {
    title: meta.title,
    artist: meta.artist,
    bpm: meta.bpm ?? DEFAULT_BPM,
    beatsPerBar,
    tuningNote: meta.tuningNote ?? null,
    tuningShift: 0,
    measures,
    notes,
    warnings,
    pageCount: 1,
    unreadCount,
  }
}
