import { useEffect } from 'react'
import { Fretboard } from './components/Fretboard'
import { KeyPicker } from './components/KeyPicker'
import { ScalePicker } from './components/ScalePicker'
import { PositionControl } from './components/PositionControl'
import { PlayButton } from './components/PlayButton'
import { useScaleState } from './hooks/useScaleState'
import { notesInPosition, positionsForScale, rootFretOnLowE } from './theory/fretboard'
import { noteName } from './theory/notes'
import { scalePitchClasses } from './theory/scales'
import './App.css'

export function App() {
  const {
    key,
    scale,
    positionIndex,
    setKey,
    setScale,
    cycleKey,
    cycleScale,
    cyclePosition,
  } = useScaleState()

  const positions = positionsForScale(scale)
  const position = positions[positionIndex]
  const notes = notesInPosition(key, scale, positionIndex)
  const rootFret = rootFretOnLowE(key)
  const pitchClasses = scalePitchClasses(key, scale)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        cycleKey(-1)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        cycleKey(1)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        cycleScale(-1)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        cycleScale(1)
      } else if (e.key === '[') {
        e.preventDefault()
        cyclePosition(-1)
      } else if (e.key === ']') {
        e.preventDefault()
        cyclePosition(1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cycleKey, cycleScale, cyclePosition])

  return (
    <div className="page">
      <header className="page__header">
        <span className="mono page__brand">Fretted</span>
        <span className="eyebrow">Guitar Scales · Standard Tuning</span>
      </header>

      <main className="page__main">
        <section className="scene">
          <div className="scene__heading">
            <h1 className="scene__title">
              <span className="scene__key">{noteName(key)}</span>
              <span className="scene__scale">{scale.displayName.toLowerCase()}</span>
            </h1>
            <p className="scene__pitches mono">
              {pitchClasses.map((pc) => noteName(pc)).join(' · ')}
            </p>
          </div>
          <div className="scene__right">
            <PositionControl
              label={position.label}
              index={positionIndex}
              total={positions.length}
              onPrev={() => cyclePosition(-1)}
              onNext={() => cyclePosition(1)}
            />
            <PlayButton notes={notes} />
          </div>
        </section>

        <section className="board" key={`${scale.id}-${positionIndex}-${key}`}>
          <Fretboard
            notes={notes}
            highlightRangeStart={rootFret + position.startOffset}
            highlightRangeEnd={rootFret + position.endOffset}
            scaleName={`${key} ${scale.displayName}`}
          />
        </section>

        <section className="controls">
          <KeyPicker value={key} onChange={setKey} />
          <ScalePicker value={scale.id} onChange={setScale} />
        </section>

        <footer className="page__footer">
          <div className="footer__row">
            <span className="eyebrow">Shortcuts</span>
            <span className="mono footer__hint">
              ← → keys · ↑ ↓ scales · [ ] positions
            </span>
          </div>
        </footer>
      </main>
    </div>
  )
}
