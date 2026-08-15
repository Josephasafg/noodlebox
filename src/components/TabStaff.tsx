import { useEffect, useMemo, useRef, useState } from 'react'
import type { Articulation, ResolvedLick, ResolvedLickNote } from '../theory/licks'
import styles from './TabStaff.module.css'

const STRINGS = 6
const ROW_H = 30
const PAD_L = 34
const PAD_R = 30
const PAD_T = 46
const PAD_B = 30

/** Shortest staff drawn, in beats, so a two-note lick still reads as a system. */
const MIN_STAFF_BEATS = 4

/**
 * Beats stretch to fill the panel rather than the whole staff scaling up, so
 * row height and fret numbers stay a constant, legible size at any width.
 */
const MIN_BEAT_W = 46
const MAX_BEAT_W = 200
const SSR_BEAT_W = 62

const NOTE_INSET = 16

/** Bar lines sit slightly left of the beat they open, clear of the fret number. */
const BAR_OFFSET = 14

/** Top-to-bottom string letters — high e first, as tab is always written. */
const STRING_LETTERS = ['e', 'B', 'G', 'D', 'A', 'E'] as const

const BEND_LABELS: Partial<Record<Articulation, string>> = {
  'bend-half': '½',
  'bend-full': 'full',
}

function rowY(stringIdx: number): number {
  return PAD_T + (STRINGS - 1 - stringIdx) * ROW_H
}

/**
 * Index of the note immediately before `note` on the same string, used to draw
 * hammer-on / pull-off arcs back to where the slur starts.
 */
function previousOnString(notes: readonly ResolvedLickNote[], index: number): number {
  const target = notes[index]
  for (let i = index - 1; i >= 0; i--) {
    if (notes[i].stringIdx === target.stringIdx) return i
  }
  return -1
}

/** Next note on the same string, so a slide can be drawn toward its destination. */
function nextOnString(notes: readonly ResolvedLickNote[], index: number): number {
  const target = notes[index]
  for (let i = index + 1; i < notes.length; i++) {
    if (notes[i].stringIdx === target.stringIdx) return i
  }
  return -1
}

interface Props {
  resolved: ResolvedLick
  /** Playhead position in beats, or null when stopped. */
  beat: number | null
  activeNotes: readonly number[]
}

export function TabStaff({ resolved, beat, activeNotes }: Props) {
  const { lick, notes, totalBeats } = resolved
  const active = useMemo(() => new Set(activeNotes), [activeNotes])

  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [available, setAvailable] = useState<number | null>(null)

  useEffect(() => {
    const el = scrollerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      setAvailable(entries[0].contentRect.width)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Always draw whole bars, so the staff closes on a bar line rather than
  // trailing off part-way through one.
  const filledBeats = Math.max(totalBeats, MIN_STAFF_BEATS)
  const barCount = Math.max(1, Math.ceil(filledBeats / lick.beatsPerBar))
  const staffBeats = barCount * lick.beatsPerBar
  const barLines = Array.from({ length: barCount + 1 }, (_, i) => i * lick.beatsPerBar)

  const chrome = PAD_L + NOTE_INSET - BAR_OFFSET + PAD_R
  const beatW =
    available === null
      ? SSR_BEAT_W
      : Math.min(MAX_BEAT_W, Math.max(MIN_BEAT_W, (available - chrome) / staffBeats))

  const beatX = (b: number) => PAD_L + NOTE_INSET + b * beatW
  const staffLeft = beatX(0) - BAR_OFFSET
  const staffRight = beatX(staffBeats) - BAR_OFFSET
  const width = staffRight + PAD_R
  const height = PAD_T + (STRINGS - 1) * ROW_H + PAD_B

  // Keep the playhead in view once beats are squeezed to their minimum width.
  useEffect(() => {
    const el = scrollerRef.current
    if (!el || beat === null) return
    if (el.scrollWidth <= el.clientWidth + 8) return
    const x = PAD_L + NOTE_INSET + beat * beatW
    if (x < el.scrollLeft + 40 || x > el.scrollLeft + el.clientWidth - 80) {
      el.scrollTo({ left: Math.max(0, x - el.clientWidth / 3), behavior: 'smooth' })
    }
  }, [beat, beatW])

  return (
    <div className={styles.scroller} ref={scrollerRef}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        className={styles.svg}
        role="img"
        aria-label={`${lick.name} — guitar tab`}
      >
        <defs>
          <marker
            id="tab-bend-arrow"
            viewBox="0 0 8 8"
            refX="4"
            refY="4"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--accent-peach)" />
          </marker>
        </defs>

        {/* string lines */}
        {Array.from({ length: STRINGS }, (_, s) => s).map((s) => (
          <line
            key={`line-${s}`}
            x1={staffLeft}
            y1={rowY(s)}
            x2={staffRight}
            y2={rowY(s)}
            stroke="var(--tab-line)"
            strokeWidth={1}
          />
        ))}

        {/* string letters */}
        {Array.from({ length: STRINGS }, (_, row) => row).map((row) => (
          <text
            key={`letter-${row}`}
            x={staffLeft - 12}
            y={PAD_T + row * ROW_H + 4}
            textAnchor="middle"
            className={styles.letter}
          >
            {STRING_LETTERS[row]}
          </text>
        ))}

        {/* bar lines */}
        {barLines.map((b) => (
          <line
            key={`bar-${b}`}
            x1={beatX(b) - BAR_OFFSET}
            y1={rowY(STRINGS - 1)}
            x2={beatX(b) - BAR_OFFSET}
            y2={rowY(0)}
            stroke="var(--tab-bar)"
            strokeWidth={b === 0 || b === staffBeats ? 2 : 1}
          />
        ))}

        {/* legato slurs and slides, drawn under the numbers */}
        {notes.map((n, i) => {
          const y = rowY(n.stringIdx)
          const x = beatX(n.beat)

          if (n.art === 'hammer' || n.art === 'pull') {
            const prev = previousOnString(notes, i)
            if (prev < 0) return null
            const px = beatX(notes[prev].beat)
            const midX = (px + x) / 2
            return (
              <g key={`slur-${i}`}>
                <path
                  d={`M ${px} ${y - 9} Q ${midX} ${y - 20} ${x} ${y - 9}`}
                  fill="none"
                  stroke="var(--tab-mark)"
                  strokeWidth={1.1}
                />
                <text x={midX} y={y - 22} textAnchor="middle" className={styles.mark}>
                  {n.art === 'hammer' ? 'h' : 'p'}
                </text>
              </g>
            )
          }

          if (n.art === 'slide-up' || n.art === 'slide-down') {
            const next = nextOnString(notes, i)
            const endX = next >= 0 ? beatX(notes[next].beat) - 10 : x + 22
            const dir = n.art === 'slide-up' ? -1 : 1
            return (
              <line
                key={`slide-${i}`}
                x1={x + 10}
                y1={y + 4 * dir}
                x2={endX}
                y2={y - 4 * dir}
                stroke="var(--tab-mark)"
                strokeWidth={1.4}
              />
            )
          }

          return null
        })}

        {/* fret numbers */}
        {notes.map((n, i) => {
          const y = rowY(n.stringIdx)
          const x = beatX(n.beat)
          const label = String(n.fret)
          const isActive = active.has(i)
          const boxW = label.length > 1 ? 24 : 17

          return (
            <g key={`note-${i}`}>
              <title>
                {`fret ${n.fret} on the ${STRING_LETTERS[STRINGS - 1 - n.stringIdx]} string${
                  n.art ? ` · ${n.art.replace('-', ' ')}` : ''
                }`}
              </title>
              <rect
                x={x - boxW / 2}
                y={y - 9}
                width={boxW}
                height={18}
                rx={5}
                fill={isActive ? 'var(--accent-peach)' : 'var(--tab-bg)'}
              />
              <text
                x={x}
                y={y + 4.5}
                textAnchor="middle"
                className={`${styles.fret} ${isActive ? styles.fretActive : ''}`}
              >
                {label}
              </text>

              {/* bend arrow above the number */}
              {BEND_LABELS[n.art as Articulation] !== undefined && (
                <g>
                  <path
                    d={`M ${x} ${y - 10} C ${x + 10} ${y - 14} ${x + 13} ${y - 20} ${x + 13} ${y - 26}`}
                    fill="none"
                    stroke="var(--accent-peach)"
                    strokeWidth={1.4}
                    markerEnd="url(#tab-bend-arrow)"
                  />
                  <text x={x + 20} y={y - 26} className={styles.bendLabel}>
                    {BEND_LABELS[n.art as Articulation]}
                  </text>
                </g>
              )}

              {n.art === 'vibrato' && (
                <path
                  d={`M ${x - 8} ${y - 14} q 4 -5 8 0 q 4 5 8 0 q 4 -5 8 0`}
                  fill="none"
                  stroke="var(--tab-mark)"
                  strokeWidth={1.3}
                />
              )}

              {n.art === 'harmonic' && (
                <path
                  d={`M ${x} ${y - 14} l 5 5 l -5 5 l -5 -5 z`}
                  fill="none"
                  stroke="var(--tab-mark)"
                  strokeWidth={1.1}
                />
              )}
            </g>
          )
        })}

        {/* playhead */}
        {beat !== null && (
          <line
            x1={beatX(beat)}
            y1={rowY(STRINGS - 1) - 12}
            x2={beatX(beat)}
            y2={rowY(0) + 12}
            stroke="var(--accent-peach)"
            strokeWidth={2}
            opacity={0.75}
          />
        )}
      </svg>
    </div>
  )
}
