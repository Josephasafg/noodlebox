import { useMemo, useState } from 'react'
import { ScoreSheet } from './ScoreSheet'
import type { ParsedScore } from '../tabpdf/types'
import styles from './ScorePanel.module.css'

const TUNING_OPTIONS = [
  { value: 0, label: 'Standard' },
  { value: -1, label: '½ step down' },
  { value: -2, label: 'Whole step down' },
  { value: -3, label: '1½ steps down' },
] as const

const BAR_LENGTHS = [4, 3, 6, 2] as const

interface Props {
  score: ParsedScore
  /** Playhead in beats from the start of the score, or null when stopped. */
  beat: number | null
  activeNotes: readonly number[]
  playingMeasure: number | null
  /** Bars a single press will play, so the control can say so. */
  playWindow: number
  onPlayFrom: (measureIndex: number) => void
  onBpmChange: (bpm: number) => void
  onTuningShiftChange: (shift: number) => void
  onBeatsPerBarChange: (beats: number) => void
  onClose: () => void
}

export function ScorePanel({
  score,
  beat,
  activeNotes,
  playingMeasure,
  playWindow,
  onPlayFrom,
  onBpmChange,
  onTuningShiftChange,
  onBeatsPerBarChange,
  onClose,
}: Props) {
  const [showNotes, setShowNotes] = useState(false)
  const [scrollTo, setScrollTo] = useState<number | null>(null)

  const sections = useMemo(
    () => score.measures.filter((m) => m.marker !== undefined),
    [score.measures],
  )

  return (
    <section className={styles.panel} aria-label={score.title ?? 'Imported tab'}>
      <header className={styles.head}>
        <div className={styles.headText}>
          <h2 className={styles.title}>
            {score.title ?? 'Imported tab'}
            {score.artist && (
              <>
                {' '}
                <span className={styles.dash}>—</span>{' '}
                <span className={styles.artist}>{score.artist}</span>
              </>
            )}
          </h2>
          <p className={styles.sub}>
            {score.measures.length} bars · {score.notes.length} notes · read from{' '}
            {score.pageCount} {score.pageCount === 1 ? 'page' : 'pages'}
          </p>
        </div>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Close tab">
          ✕
        </button>
      </header>

      <div className={styles.controls}>
        <label className={styles.control}>
          <span className={styles.controlLabel}>Tempo</span>
          <span className={styles.stepper}>
            <button
              type="button"
              onClick={() => onBpmChange(Math.max(40, score.bpm - 4))}
              aria-label="Slower"
            >
              −
            </button>
            <span className={styles.stepperValue}>{score.bpm}</span>
            <button
              type="button"
              onClick={() => onBpmChange(Math.min(240, score.bpm + 4))}
              aria-label="Faster"
            >
              +
            </button>
          </span>
        </label>

        <label className={styles.control}>
          <span className={styles.controlLabel}>Tuning</span>
          <select
            className={styles.select}
            value={score.tuningShift}
            onChange={(e) => onTuningShiftChange(Number(e.target.value))}
          >
            {TUNING_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.control}>
          <span className={styles.controlLabel}>Beats / bar</span>
          <select
            className={styles.select}
            value={score.beatsPerBar}
            onChange={(e) => onBeatsPerBarChange(Number(e.target.value))}
          >
            {BAR_LENGTHS.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>

        <span className={styles.hint}>
          Tap any bar to hear it — plays {playWindow} bars from there
        </span>
      </div>

      {sections.length > 0 && (
        <div className={styles.sections}>
          <span className={styles.controlLabel}>Jump to</span>
          <div className={styles.sectionRow}>
            {sections.map((m) => (
              <button
                key={m.index}
                type="button"
                className={styles.sectionChip}
                onClick={() => {
                  setScrollTo(m.index)
                  onPlayFrom(m.index)
                }}
              >
                {m.marker}
              </button>
            ))}
          </div>
        </div>
      )}

      <ScoreSheet
        score={score}
        beat={beat}
        activeNotes={activeNotes}
        playingMeasure={playingMeasure}
        onPlayFrom={onPlayFrom}
        scrollToMeasure={scrollTo}
      />

      {score.warnings.length > 0 && (
        <div className={styles.notes}>
          <button
            type="button"
            className={styles.notesToggle}
            onClick={() => setShowNotes((v) => !v)}
            aria-expanded={showNotes}
          >
            {showNotes ? '▾' : '▸'} How this was read
          </button>
          {showNotes && (
            <ul className={styles.notesList}>
              {score.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
