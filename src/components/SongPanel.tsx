import { ALL_LICKS } from '../data/licks'
import { licksForSong, songsterrUrl, ultimateGuitarUrl, type Song } from '../data/songs'
import { noteName } from '../theory/notes'
import { getScale } from '../theory/scales'
import { DIFFICULTY_LABELS } from '../theory/licks'
import styles from './SongPanel.module.css'

interface Props {
  song: Song
  selectedLickId: string | null
  onSelectLick: (id: string) => void
  onClose: () => void
}

export function SongPanel({ song, selectedLickId, onSelectLick, onClose }: Props) {
  const scale = getScale(song.scaleId)
  const practice = licksForSong(song, ALL_LICKS, 6)

  return (
    <section className={styles.panel} aria-label={`${song.title} by ${song.artist}`}>
      <header className={styles.head}>
        <div className={styles.headText}>
          <h2 className={styles.title}>
            {song.title} <span className={styles.dash}>—</span>{' '}
            <span className={styles.artist}>{song.artist}</span>
          </h2>
          <p className={styles.note}>{song.note}</p>
        </div>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Close song">
          ✕
        </button>
      </header>

      <div className={styles.meta}>
        <span className={styles.badgeKey}>
          {noteName(song.key)} {scale?.displayName.toLowerCase()}
        </span>
        <span className={styles.badge}>{DIFFICULTY_LABELS[song.difficulty]}</span>
        {song.year && <span className={styles.badge}>{song.year}</span>}
      </div>

      <div className={styles.tabRow}>
        <span className={styles.tabLabel}>Full tab</span>
        <a
          className={styles.tabLink}
          href={songsterrUrl(song)}
          target="_blank"
          rel="noopener noreferrer"
        >
          Songsterr ↗
        </a>
        <a
          className={styles.tabLink}
          href={ultimateGuitarUrl(song)}
          target="_blank"
          rel="noopener noreferrer"
        >
          Ultimate Guitar ↗
        </a>
        <span className={styles.tabWhy}>
          the transcription stays with the sites licensed to publish it
        </span>
      </div>

      {practice.length > 0 && (
        <div className={styles.practice}>
          <span className={styles.practiceLabel}>
            Licks in {noteName(song.key)} {scale?.shortName} — tab and playback below
          </span>
          <div className={styles.practiceRow}>
            {practice.map((lick) => (
              <button
                key={lick.id}
                type="button"
                className={`${styles.lickChip} ${
                  lick.id === selectedLickId ? styles.lickChipOn : ''
                }`}
                onClick={() => onSelectLick(lick.id)}
                aria-pressed={lick.id === selectedLickId}
              >
                {lick.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
