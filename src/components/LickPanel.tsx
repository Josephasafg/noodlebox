import { noteName, type PitchClass } from '../theory/notes'
import {
  ARTICULATION_LABELS,
  DIFFICULTY_LABELS,
  type Articulation,
  type ResolvedLick,
} from '../theory/licks'
import { TabStaff } from './TabStaff'
import styles from './LickPanel.module.css'

interface Props {
  resolved: ResolvedLick
  keyPc: PitchClass
  /** Display name of the lick's own scale, when it differs from the selected one. */
  borrowedFrom: string | null
  /** True when the lick uses a note the selected scale does not contain. */
  outOfScale: boolean
  beat: number | null
  activeNotes: readonly number[]
  playing: boolean
  loading: boolean
  onTogglePlay: () => void
  onClose: () => void
}

export function LickPanel({
  resolved,
  keyPc,
  borrowedFrom,
  outOfScale,
  beat,
  activeNotes,
  playing,
  loading,
  onTogglePlay,
  onClose,
}: Props) {
  const { lick, minFret, maxFret } = resolved

  // Techniques actually used, so the panel teaches what the notation is showing.
  const techniques = [...new Set(lick.notes.map((n) => n.art).filter(Boolean))] as Articulation[]

  return (
    <section className={styles.panel} aria-label={`Tab for ${lick.name}`}>
      <header className={styles.head}>
        <div className={styles.headText}>
          <h2 className={styles.name}>{lick.name}</h2>
          <p className={styles.style}>{lick.style}</p>
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            className={`${styles.play} ${playing || loading ? styles.playOn : ''}`}
            onClick={onTogglePlay}
            aria-pressed={playing}
            aria-busy={loading}
            aria-label={playing ? 'Stop lick playback' : 'Play lick'}
          >
            <span className={styles.playIcon} aria-hidden="true">
              {loading ? '◌' : playing ? '■' : '▶'}
            </span>
            <span>{loading ? 'loading' : playing ? 'stop' : 'play'}</span>
          </button>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close tab">
            ✕
          </button>
        </div>
      </header>

      <div className={styles.meta}>
        <span className={styles.badgeKey}>
          {noteName(keyPc)} {lick.scaleId.replace(/-/g, ' ')}
        </span>
        {borrowedFrom && !outOfScale && (
          <span
            className={styles.badgeBorrowed}
            title="Written for another scale, but every note fits the one you have selected"
          >
            borrowed from {borrowedFrom}
          </span>
        )}
        {outOfScale && borrowedFrom && (
          <span
            className={styles.badgeWarn}
            title="This lick uses notes outside the scale you have selected — it still plays, but it will not sound like the scale"
          >
            outside this scale · {borrowedFrom}
          </span>
        )}
        <span className={styles.badge}>{DIFFICULTY_LABELS[lick.difficulty]}</span>
        <span className={styles.badge}>{lick.bpm} bpm</span>
        <span className={styles.badge}>
          frets {minFret}–{maxFret}
        </span>
        {techniques.map((t) => (
          <span key={t} className={styles.badgeTech}>
            {ARTICULATION_LABELS[t]}
          </span>
        ))}
      </div>

      <TabStaff resolved={resolved} beat={beat} activeNotes={activeNotes} />

      {lick.tip && (
        <p className={styles.tip}>
          <span className={styles.tipLabel}>tip</span>
          {lick.tip}
        </p>
      )}
    </section>
  )
}
