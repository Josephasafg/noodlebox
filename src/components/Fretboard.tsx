import { useEffect, useMemo, useRef } from 'react'
import type { FretNote } from '../theory/fretboard'
import { FRET_COUNT, scaleSequence } from '../theory/fretboard'
import { noteName } from '../theory/notes'
import { useSequencePlayhead } from '../hooks/useSequencePlayhead'
import styles from './Fretboard.module.css'

export const FB_VIEW_W = 1320
export const FB_VIEW_H = 300
export const FB_PAD_L = 60
export const FB_PAD_R = 28
export const FB_PAD_T = 48
export const FB_PAD_B = 44

const STRINGS = 6
const STRING_SPACING = (FB_VIEW_H - FB_PAD_T - FB_PAD_B) / (STRINGS - 1)
const SCALE_LENGTH_MULT = 2.2

export function fretX(fret: number): number {
  const neckW = FB_VIEW_W - FB_PAD_L - FB_PAD_R
  const virtual = neckW * SCALE_LENGTH_MULT
  if (fret === 0) return FB_PAD_L
  const distance = virtual * (1 - Math.pow(2, -fret / 12))
  const last = virtual * (1 - Math.pow(2, -FRET_COUNT / 12))
  return FB_PAD_L + (distance / last) * neckW
}

export function stringY(stringIdx: number): number {
  const visualRow = STRINGS - 1 - stringIdx
  return FB_PAD_T + visualRow * STRING_SPACING
}

export function fretCenterX(fret: number): number {
  if (fret === 0) return FB_PAD_L - 24
  return (fretX(fret - 1) + fretX(fret)) / 2
}

const SINGLE_DOTS = [3, 5, 7, 9, 15, 17, 19, 21]
const DOUBLE_DOTS = [12]
const FRET_NUMBERS = [0, 3, 5, 7, 9, 12, 15, 17, 19, 21]

interface FretboardProps {
  notes: FretNote[]
  highlightRangeStart: number
  highlightRangeEnd: number
  scaleName?: string
  isPlaying?: boolean
  playStartPerf?: number | null
}

export function Fretboard({
  notes,
  highlightRangeStart,
  highlightRangeEnd,
  scaleName,
  isPlaying = false,
  playStartPerf = null,
}: FretboardProps) {
  const sequence = useMemo(() => scaleSequence(notes), [notes])
  const playIdx = useSequencePlayhead(sequence.length, 260, isPlaying, playStartPerf)
  const playingKey =
    playIdx >= 0 ? `${sequence[playIdx].stringIdx}-${sequence[playIdx].fret}` : null

  const rangeX = fretX(Math.max(0, highlightRangeStart - 1))
  const rangeW = fretX(Math.min(FRET_COUNT, highlightRangeEnd)) - rangeX

  const scrollerRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    if (el.scrollWidth <= el.clientWidth + 8) return
    const ratio = el.scrollWidth / FB_VIEW_W
    const targetCenter = (rangeX + rangeW / 2) * ratio
    const desiredScrollLeft = Math.max(0, targetCenter - el.clientWidth / 2)
    el.scrollTo({ left: desiredScrollLeft, behavior: 'smooth' })
  }, [rangeX, rangeW])

  return (
    <div className={styles.scroller} ref={scrollerRef}>
    <svg
      viewBox={`0 0 ${FB_VIEW_W} ${FB_VIEW_H}`}
      preserveAspectRatio="xMidYMid meet"
      className={styles.svg}
      role="img"
      aria-label={scaleName ? `${scaleName} — fretboard diagram` : 'Fretboard scale diagram'}
    >
      <defs>
        <linearGradient id="fb-range" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0.25" />
        </linearGradient>
        <radialGradient id="fb-play" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%" stopColor="#ff8a65" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#ff8a65" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* range wash */}
      <rect
        x={rangeX}
        y={FB_PAD_T - 16}
        width={rangeW}
        height={FB_VIEW_H - FB_PAD_T - FB_PAD_B + 32}
        rx={20}
        fill="url(#fb-range)"
        opacity={0.55}
      />

      {/* inlay dots */}
      {SINGLE_DOTS.map((f) => (
        <circle
          key={`d${f}`}
          cx={fretCenterX(f)}
          cy={(stringY(0) + stringY(5)) / 2}
          r={3.5}
          fill="var(--fb-inlay)"
        />
      ))}
      {DOUBLE_DOTS.map((f) => (
        <g key={`dd${f}`}>
          <circle cx={fretCenterX(f)} cy={stringY(4) + 6} r={3.5} fill="var(--fb-inlay)" />
          <circle cx={fretCenterX(f)} cy={stringY(1) - 6} r={3.5} fill="var(--fb-inlay)" />
        </g>
      ))}

      {/* frets */}
      {Array.from({ length: FRET_COUNT + 1 }, (_, i) => i).map((f) => (
        <line
          key={`f${f}`}
          x1={fretX(f)}
          y1={FB_PAD_T - 6}
          x2={fretX(f)}
          y2={FB_VIEW_H - FB_PAD_B + 6}
          stroke={f === 0 ? 'var(--fb-nut)' : 'var(--fb-fret)'}
          strokeWidth={f === 0 ? 3 : 1}
        />
      ))}

      {/* strings */}
      {Array.from({ length: STRINGS }, (_, s) => s).map((s) => (
        <line
          key={`s${s}`}
          x1={FB_PAD_L - 4}
          y1={stringY(s)}
          x2={FB_VIEW_W - FB_PAD_R}
          y2={stringY(s)}
          stroke="var(--fb-string)"
          strokeWidth={0.8 + s * 0.14}
        />
      ))}

      {/* fret numbers */}
      {FRET_NUMBERS.map((f) => (
        <text
          key={`n${f}`}
          x={f === 0 ? FB_PAD_L - 22 : fretCenterX(f)}
          y={FB_VIEW_H - 14}
          textAnchor="middle"
          className={styles.fretnum}
        >
          {f}
        </text>
      ))}

      {/* notes */}
      {notes.map((n) => {
        const cx = n.fret === 0 ? FB_PAD_L - 18 : fretCenterX(n.fret)
        const cy = stringY(n.stringIdx)
        const key = `${n.stringIdx}-${n.fret}`
        const playing = key === playingKey
        const name = noteName(n.pitch)
        return (
          <g key={key}>
            <title>
              {n.isRoot ? `Root ${name}` : name} · string {n.stringIdx + 1} · fret {n.fret}
            </title>
            {playing && <circle cx={cx} cy={cy} r={28} fill="url(#fb-play)" />}
            <circle
              cx={cx}
              cy={cy}
              r={n.isRoot ? 14 : 13}
              fill={n.isRoot ? 'var(--accent-peach)' : '#ffffff'}
              stroke={n.isRoot ? 'var(--accent-peach)' : 'var(--ink)'}
              strokeWidth={n.isRoot ? 0 : 1.2}
            />
            <text
              x={cx}
              y={cy + 4}
              textAnchor="middle"
              className={n.isRoot ? styles.noteLabelRoot : styles.noteLabel}
            >
              {name}
            </text>
            {n.isRoot && (
              <circle
                cx={cx}
                cy={cy}
                r={14}
                fill="none"
                stroke="var(--accent-peach)"
                strokeWidth={0.8}
                opacity={0.6}
                className={styles.rootRing}
                style={{ transformOrigin: `${cx}px ${cy}px` }}
              />
            )}
          </g>
        )
      })}
    </svg>
    </div>
  )
}
