import { SCALE_LIST, type ScaleDef } from '../theory/scales'
import styles from './ScalePicker.module.css'

interface ScalePickerProps {
  value: string
  onChange: (scaleId: string) => void
}

const GROUP_ORDER: ScaleDef['group'][] = ['major', 'minor', 'pentatonic', 'blues', 'modes']
const GROUP_LABELS: Record<ScaleDef['group'], string> = {
  major: 'Major',
  minor: 'Minor',
  pentatonic: 'Pentatonic',
  blues: 'Blues',
  modes: 'Modes',
}

export function ScalePicker({ value, onChange }: ScalePickerProps) {
  return (
    <div className={styles.picker} aria-label="Scale" role="radiogroup">
      {GROUP_ORDER.map((group) => {
        const items = SCALE_LIST.filter((s) => s.group === group)
        if (items.length === 0) return null
        return (
          <div key={group} className={styles.group}>
            <span className={styles.groupLabel}>{GROUP_LABELS[group]}</span>
            <ul className={styles.items}>
              {items.map((scale) => {
                const active = scale.id === value
                return (
                  <li key={scale.id}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className={[styles.item, active ? styles.itemActive : ''].join(' ')}
                      onClick={() => onChange(scale.id)}
                    >
                      {scale.shortName}
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </div>
  )
}
