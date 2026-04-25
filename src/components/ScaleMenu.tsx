import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CHROMATIC_KEYS, noteName, type PitchClass } from '../theory/notes'
import { SCALE_LIST, scalePitchClasses, type ScaleDef } from '../theory/scales'
import { Portal } from './Portal'
import styles from './ScaleMenu.module.css'

const SCALE_GROUPS: ScaleDef['group'][] = [
  'major',
  'minor',
  'pentatonic',
  'blues',
  'modes',
]
const SCALE_GROUP_LABELS: Record<ScaleDef['group'], string> = {
  major: 'Major',
  minor: 'Minor',
  pentatonic: 'Pentatonic',
  blues: 'Blues',
  modes: 'Modes',
}

const WHEEL_RADIUS_PCT = (86 / 220) * 100

interface Props {
  keyPc: PitchClass
  scale: ScaleDef
  onKeyChange: (pc: PitchClass) => void
  onScaleChange: (id: string) => void
}

export function ScaleMenu({ keyPc, scale, onKeyChange, onScaleChange }: Props) {
  const [open, setOpen] = useState(false)
  const [hoverScaleId, setHoverScaleId] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const firstKeyRef = useRef<HTMLButtonElement | null>(null)

  const toggle = useCallback(() => setOpen((v) => !v), [])
  const close = useCallback(() => setOpen(false), [])

  // focus management
  useEffect(() => {
    if (open) {
      const t = window.setTimeout(() => firstKeyRef.current?.focus(), 80)
      return () => window.clearTimeout(t)
    }
    triggerRef.current?.focus()
  }, [open])

  // esc / arrow / enter inside drawer
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      if (e.key === 'Escape') {
        e.preventDefault()
        close()
        return
      }
      // arrows rotate around the chromatic wheel
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        const dir = e.key === 'ArrowLeft' ? -1 : 1
        const idx = CHROMATIC_KEYS.indexOf(keyPc)
        const next = CHROMATIC_KEYS[(idx + dir + CHROMATIC_KEYS.length) % CHROMATIC_KEYS.length]
        onKeyChange(next)
        return
      }
      // up/down cycle scales
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault()
        const dir = e.key === 'ArrowUp' ? -1 : 1
        const idx = SCALE_LIST.findIndex((s) => s.id === scale.id)
        const next = SCALE_LIST[(idx + dir + SCALE_LIST.length) % SCALE_LIST.length]
        onScaleChange(next.id)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, keyPc, scale.id, onKeyChange, onScaleChange, close])

  // global ⌘K / Ctrl+K to open
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const hoverPitches = useMemo<PitchClass[] | null>(() => {
    if (!hoverScaleId) return null
    const s = SCALE_LIST.find((x) => x.id === hoverScaleId)
    if (!s) return null
    return scalePitchClasses(keyPc, s)
  }, [hoverScaleId, keyPc])

  const handlePickScale = (id: string) => {
    onScaleChange(id)
    close()
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className={styles.triggerDot} aria-hidden="true" />
        <span className={styles.triggerKey}>{noteName(keyPc)}</span>
        <span className={styles.triggerScale}>{scale.displayName.toLowerCase()}</span>
        <span className={styles.triggerKbd}>⌘K</span>
      </button>

      {open && (
        <Portal>
          <div className={styles.scrim} onClick={close} aria-hidden="true" />
          <div
            className={styles.drawer}
            role="dialog"
            aria-modal="true"
            aria-label="Choose key and scale"
          >
            <button
              type="button"
              className={styles.close}
              onClick={close}
              aria-label="Close"
            >
              ✕
            </button>

            {/* LEFT — chromatic wheel */}
            <div className={styles.left}>
              <span className={styles.label}>Key</span>
              <div className={styles.wheel} role="radiogroup" aria-label="Key">
                {CHROMATIC_KEYS.map((pc: PitchClass, i) => {
                  const ang = (i / 12) * Math.PI * 2 - Math.PI / 2
                  const xPct = 50 + WHEEL_RADIUS_PCT * Math.cos(ang)
                  const yPct = 50 + WHEEL_RADIUS_PCT * Math.sin(ang)
                  const isOn = pc === keyPc
                  const isPitch =
                    !isOn && hoverPitches?.includes(pc) === true
                  return (
                    <button
                      ref={i === 0 ? firstKeyRef : undefined}
                      key={pc}
                      type="button"
                      role="radio"
                      aria-checked={isOn}
                      aria-label={`Key of ${noteName(pc)}`}
                      className={`${styles.key} ${isOn ? styles.keyOn : ''} ${
                        isPitch ? styles.keyPitch : ''
                      }`}
                      style={{ left: `${xPct}%`, top: `${yPct}%` }}
                      onClick={() => onKeyChange(pc)}
                    >
                      {noteName(pc)}
                    </button>
                  )
                })}
                <div className={styles.center} aria-hidden="true">
                  {noteName(keyPc)}
                </div>
              </div>
              <div className={styles.hint}>
                {noteName(keyPc)} · {scale.displayName}
              </div>
            </div>

            {/* RIGHT — scale list */}
            <div className={styles.right}>
              <div className={styles.rightHead}>
                Scale{' '}
                <span className={styles.rightHeadCurrent}>
                  · {scale.displayName}
                </span>
              </div>
              {SCALE_GROUPS.map((group) => {
                const items = SCALE_LIST.filter((s) => s.group === group)
                if (items.length === 0) return null
                return (
                  <div key={group} className={styles.group}>
                    <span className={styles.groupLabel}>
                      {SCALE_GROUP_LABELS[group]}
                    </span>
                    <div className={styles.row}>
                      {items.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          role="radio"
                          aria-checked={s.id === scale.id}
                          className={`${styles.scale} ${
                            s.id === scale.id ? styles.scaleOn : ''
                          }`}
                          onClick={() => handlePickScale(s.id)}
                          onMouseEnter={() => setHoverScaleId(s.id)}
                          onMouseLeave={() => setHoverScaleId(null)}
                          onFocus={() => setHoverScaleId(s.id)}
                          onBlur={() => setHoverScaleId(null)}
                        >
                          {s.shortName}
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>

            <div className={styles.foot}>
              <div>
                <kbd>←</kbd>
                <kbd>→</kbd> key &nbsp;·&nbsp; <kbd>↑</kbd>
                <kbd>↓</kbd> scale &nbsp;·&nbsp; <kbd>↵</kbd> close
              </div>
              <div>
                <kbd>esc</kbd> to dismiss
              </div>
            </div>
          </div>
        </Portal>
      )}
    </>
  )
}
