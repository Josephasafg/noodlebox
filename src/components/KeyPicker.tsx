import { CHROMATIC_KEYS, noteName, type PitchClass } from '../theory/notes'
import styles from './KeyPicker.module.css'

interface KeyPickerProps {
  value: PitchClass
  onChange: (pc: PitchClass) => void
}

export function KeyPicker({ value, onChange }: KeyPickerProps) {
  return (
    <div className={styles.picker} role="radiogroup" aria-label="Key">
      {CHROMATIC_KEYS.map((pc) => {
        const active = pc === value
        const name = noteName(pc)
        const hasAccidental = name.length > 1
        return (
          <button
            key={pc}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={`Key of ${name}`}
            className={[
              styles.key,
              active ? styles.keyActive : '',
              hasAccidental ? styles.keyAccidental : styles.keyNatural,
            ].join(' ')}
            onClick={() => onChange(pc)}
          >
            <span className={styles.keyLabel}>{name}</span>
          </button>
        )
      })}
    </div>
  )
}
