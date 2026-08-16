import { useEffect, useMemo, useRef } from 'react'
import { Portal } from './Portal'
import { FRET_COUNT } from '../theory/fretboard'
import { LEGATO_SYMBOL } from '../tabpdf/notation'
import type { NoteChange } from '../tabpdf/edit'
import type { Articulation } from '../theory/licks'
import type { ParsedScore } from '../tabpdf/types'
import styles from './NoteEditor.module.css'

/** Tab prints the low E at the bottom, so the letters read upwards. */
const STRING_LETTERS = ['E', 'A', 'D', 'G', 'B', 'e'] as const

/**
 * How a note is arrived at.
 *
 * These are the four marks a tab prints between two numbers, plus the plain
 * attack that is the absence of one. Bends are left alone: they are read from
 * an amount printed above the staff, not from a mark between the notes.
 */
const ATTACKS: ReadonlyArray<{ value: Articulation | null; label: string; symbol: string }> = [
  { value: null, label: 'Picked', symbol: '·' },
  { value: 'hammer', label: 'Hammer-on', symbol: 'h' },
  { value: 'pull', label: 'Pull-off', symbol: 'p' },
  { value: 'slide-up', label: 'Slide up', symbol: '/' },
  { value: 'slide-down', label: 'Slide down', symbol: '\\' },
]

/** Beyond this many beats apart, two notes are not really joined by a slur. */
const MAX_SPAN_BEATS = 8

/** Card width, matching the stylesheet, and the gap it keeps from the window. */
const CARD_W = 260
const MARGIN = 8
/** About what the card stands when nothing has been squeezed. */
const CARD_H = 280

/**
 * Where the card sits, given the note it belongs to.
 *
 * A note low on the page has no room beneath it, so the card opens upwards
 * instead — anchored by its bottom edge, which is what lets it be placed without
 * having measured how tall it turned out. Whichever way it opens it is told how
 * much room it has, so a short window scrolls the card rather than cutting it.
 */
function place(anchor: DOMRect, view: { width: number; height: number }) {
  const below = view.height - anchor.bottom - MARGIN * 2
  const above = anchor.top - MARGIN * 2
  const openUp = below < CARD_H && above > below
  return {
    ...(openUp
      ? { bottom: Math.round(Math.max(MARGIN, view.height - anchor.top + MARGIN)) }
      : { top: Math.round(anchor.bottom + MARGIN) }),
    left: Math.round(
      Math.max(MARGIN, Math.min(anchor.left - 60, view.width - CARD_W - MARGIN)),
    ),
    maxHeight: Math.round(Math.max(120, openUp ? above : below)),
  }
}

interface Props {
  score: ParsedScore
  /** Index into `score.notes` of the note being edited. */
  noteIndex: number
  /** Where the note sits on screen, so the editor can open beside it. */
  anchor: DOMRect
  onChange: (index: number, change: NoteChange) => void
  onClose: () => void
}

/** The note this one is joined to: the last thing sounded on the same string. */
function previousOnString(score: ParsedScore, index: number): number | null {
  const note = score.notes[index]
  for (let i = index - 1; i >= 0; i--) {
    const candidate = score.notes[i]
    if (note.beat - candidate.beat > MAX_SPAN_BEATS) break
    if (candidate.stringIdx !== note.stringIdx) continue
    if (candidate.beat >= note.beat) continue
    return i
  }
  return null
}

/**
 * A single note of an imported tab, opened by clicking it on the staff.
 *
 * A tab read from a video is usually right about where the notes are and wrong
 * about how they are joined — a slur mark the reader could not identify, a fret
 * read as the wrong digit — so this fixes one note at a time, in place, rather
 * than asking anyone to import the whole thing again.
 */
export function NoteEditor({ score, noteIndex, anchor, onChange, onClose }: Props) {
  const note = score.notes[noteIndex]
  const cardRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      // Stop the transport hearing it as well — this is a field, not the page.
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // Clicking anywhere else puts the editor away, including on another note —
  // which then opens its own.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!cardRef.current?.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [onClose])

  /** How the edit will read on the staff, e.g. `7h9`. */
  const reading = useMemo(() => {
    if (!note) return ''
    const label = note.fret === null ? 'x' : String(note.fret)
    const symbol = note.art ? LEGATO_SYMBOL[note.art] : undefined
    if (!symbol) return label
    const source = previousOnString(score, noteIndex)
    const from = source === null ? null : score.notes[source].fret
    return `${from ?? ''}${symbol}${label}`
  }, [note, score, noteIndex])

  if (!note) return null

  const measure = score.measures[note.measureIndex]
  const beatInBar = note.beat - (measure?.startBeat ?? 0)
  const setFret = (fret: number) =>
    onChange(noteIndex, { fret: Math.max(0, Math.min(FRET_COUNT, fret)) })

  return (
    <Portal>
      <div
        ref={cardRef}
        className={styles.card}
        role="dialog"
        aria-label={`Bar ${note.measureIndex + 1}, beat ${beatInBar + 1}, ${STRING_LETTERS[note.stringIdx]} string`}
        style={place(anchor, { width: window.innerWidth, height: window.innerHeight })}
      >
        <header className={styles.head}>
          <span className={styles.where}>
            Bar {note.measureIndex + 1} · beat {beatInBar + 1} · {STRING_LETTERS[note.stringIdx]}{' '}
            string
          </span>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Done">
            ✕
          </button>
        </header>

        <div className={styles.row}>
          <span className={styles.label}>Fret</span>
          <span className={styles.stepper}>
            <button
              type="button"
              onClick={() => setFret((note.fret ?? 0) - 1)}
              disabled={note.fret === null || note.fret === 0}
              aria-label="Down a fret"
            >
              −
            </button>
            <input
              className={styles.fret}
              type="number"
              min={0}
              max={FRET_COUNT}
              inputMode="numeric"
              aria-label="Fret"
              value={note.fret ?? ''}
              onChange={(e) => {
                const value = Number(e.target.value)
                if (e.target.value === '' || Number.isNaN(value)) return
                setFret(value)
              }}
            />
            <button
              type="button"
              onClick={() => setFret((note.fret ?? 0) + 1)}
              disabled={note.fret === null || note.fret === FRET_COUNT}
              aria-label="Up a fret"
            >
              +
            </button>
          </span>
        </div>

        <div className={styles.row}>
          <span className={styles.label}>Played</span>
          <span className={styles.attacks} role="radiogroup" aria-label="How this note is played">
            {ATTACKS.map((attack) => (
              <button
                key={attack.label}
                type="button"
                role="radio"
                aria-checked={(note.art ?? null) === attack.value}
                className={`${styles.attack} ${(note.art ?? null) === attack.value ? styles.attackOn : ''}`}
                onClick={() => onChange(noteIndex, { art: attack.value })}
                title={attack.label}
              >
                <span className={styles.attackSymbol} aria-hidden="true">
                  {attack.symbol}
                </span>
                {attack.label}
              </button>
            ))}
          </span>
        </div>

        <p className={styles.reads}>
          Reads <span className={styles.reading}>{reading}</span>
        </p>
      </div>
    </Portal>
  )
}
