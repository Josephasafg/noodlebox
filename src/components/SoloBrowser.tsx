import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ALL_LICKS } from '../data/licks'
import { SONGS, searchSongs } from '../data/songs'
import { noteName, type PitchClass } from '../theory/notes'
import type { ScaleDef } from '../theory/scales'
import { DIFFICULTY_LABELS, searchLicks, type Difficulty } from '../theory/licks'
import { Portal } from './Portal'
import styles from './SoloBrowser.module.css'

const DIFFICULTIES: Difficulty[] = [1, 2, 3]

export type BrowseMode = 'songs' | 'licks'

interface Props {
  scale: ScaleDef
  keyPc: PitchClass
  selectedLickId: string | null
  selectedSongId: string | null
  onSelectLick: (id: string) => void
  onSelectSong: (id: string) => void
}

export function SoloBrowser({
  scale,
  keyPc,
  selectedLickId,
  selectedSongId,
  onSelectLick,
  onSelectSong,
}: Props) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<BrowseMode>('songs')
  const [text, setText] = useState('')
  const [difficulty, setDifficulty] = useState<Difficulty | null>(null)
  const [includeCompatible, setIncludeCompatible] = useState(true)
  const [cursorRaw, setCursor] = useState(0)

  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  const close = useCallback(() => setOpen(false), [])

  const songs = useMemo(
    () => searchSongs(SONGS, { scale, text, difficulty, includeCompatible }),
    [scale, text, difficulty, includeCompatible],
  )
  const licks = useMemo(
    () => searchLicks(ALL_LICKS, { scale, text, difficulty, includeCompatible }),
    [scale, text, difficulty, includeCompatible],
  )

  const count = mode === 'songs' ? songs.length : licks.length
  const exactCount =
    mode === 'songs'
      ? songs.filter((s) => s.match === 'exact').length
      : licks.filter((l) => l.match === 'exact').length

  // Clamped on read, so switching mode or narrowing filters can never leave the
  // cursor past the end of the list.
  const cursor = count === 0 ? 0 : Math.min(cursorRaw, count - 1)

  useEffect(() => {
    if (open) {
      const t = window.setTimeout(() => inputRef.current?.focus(), 60)
      return () => window.clearTimeout(t)
    }
    triggerRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const row = listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }, [cursor, open])

  const pick = useCallback(
    (index: number) => {
      if (mode === 'songs') {
        const hit = songs[index]
        if (hit) onSelectSong(hit.song.id)
      } else {
        const hit = licks[index]
        if (hit) onSelectLick(hit.lick.id)
      }
      close()
    },
    [mode, songs, licks, onSelectSong, onSelectLick, close],
  )

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCursor(Math.min(count - 1, cursor + 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCursor(Math.max(0, cursor - 1))
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        setMode((m) => (m === 'songs' ? 'licks' : 'songs'))
        setCursor(0)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        pick(cursor)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, count, cursor, pick, close])

  // Global shortcut, ignored while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key.toLowerCase() === 'l') {
        e.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const switchMode = (next: BrowseMode) => {
    setMode(next)
    setCursor(0)
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Search solos and licks"
      >
        <span className={styles.triggerIcon} aria-hidden="true">
          ⌗
        </span>
        <span className={styles.triggerLabel}>solos</span>
        <span className={styles.triggerKbd}>L</span>
      </button>

      {open && (
        <Portal>
          <div className={styles.scrim} onClick={close} aria-hidden="true" />
          <div
            className={styles.drawer}
            role="dialog"
            aria-modal="true"
            aria-label="Search solos and licks"
          >
            <div className={styles.head}>
              <div className={styles.headText}>
                <span className={styles.eyebrow}>Solos &amp; licks</span>
                <span className={styles.headScale}>
                  in {noteName(keyPc)} {scale.displayName.toLowerCase()}
                </span>
              </div>
              <button type="button" className={styles.close} onClick={close} aria-label="Close">
                ✕
              </button>
            </div>

            <div className={styles.modes} role="tablist" aria-label="What to browse">
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'songs'}
                className={`${styles.mode} ${mode === 'songs' ? styles.modeOn : ''}`}
                onClick={() => switchMode('songs')}
              >
                Songs
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'licks'}
                className={`${styles.mode} ${mode === 'licks' ? styles.modeOn : ''}`}
                onClick={() => switchMode('licks')}
              >
                Licks
              </button>
            </div>

            <input
              ref={inputRef}
              type="search"
              className={styles.search}
              placeholder={
                mode === 'songs'
                  ? 'Search by song or band — floyd, zeppelin, blues…'
                  : 'Search by name, style, or technique — bend, triplets…'
              }
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label={mode === 'songs' ? 'Search songs' : 'Search licks'}
            />

            <div className={styles.filters}>
              <div className={styles.filterGroup} role="radiogroup" aria-label="Difficulty">
                <button
                  type="button"
                  role="radio"
                  aria-checked={difficulty === null}
                  className={`${styles.chip} ${difficulty === null ? styles.chipOn : ''}`}
                  onClick={() => setDifficulty(null)}
                >
                  any level
                </button>
                {DIFFICULTIES.map((d) => (
                  <button
                    key={d}
                    type="button"
                    role="radio"
                    aria-checked={difficulty === d}
                    className={`${styles.chip} ${difficulty === d ? styles.chipOn : ''}`}
                    onClick={() => setDifficulty(d)}
                  >
                    {DIFFICULTY_LABELS[d]}
                  </button>
                ))}
              </div>

              <button
                type="button"
                role="switch"
                aria-checked={includeCompatible}
                className={`${styles.chip} ${includeCompatible ? styles.chipOn : ''}`}
                onClick={() => setIncludeCompatible((v) => !v)}
                title="Include solos and licks from other scales whose notes all fit inside this one"
              >
                related scales
              </button>
            </div>

            <div className={styles.count} aria-live="polite">
              {count === 0
                ? 'Nothing matches — try clearing the filters.'
                : `${count} ${mode === 'songs' ? 'solos' : 'licks'} for this scale · ${exactCount} exactly in it`}
            </div>

            <div className={styles.list} ref={listRef} role="listbox" aria-label="Results">
              {mode === 'songs' &&
                songs.map((r, i) => (
                  <button
                    key={r.song.id}
                    type="button"
                    role="option"
                    data-idx={i}
                    aria-selected={r.song.id === selectedSongId}
                    className={`${styles.row} ${i === cursor ? styles.rowCursor : ''} ${
                      r.song.id === selectedSongId ? styles.rowOn : ''
                    }`}
                    onClick={() => pick(i)}
                    onMouseEnter={() => setCursor(i)}
                  >
                    <span className={styles.rowMain}>
                      <span className={styles.rowName}>
                        {r.song.title} <span className={styles.rowDash}>—</span>{' '}
                        <span className={styles.rowArtist}>{r.song.artist}</span>
                      </span>
                      <span className={styles.rowStyle}>{r.song.note}</span>
                    </span>
                    <span className={styles.rowMeta}>
                      <span className={styles.badgeScale}>
                        {noteName(r.song.key)} {r.songScale?.shortName}
                      </span>
                      <span className={styles.badge}>
                        {DIFFICULTY_LABELS[r.song.difficulty]}
                      </span>
                    </span>
                  </button>
                ))}

              {mode === 'licks' &&
                licks.map((r, i) => (
                  <button
                    key={r.lick.id}
                    type="button"
                    role="option"
                    data-idx={i}
                    aria-selected={r.lick.id === selectedLickId}
                    className={`${styles.row} ${i === cursor ? styles.rowCursor : ''} ${
                      r.lick.id === selectedLickId ? styles.rowOn : ''
                    }`}
                    onClick={() => pick(i)}
                    onMouseEnter={() => setCursor(i)}
                  >
                    <span className={styles.rowMain}>
                      <span className={styles.rowName}>{r.lick.name}</span>
                      <span className={styles.rowStyle}>{r.lick.style}</span>
                    </span>
                    <span className={styles.rowMeta}>
                      {r.match === 'compatible' && r.sourceScale && (
                        <span className={styles.badgeBorrowed}>{r.sourceScale.shortName}</span>
                      )}
                      <span className={styles.badge}>
                        {DIFFICULTY_LABELS[r.lick.difficulty]}
                      </span>
                      <span className={styles.badgeQuiet}>{r.lick.bpm} bpm</span>
                    </span>
                  </button>
                ))}
            </div>

            <div className={styles.foot}>
              <span>
                <kbd>↑</kbd>
                <kbd>↓</kbd> browse &nbsp;·&nbsp; <kbd>tab</kbd> songs/licks &nbsp;·&nbsp;{' '}
                <kbd>↵</kbd> open &nbsp;·&nbsp; <kbd>esc</kbd> dismiss
              </span>
              <span className={styles.footNote}>
                {mode === 'songs'
                  ? 'opens the real tab on Songsterr or Ultimate Guitar'
                  : 'every lick transposes to the key you pick'}
              </span>
            </div>
          </div>
        </Portal>
      )}
    </>
  )
}
