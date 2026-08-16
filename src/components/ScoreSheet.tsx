import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { ParsedScore, ScoreNote } from '../tabpdf/types'
import { bendMark, legatoSpans, type LegatoSpan } from '../tabpdf/notation'
import styles from './ScoreSheet.module.css'

/** Vertical gap between string lines. Fixed, so the tab reads the same at any width. */
const STRING_GAP = 22
const STRINGS = 6

const PAD_L = 28
const PAD_R = 10
/** Room above the staff for bar numbers and section labels. */
const PAD_T = 34
const PAD_B = 14

/** Narrowest a bar may be drawn before fitting fewer of them per row. */
const MIN_MEASURE_W = 168
const MAX_PER_ROW = 4
const SSR_MEASURE_W = 220

/** Keeps a note on beat one clear of the bar line it follows. */
const NOTE_INSET = 16
const NOTE_TAIL = 12

const STRING_LETTERS = ['e', 'B', 'G', 'D', 'A', 'E'] as const

const NO_ACTIVE: readonly number[] = []

const STAFF_H = (STRINGS - 1) * STRING_GAP
const ROW_H = PAD_T + STAFF_H + PAD_B

/** Row y for a string index, where 0 is the low E — tab prints it at the bottom. */
function rowY(stringIdx: number): number {
  return PAD_T + (STRINGS - 1 - stringIdx) * STRING_GAP
}

function noteLabel(note: ScoreNote): string {
  if (note.fret === null) return 'x'
  return note.ghost ? `(${note.fret})` : String(note.fret)
}

interface RowProps {
  score: ParsedScore
  /** Bar indices drawn on this row. */
  measureIndices: number[]
  notesByMeasure: Map<number, Array<{ note: ScoreNote; index: number }>>
  /** Legato symbols keyed by the index of the note they lead into. */
  legatoByTarget: Map<number, LegatoSpan>
  measureW: number
  width: number
  /** Playhead in beats within the score, or null when it is not on this row. */
  beat: number | null
  activeNotes: readonly number[]
  playingMeasure: number | null
  onPlayFrom: (measureIndex: number) => void
  /** Open a note for correction, beside where it is engraved. */
  onEditNote: (noteIndex: number, anchor: DOMRect) => void
}

const ScoreRow = memo(function ScoreRow({
  score,
  measureIndices,
  notesByMeasure,
  legatoByTarget,
  measureW,
  width,
  beat,
  activeNotes,
  playingMeasure,
  onPlayFrom,
  onEditNote,
}: RowProps) {
  const active = useMemo(() => new Set(activeNotes), [activeNotes])
  const staffW = measureIndices.length * measureW
  const measureX = (slot: number) => PAD_L + slot * measureW

  /** Where a beat inside a bar falls, in the drawing's own coordinates. */
  const noteX = (slot: number, beatInMeasure: number) => {
    const usable = measureW - NOTE_INSET - NOTE_TAIL
    return measureX(slot) + NOTE_INSET + (beatInMeasure / score.beatsPerBar) * usable
  }

  // Placed up front so a legato symbol can sit between the two numbers it joins.
  const placed = measureIndices.flatMap((mi, slot) => {
    const startBeat = score.measures[mi]?.startBeat ?? 0
    return (notesByMeasure.get(mi) ?? []).map(({ note, index }) => ({
      note,
      index,
      x: noteX(slot, note.beat - startBeat),
      y: rowY(note.stringIdx),
    }))
  })
  const xByIndex = new Map(placed.map((p) => [p.index, p.x]))

  /** Everything drawn on the staff, flattened so masks and glyphs can be layered. */
  interface Glyph {
    key: string
    kind: 'fret' | 'legato' | 'bend'
    /** Index into the score's notes; the note itself for a symbol beside it. */
    index: number
    label: string
    x: number
    y: number
    boxW: number
    /** Bend marks are set after the fret number rather than centred on it. */
    anchor: 'middle' | 'start'
    ghost: boolean
    /** Width of the highlight drawn behind this glyph while it sounds. */
    glowW?: number
  }
  /** Width of the box a run of characters needs, matching the mono fret font. */
  const boxFor = (label: string) => 7 + label.length * 7
  const glyphs: Glyph[] = []
  for (const { note, index, x, y } of placed) {
    const span = legatoByTarget.get(index)
    if (span) {
      const sourceX = span.source === null ? undefined : xByIndex.get(span.source)
      // Between the two numbers when both are on this row, otherwise to the left
      // of this one — the way plain-text tab writes a lone /9.
      glyphs.push({
        key: `l${index}`,
        kind: 'legato',
        index,
        label: span.symbol,
        x: sourceX === undefined ? x - 11 : (sourceX + x) / 2,
        y,
        boxW: 9,
        anchor: 'middle',
        ghost: false,
      })
    }
    const label = noteLabel(note)
    const boxW = boxFor(label)
    const bend = bendMark(note)
    const bendW = bend === null ? 0 : boxFor(bend) - 4
    glyphs.push({
      key: `f${index}`,
      kind: 'fret',
      index,
      label,
      x,
      y,
      boxW,
      anchor: 'middle',
      ghost: note.ghost,
      // The highlight covers the bend as well, so `8b10` lights as one thing.
      glowW: boxW + bendW,
    })
    if (bend !== null) {
      // The fret number keeps its place on the beat, so the bend goes after it.
      glyphs.push({
        key: `b${index}`,
        kind: 'bend',
        index,
        label: bend,
        x: x + boxW / 2 - 2,
        y,
        boxW: bendW,
        anchor: 'start',
        ghost: note.ghost,
      })
    }
  }

  return (
    <svg
      className={styles.row}
      viewBox={`0 0 ${width} ${ROW_H}`}
      width={width}
      height={ROW_H}
      role="img"
      aria-label={`Bars ${measureIndices[0] + 1} to ${measureIndices[measureIndices.length - 1] + 1}`}
    >
      {/* Clickable bar backgrounds, drawn first so notation sits over them. */}
      {measureIndices.map((mi, slot) => (
        <rect
          key={`hit-${mi}`}
          className={`${styles.hit} ${mi === playingMeasure ? styles.hitOn : ''}`}
          x={measureX(slot)}
          y={PAD_T - 8}
          width={measureW}
          height={STAFF_H + 16}
          onClick={() => onPlayFrom(mi)}
        >
          <title>{`Play from bar ${mi + 1}`}</title>
        </rect>
      ))}

      {Array.from({ length: STRINGS }, (_, s) => (
        <line
          key={`str-${s}`}
          className={styles.string}
          x1={PAD_L}
          y1={rowY(s)}
          x2={PAD_L + staffW}
          y2={rowY(s)}
        />
      ))}

      {Array.from({ length: STRINGS }, (_, s) => (
        <text key={`letter-${s}`} className={styles.stringLetter} x={PAD_L - 10} y={rowY(s) + 3.5}>
          {STRING_LETTERS[STRINGS - 1 - s]}
        </text>
      ))}

      {measureIndices.map((mi, slot) => (
        <line
          key={`bar-${mi}`}
          className={styles.barline}
          x1={measureX(slot)}
          y1={rowY(STRINGS - 1)}
          x2={measureX(slot)}
          y2={rowY(0)}
        />
      ))}
      <line
        className={styles.barline}
        x1={PAD_L + staffW}
        y1={rowY(STRINGS - 1)}
        x2={PAD_L + staffW}
        y2={rowY(0)}
      />

      {measureIndices.map((mi, slot) => {
        const measure = score.measures[mi]
        return (
          <g key={`head-${mi}`}>
            <text className={styles.barNumber} x={measureX(slot) + 3} y={PAD_T - 12}>
              {mi + 1}
            </text>
            {measure?.marker && (
              <text className={styles.marker} x={measureX(slot) + 20} y={PAD_T - 12}>
                {measure.marker}
              </text>
            )}
          </g>
        )
      })}

      {/* Masks for every glyph first: a neighbouring note's mask would otherwise
          paint over a legato symbol wedged in beside it. */}
      {glyphs.map((g) => (
        <rect
          key={`m-${g.key}`}
          className={styles.noteMask}
          x={g.anchor === 'start' ? g.x : g.x - g.boxW / 2}
          y={g.y - (g.kind === 'legato' ? 6 : 7)}
          width={g.boxW}
          height={g.kind === 'legato' ? 12 : 14}
          rx={g.kind === 'legato' ? 2 : 3}
        />
      ))}

      {glyphs.map((g) =>
        g.glowW !== undefined && active.has(g.index) ? (
          <rect
            key={`g-${g.key}`}
            className={styles.noteGlow}
            x={g.x - g.boxW / 2 - 3}
            y={g.y - 9}
            width={g.glowW + 6}
            height={18}
            rx={9}
          />
        ) : null,
      )}

      {glyphs.map((g) => {
        if (g.kind === 'legato') {
          return (
            <text key={`t-${g.key}`} className={styles.legato} x={g.x} y={g.y + 3.5}>
              {g.label}
            </text>
          )
        }
        const on = active.has(g.index)
        return (
          <text
            key={`t-${g.key}`}
            className={`${g.kind === 'bend' ? styles.bend : styles.fret} ${on ? styles.fretOn : ''} ${
              g.ghost ? styles.fretGhost : ''
            }`}
            x={g.x}
            y={g.y + 4}
          >
            {g.label}
          </text>
        )
      })}

      {/* Hit targets for the notes, over the glyphs so a number and the mark
          beside it can each be picked up, and over the bar background so
          clicking a note corrects it while clicking the bar still plays it. */}
      {glyphs.map((g) => {
        const note = score.notes[g.index]
        if (!note) return null
        const beatInBar = note.beat - (score.measures[note.measureIndex]?.startBeat ?? 0)
        const where = `bar ${note.measureIndex + 1}, beat ${beatInBar + 1}, ${
          STRING_LETTERS[STRINGS - 1 - note.stringIdx]
        } string`
        return (
          <rect
            key={`e-${g.key}`}
            className={styles.noteHit}
            x={(g.anchor === 'start' ? g.x : g.x - g.boxW / 2) - 2}
            y={g.y - 9}
            width={g.boxW + 4}
            height={18}
            rx={5}
            onClick={(e) => onEditNote(g.index, e.currentTarget.getBoundingClientRect())}
          >
            <title>{g.kind === 'fret' ? `Edit ${where}` : `Edit the mark on ${where}`}</title>
          </rect>
        )
      })}

      {beat !== null &&
        (() => {
          const slot = measureIndices.findIndex(
            (mi) =>
              beat >= (score.measures[mi]?.startBeat ?? 0) &&
              beat < (score.measures[mi]?.startBeat ?? 0) + score.beatsPerBar,
          )
          if (slot === -1) return null
          const startBeat = score.measures[measureIndices[slot]].startBeat
          const x = noteX(slot, beat - startBeat)
          return (
            <line
              className={styles.playhead}
              x1={x}
              y1={PAD_T - 6}
              x2={x}
              y2={rowY(0) + 6}
            />
          )
        })()}
    </svg>
  )
})

interface Props {
  score: ParsedScore
  /** Playhead in beats from the start of the score, or null when stopped. */
  beat: number | null
  /** Indices into `score.notes` currently sounding. */
  activeNotes: readonly number[]
  playingMeasure: number | null
  onPlayFrom: (measureIndex: number) => void
  /** Open a note for correction, beside where it is engraved. */
  onEditNote: (noteIndex: number, anchor: DOMRect) => void
  /** Bar to bring into view; re-scrolls whenever the value changes. */
  scrollToMeasure?: number | null
}

export function ScoreSheet({
  score,
  beat,
  activeNotes,
  playingMeasure,
  onPlayFrom,
  onEditNote,
  scrollToMeasure = null,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [available, setAvailable] = useState<number | null>(null)

  useEffect(() => {
    const el = hostRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      setAvailable(entries[0].contentRect.width)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const legatoByTarget = useMemo(() => {
    const map = new Map<number, LegatoSpan>()
    for (const span of legatoSpans(score.notes)) map.set(span.target, span)
    return map
  }, [score.notes])

  const notesByMeasure = useMemo(() => {
    const map = new Map<number, Array<{ note: ScoreNote; index: number }>>()
    score.notes.forEach((note, index) => {
      const bucket = map.get(note.measureIndex)
      if (bucket) bucket.push({ note, index })
      else map.set(note.measureIndex, [{ note, index }])
    })
    return map
  }, [score])

  const { rows, measureW, width } = useMemo(() => {
    const usable = (available ?? SSR_MEASURE_W * MAX_PER_ROW + PAD_L + PAD_R) - PAD_L - PAD_R
    const perRow = Math.max(1, Math.min(MAX_PER_ROW, Math.floor(usable / MIN_MEASURE_W) || 1))
    const w = usable / perRow
    const out: number[][] = []
    for (let i = 0; i < score.measures.length; i += perRow) {
      out.push(score.measures.slice(i, i + perRow).map((m) => m.index))
    }
    return { rows: out, measureW: w, width: usable + PAD_L + PAD_R }
  }, [available, score.measures])

  /** Which row the playhead is on, so only that row re-renders while playing. */
  const liveRow = useMemo(() => {
    if (beat === null) return -1
    const measureIndex = Math.floor(beat / score.beatsPerBar)
    return rows.findIndex((r) => r.includes(measureIndex))
  }, [beat, rows, score.beatsPerBar])

  useEffect(() => {
    if (scrollToMeasure === null) return
    const host = hostRef.current
    if (!host) return
    const rowIndex = rows.findIndex((r) => r.includes(scrollToMeasure))
    const target = rowIndex === -1 ? null : host.children[rowIndex]
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [scrollToMeasure, rows])

  return (
    <div className={styles.host} ref={hostRef}>
      {rows.map((measureIndices, i) => (
        <ScoreRow
          key={measureIndices[0]}
          score={score}
          measureIndices={measureIndices}
          notesByMeasure={notesByMeasure}
          legatoByTarget={legatoByTarget}
          measureW={measureW}
          width={width}
          beat={i === liveRow ? beat : null}
          activeNotes={i === liveRow ? activeNotes : NO_ACTIVE}
          playingMeasure={playingMeasure}
          onPlayFrom={onPlayFrom}
          onEditNote={onEditNote}
        />
      ))}
    </div>
  )
}
