import styles from './PositionControl.module.css'

interface PositionControlProps {
  label: string
  index: number
  total: number
  onPrev: () => void
  onNext: () => void
}

export function PositionControl({ label, index, total, onPrev, onNext }: PositionControlProps) {
  return (
    <div className={styles.control}>
      <span className={styles.eyebrow}>Position</span>
      <div className={styles.row}>
        <button
          type="button"
          className={styles.arrow}
          onClick={onPrev}
          aria-label="Previous position"
        >
          ◀
        </button>
        <div className={styles.readout}>
          <span className={styles.label}>{label}</span>
          <span className={styles.count}>
            {index + 1} / {total}
          </span>
        </div>
        <button
          type="button"
          className={styles.arrow}
          onClick={onNext}
          aria-label="Next position"
        >
          ▶
        </button>
      </div>
    </div>
  )
}
