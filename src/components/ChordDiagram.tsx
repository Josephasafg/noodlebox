import type { ChordShape } from '../chords/types'
import styles from './ChordDiagram.module.css'

/** Frets in the grid; a shape reaching further slides up to a base fret. */
const FRETS_SHOWN = 4
const STRING_GAP = 9
const FRET_GAP = 11
/** Room above the grid for the open and muted string marks. */
const TOP = 13
/** Room to the right of the grid for the base-fret number. */
const SIDE = 11

const WIDTH = STRING_GAP * 5 + SIDE + 3
const HEIGHT = TOP + FRET_GAP * FRETS_SHOWN + 3

interface Props {
  name: string
  shape: ChordShape
}

/**
 * A small chord box: strings left to right from the low E, dots where the
 * shape frets them, marks above for open and unplayed strings.
 */
export function ChordDiagram({ name, shape }: Props) {
  const fretted = shape.frets.filter((fret): fret is number => fret !== null && fret > 0)
  const maxFret = fretted.length > 0 ? Math.max(...fretted) : 1
  const base = maxFret <= FRETS_SHOWN ? 1 : Math.min(...fretted)
  const stringX = (idx: number) => 1.5 + idx * STRING_GAP

  return (
    <svg
      className={styles.diagram}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      width={WIDTH}
      height={HEIGHT}
      role="img"
      aria-label={`${name} chord shape`}
    >
      {Array.from({ length: 6 }, (_, idx) => (
        <line
          key={`s${idx}`}
          className={styles.grid}
          x1={stringX(idx)}
          y1={TOP}
          x2={stringX(idx)}
          y2={TOP + FRET_GAP * FRETS_SHOWN}
        />
      ))}
      {Array.from({ length: FRETS_SHOWN + 1 }, (_, idx) => (
        <line
          key={`f${idx}`}
          className={idx === 0 && base === 1 ? styles.nut : styles.grid}
          x1={stringX(0)}
          y1={TOP + idx * FRET_GAP}
          x2={stringX(5)}
          y2={TOP + idx * FRET_GAP}
        />
      ))}
      {base > 1 && (
        <text className={styles.baseFret} x={stringX(5) + 3} y={TOP + FRET_GAP * 0.5 + 2.5}>
          {base}
        </text>
      )}
      {shape.frets.map((fret, idx) =>
        fret === null ? (
          <text key={idx} className={styles.mark} x={stringX(idx)} y={TOP - 4}>
            ×
          </text>
        ) : fret === 0 ? (
          <circle key={idx} className={styles.open} cx={stringX(idx)} cy={TOP - 6.5} r={2.4} />
        ) : (
          <circle
            key={idx}
            className={styles.dot}
            cx={stringX(idx)}
            cy={TOP + (fret - base + 0.5) * FRET_GAP}
            r={3.4}
          />
        ),
      )}
    </svg>
  )
}
