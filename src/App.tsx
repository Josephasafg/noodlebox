import { useCallback, useEffect, useRef, useState } from 'react'
import { Fretboard } from './components/Fretboard'
import { ScaleMenu } from './components/ScaleMenu'
import { useScaleState } from './hooks/useScaleState'
import {
  notesInPosition,
  positionsForScale,
  rootFretOnLowE,
  scaleSequence,
} from './theory/fretboard'
import { noteName } from './theory/notes'
import { scalePitchClasses } from './theory/scales'
import { playScaleAudio, preloadGuitar, type ScalePlayback } from './audio/guitar'
import './App.css'

export function App() {
  const { key, scale, positionIndex, setKey, setScale, cycleKey, cycleScale, cyclePosition } =
    useScaleState()

  const positions = positionsForScale(scale)
  const position = positions[positionIndex]
  const notes = notesInPosition(key, scale, positionIndex)
  const rootFret = rootFretOnLowE(key)
  const pitchClasses = scalePitchClasses(key, scale)
  const highStart = rootFret + position.startOffset
  const highEnd = rootFret + position.endOffset

  const [playing, setPlaying] = useState(false)
  const [loadingAudio, setLoadingAudio] = useState(false)
  const [visualStartPerf, setVisualStartPerf] = useState<number | null>(null)
  const playbackRef = useRef<ScalePlayback | null>(null)
  const stopTimerRef = useRef<number | null>(null)
  const playTokenRef = useRef(0)

  const stopPlayback = useCallback(() => {
    playTokenRef.current++
    if (stopTimerRef.current !== null) {
      window.clearTimeout(stopTimerRef.current)
      stopTimerRef.current = null
    }
    if (playbackRef.current) {
      playbackRef.current.stop()
      playbackRef.current = null
    }
    setLoadingAudio(false)
    setPlaying(false)
    setVisualStartPerf(null)
  }, [])

  useEffect(() => {
    stopPlayback()
  }, [key, scale.id, positionIndex, stopPlayback])

  useEffect(() => () => stopPlayback(), [stopPlayback])

  const handleTogglePlay = useCallback(async () => {
    if (playing || loadingAudio) {
      stopPlayback()
      return
    }
    const token = ++playTokenRef.current
    const sequence = scaleSequence(notes)
    if (sequence.length === 0) return
    setLoadingAudio(true)
    try {
      const playback = await playScaleAudio(sequence, 0.26)
      if (token !== playTokenRef.current) {
        playback.stop()
        return
      }
      playbackRef.current = playback
      setVisualStartPerf(playback.visualStartPerf)
      setLoadingAudio(false)
      setPlaying(true)
      stopTimerRef.current = window.setTimeout(() => {
        stopTimerRef.current = null
        playbackRef.current = null
        setPlaying(false)
        setVisualStartPerf(null)
      }, playback.durationMs + 300)
    } catch (err) {
      console.error('audio failed', err)
      setLoadingAudio(false)
      setPlaying(false)
    }
  }, [playing, loadingAudio, notes, stopPlayback])

  useEffect(() => {
    preloadGuitar()
  }, [])

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
    <div className="app">
      <div className="app__field" aria-hidden="true">
        <div className="app__blob app__blob--1" />
        <div className="app__blob app__blob--2" />
        <div className="app__blob app__blob--3" />
      </div>

      <nav className="app__nav">
        <div className="app__brandRow">
          <div className="app__logoDot" />
          <span className="app__brand">noodlebox</span>
        </div>
        <div className="app__navRight">
          <ScaleMenu
            keyPc={key}
            scale={scale}
            onKeyChange={setKey}
            onScaleChange={setScale}
          />
          <button
            type="button"
            className={`app__playPill ${playing || loadingAudio ? 'is-on' : ''}`}
            onClick={handleTogglePlay}
            aria-pressed={playing}
            aria-busy={loadingAudio}
            aria-label={playing ? 'Stop scale playback' : 'Play scale'}
          >
            <span className="app__playIcon" aria-hidden="true">
              {loadingAudio ? '◌' : playing ? '■' : '▶'}
            </span>
            <span>{loadingAudio ? 'loading' : playing ? 'stop' : 'play'}</span>
          </button>
          <span className="app__avatar" />
        </div>
      </nav>

      <header className="app__header">
        <div className="app__eyebrow">Scale study</div>
        <h1 className="app__title">
          <span className="app__key">{noteName(key)}</span>
          <span className="app__scale"> {scale.displayName.toLowerCase()}</span>
        </h1>
        <div className="app__chips" aria-label="Scale pitches">
          {pitchClasses.map((pc, i) => (
            <span
              key={`${pc}-${i}`}
              className={`app__chip ${pc === key ? 'is-root' : ''}`}
            >
              {noteName(pc)}
            </span>
          ))}
        </div>
      </header>

      <section className="app__glass">
        <div className="app__glassInner">
          <Fretboard
            notes={notes}
            highlightRangeStart={highStart}
            highlightRangeEnd={highEnd}
            scaleName={`${noteName(key)} ${scale.displayName}`}
            isPlaying={playing}
            playStartPerf={visualStartPerf}
          />
        </div>
      </section>

      <footer className="app__foot">
        <div
          className="app__positions"
          role="radiogroup"
          aria-label={`Position within ${scale.displayName}`}
        >
          {positions.map((p, i) => (
            <button
              key={p.label}
              type="button"
              role="radio"
              aria-checked={i === positionIndex}
              className={`app__posChip ${i === positionIndex ? 'is-on' : ''}`}
              onClick={() => cyclePosition(i - positionIndex)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="app__hint">
          Position {position.label} · frets {highStart}–{highEnd}
        </div>
      </footer>

    </div>
  )
}
