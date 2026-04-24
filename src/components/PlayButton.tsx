import { useState } from 'react'
import type { FretNote } from '../theory/fretboard'
import { playScale } from '../audio/player'
import styles from './PlayButton.module.css'

interface PlayButtonProps {
  notes: FretNote[]
}

export function PlayButton({ notes }: PlayButtonProps) {
  const [busy, setBusy] = useState(false)

  const handleClick = async () => {
    if (busy) return
    setBusy(true)
    try {
      await playScale(notes)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      className={styles.play}
      onClick={handleClick}
      disabled={busy}
      aria-label="Play scale ascending and descending"
    >
      <span className={styles.icon} aria-hidden="true">
        {busy ? '◉' : '▶'}
      </span>
      <span className={styles.label}>{busy ? 'sounding' : 'play'}</span>
    </button>
  )
}
