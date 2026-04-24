import type { FretNote } from '../theory/fretboard'
import { FRET_COUNT, STANDARD_TUNING } from '../theory/fretboard'
import { noteName, PITCH_NAMES_SHARP } from '../theory/notes'
import styles from './Fretboard.module.css'

interface FretboardProps {
  notes: FretNote[]
  highlightRangeStart?: number
  highlightRangeEnd?: number
  showNoteNames?: boolean
  scaleName?: string
}

const VIEW_W = 1360
const VIEW_H = 280
const PAD_L = 58
const PAD_R = 30
const PAD_T = 42
const PAD_B = 38

const STRINGS = 6
const STRING_SPACING = (VIEW_H - PAD_T - PAD_B) / (STRINGS - 1)

const SCALE_LENGTH_MULTIPLIER = 2.2

function fretX(fret: number): number {
  const neckW = VIEW_W - PAD_L - PAD_R
  const virtualScale = neckW * SCALE_LENGTH_MULTIPLIER
  const nutX = PAD_L
  if (fret === 0) return nutX
  const distanceFromNut = virtualScale * (1 - Math.pow(2, -fret / 12))
  const lastDistance = virtualScale * (1 - Math.pow(2, -FRET_COUNT / 12))
  return nutX + (distanceFromNut / lastDistance) * neckW
}

function stringY(stringIdx: number): number {
  // stringIdx 0 = low E (lowest pitch, bottom of diagram)
  const visualRow = STRINGS - 1 - stringIdx
  return PAD_T + visualRow * STRING_SPACING
}

function fretCenterX(fret: number): number {
  if (fret === 0) return PAD_L - 22
  return (fretX(fret - 1) + fretX(fret)) / 2
}

const SINGLE_DOT_FRETS = [3, 5, 7, 9, 15, 17, 19, 21]
const DOUBLE_DOT_FRETS = [12]

export function Fretboard({
  notes,
  highlightRangeStart,
  highlightRangeEnd,
  showNoteNames = true,
  scaleName,
}: FretboardProps) {
  const stringWeights = [2.1, 1.7, 1.35, 1.1, 0.9, 0.75]
  const highlightLeftExtension = highlightRangeStart === 0 ? 42 : 0

  return (
    <svg
      className={styles.fretboard}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      role="img"
      aria-label={scaleName ? `${scaleName} — fretboard diagram` : 'Fretboard scale diagram'}
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <linearGradient id="fretwire" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#b8a78a" />
          <stop offset="45%" stopColor="#7a6b56" />
          <stop offset="100%" stopColor="#5c4f3f" />
        </linearGradient>
        <linearGradient id="neck" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--fretboard-wood)" />
          <stop offset="100%" stopColor="var(--fretboard-wood-edge)" />
        </linearGradient>
        <filter id="grain" x="0" y="0">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="3" />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 0.35  0 0 0 0 0.28  0 0 0 0 0.2  0 0 0 0.06 0"
          />
          <feComposite in2="SourceGraphic" operator="in" />
        </filter>
      </defs>

      {/* neck */}
      <rect
        x={PAD_L}
        y={PAD_T - 18}
        width={VIEW_W - PAD_L - PAD_R}
        height={VIEW_H - PAD_T - PAD_B + 36}
        fill="url(#neck)"
      />
      <rect
        x={PAD_L}
        y={PAD_T - 18}
        width={VIEW_W - PAD_L - PAD_R}
        height={VIEW_H - PAD_T - PAD_B + 36}
        fill="transparent"
        filter="url(#grain)"
      />

      {/* highlight band */}
      {highlightRangeStart !== undefined && highlightRangeEnd !== undefined && (
        <rect
          x={fretX(Math.max(0, highlightRangeStart - 1)) - highlightLeftExtension}
          y={PAD_T - 16}
          width={
            fretX(Math.min(FRET_COUNT, highlightRangeEnd)) -
            fretX(Math.max(0, highlightRangeStart - 1)) +
            highlightLeftExtension
          }
          height={VIEW_H - PAD_T - PAD_B + 32}
          fill="var(--accent-wash)"
        />
      )}

      {/* fret markers (inlay dots) */}
      {SINGLE_DOT_FRETS.map((f) => (
        <circle
          key={`dot-${f}`}
          cx={fretCenterX(f)}
          cy={(stringY(0) + stringY(5)) / 2}
          r={5}
          fill="var(--hairline)"
        />
      ))}
      {DOUBLE_DOT_FRETS.map((f) => (
        <g key={`ddot-${f}`}>
          <circle
            cx={fretCenterX(f)}
            cy={stringY(3) + STRING_SPACING * 0.4}
            r={5}
            fill="var(--hairline)"
          />
          <circle
            cx={fretCenterX(f)}
            cy={stringY(2) - STRING_SPACING * 0.4}
            r={5}
            fill="var(--hairline)"
          />
        </g>
      ))}

      {/* frets */}
      {Array.from({ length: FRET_COUNT + 1 }, (_, i) => i).map((f) => (
        <line
          key={`fret-${f}`}
          x1={fretX(f)}
          y1={PAD_T - 10}
          x2={fretX(f)}
          y2={VIEW_H - PAD_B + 10}
          stroke={f === 0 ? 'var(--ink)' : 'url(#fretwire)'}
          strokeWidth={f === 0 ? 5 : 2.2}
          strokeLinecap="square"
        />
      ))}

      {/* strings */}
      {Array.from({ length: STRINGS }, (_, i) => i).map((s) => (
        <line
          key={`string-${s}`}
          x1={PAD_L - 4}
          y1={stringY(s)}
          x2={VIEW_W - PAD_R}
          y2={stringY(s)}
          stroke="var(--string)"
          strokeWidth={stringWeights[s]}
          strokeLinecap="round"
        />
      ))}

      {/* fret numbers below */}
      {Array.from({ length: FRET_COUNT + 1 }, (_, i) => i)
        .filter((f) => f === 0 || SINGLE_DOT_FRETS.includes(f) || DOUBLE_DOT_FRETS.includes(f))
        .map((f) => (
          <text
            key={`num-${f}`}
            x={f === 0 ? PAD_L - 18 : fretCenterX(f)}
            y={VIEW_H - 12}
            textAnchor="middle"
            className={styles.fretNumber}
          >
            {f}
          </text>
        ))}

      {/* open string labels */}
      {STANDARD_TUNING.map((pc, s) => (
        <text
          key={`tuning-${s}`}
          x={PAD_L - 32}
          y={stringY(s) + 4}
          textAnchor="middle"
          className={styles.tuningLabel}
        >
          {PITCH_NAMES_SHARP[pc].replace('♯', '♯')}
        </text>
      ))}

      {/* notes */}
      {notes.map((note) => {
        const cx = note.fret === 0 ? PAD_L - 18 : fretCenterX(note.fret)
        const cy = stringY(note.stringIdx)
        const r = 14
        const name = noteName(note.pitch)
        const ariaLabel = note.isRoot
          ? `Root ${name}, string ${note.stringIdx + 1}, fret ${note.fret}`
          : `${name}, string ${note.stringIdx + 1}, fret ${note.fret}`
        return (
          <g key={`note-${note.stringIdx}-${note.fret}`} role="presentation">
            <title>{ariaLabel}</title>
            <circle
              cx={cx}
              cy={cy}
              r={r}
              fill={note.isRoot ? 'var(--accent)' : 'var(--paper)'}
              stroke={note.isRoot ? 'var(--accent-deep)' : 'var(--ink)'}
              strokeWidth={note.isRoot ? 1.2 : 1.6}
            />
            {showNoteNames && (
              <text
                x={cx}
                y={cy + 4}
                textAnchor="middle"
                className={note.isRoot ? styles.noteLabelRoot : styles.noteLabel}
              >
                {name}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}
