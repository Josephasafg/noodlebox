import { useMemo } from 'react'
import { ChordDiagram } from './ChordDiagram'
import { sheetStats } from '../chords/types'
import type { ChordSheet, SheetChord, SheetLine } from '../chords/types'
import styles from './ChordSheetPanel.module.css'

interface Props {
  sheet: ChordSheet
  onClose: () => void
}

/**
 * A lyric with its chords anchored over the words.
 *
 * Each chord's column cuts the line into segments; the chord sits absolutely
 * above the segment it starts. Anchoring to characters rather than measuring
 * columns keeps a chord over its word in any font, and wraps with it on
 * narrow screens.
 */
function LyricLine({ text, chords }: { text: string; chords: SheetChord[] }) {
  if (chords.length === 0) {
    return <p className={styles.line}>{text}</p>
  }
  const cuts = chords.map((chord) => Math.min(chord.column, text.length))
  return (
    <p className={`${styles.line} ${styles.lineChorded}`}>
      {cuts[0] > 0 && text.slice(0, cuts[0])}
      {chords.map((chord, i) => {
        const start = cuts[i]
        const end = i + 1 < cuts.length ? Math.max(cuts[i + 1], start) : text.length
        const words = text.slice(start, end)
        return (
          <span key={`${chord.name}-${i}`} className={styles.anchor}>
            <span className={styles.chord}>{chord.name}</span>
            {/* A chord past the end of the words still needs a footprint. */}
            {words.length > 0 ? words : ' '}
          </span>
        )
      })}
    </p>
  )
}

function Line({ line }: { line: SheetLine }) {
  switch (line.kind) {
    case 'lyrics':
      return <LyricLine text={line.text} chords={line.chords} />
    case 'chords':
      return (
        <p className={styles.chordRun}>
          {line.chords.map((chord, i) => (
            <span key={`${chord.name}-${i}`} className={styles.runChord}>
              {chord.name}
            </span>
          ))}
        </p>
      )
    case 'label':
      return <h3 className={styles.label}>{line.text}</h3>
    case 'note':
      return <p className={styles.note}>{line.text}</p>
  }
}

/**
 * The words of a song with its chords over them.
 *
 * Any tablature printed on the same page is not here: it is engraved on the
 * app's own staff by `ScorePanel`, where it can be played and corrected.
 */
export function ChordSheetPanel({ sheet, onClose }: Props) {
  const stats = useMemo(() => sheetStats(sheet), [sheet])

  /** Every chord used, in order of first appearance, for the diagram strip. */
  const chordNames = useMemo(() => {
    const seen = new Set<string>()
    const names: string[] = []
    for (const block of sheet.blocks) {
      for (const line of block.lines) {
        if (line.kind !== 'lyrics' && line.kind !== 'chords') continue
        for (const chord of line.chords) {
          if (seen.has(chord.name)) continue
          seen.add(chord.name)
          names.push(chord.name)
        }
      }
    }
    return names
  }, [sheet])

  return (
    <section className={styles.panel} aria-label={sheet.title ?? 'Chord sheet'}>
      <header className={styles.head}>
        <div className={styles.headText}>
          <h2 className={styles.title}>
            {sheet.title ?? 'Chord sheet'}
            {sheet.artist && (
              <>
                {' '}
                <span className={styles.dash}>—</span>{' '}
                <span className={styles.artist}>{sheet.artist}</span>
              </>
            )}
          </h2>
          <p className={styles.sub}>
            {stats.lines} lines · {stats.chords} chords · from{' '}
            <a className={styles.source} href={sheet.sourceUrl} target="_blank" rel="noreferrer">
              tab4u
            </a>
          </p>
        </div>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Close sheet">
          ✕
        </button>
      </header>

      {chordNames.length > 0 && (
        <div className={styles.strip} aria-label="Chords in this song">
          {chordNames.map((name) => {
            const shape = sheet.shapes[name]?.[0]
            return (
              <figure key={name} className={styles.card}>
                {shape && <ChordDiagram name={name} shape={shape} />}
                <figcaption className={styles.cardName}>{name}</figcaption>
              </figure>
            )
          })}
        </div>
      )}

      <div className={styles.sheet} dir={sheet.rtl ? 'rtl' : 'ltr'}>
        {sheet.blocks.map((block, b) => (
          <div key={b} className={styles.stanza}>
            {block.lines.map((line, l) => (
              <Line key={l} line={line} />
            ))}
          </div>
        ))}
      </div>
    </section>
  )
}
