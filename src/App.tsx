import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Fretboard } from './components/Fretboard'
import { SoloBrowser } from './components/SoloBrowser'
import { LickPanel } from './components/LickPanel'
import { SongPanel } from './components/SongPanel'
import { ScaleMenu } from './components/ScaleMenu'
import { ScorePanel } from './components/ScorePanel'
import { LibraryBrowser } from './components/LibraryBrowser'
import { ShapeNamer } from './components/ShapeNamer'
import { Tuner } from './components/Tuner'
import { useScaleState } from './hooks/useScaleState'
import { useGuitarPlayback } from './hooks/useGuitarPlayback'
import { useScoreLibrary } from './hooks/useScoreLibrary'
import { notesAtBeat, useBeatPlayhead } from './hooks/useBeatPlayhead'
import { keystrokeIsTaken, overlayIsOpen } from './hooks/shortcuts'
import { fretNotesInRange, sliceScore } from './tabpdf/playable'
import {
  FRET_COUNT,
  allScaleNotes,
  notesInPosition,
  positionsForScale,
  rootFretOnLowE,
  scaleSequence,
  type FretNote,
} from './theory/fretboard'
import { noteName, pcToSlug } from './theory/notes'
import { getScale, scalePitchClasses } from './theory/scales'
import { isLickPlayableIn, resolveLick } from './theory/licks'
import { getLick } from './data/licks'
import { getSong } from './data/songs'
import { playLickAudio, playScaleAudio, preloadGuitar } from './audio/guitar'
import './App.css'

function noteKey(note: { stringIdx: number; fret: number }): string {
  return `${note.stringIdx}-${note.fret}`
}

/**
 * Bars a single press plays from an imported score. Every note is scheduled up
 * front, so this bounds how much is queued at once while still covering a whole
 * verse or solo section.
 */
const SCORE_PLAY_BARS = 32

/** What the transport plays. Whichever the user touched last wins. */
type PlayTarget = 'score' | 'lick' | 'scale'

/** Collapse repeated fretboard positions so each renders once. */
function dedupeByPosition(notes: readonly FretNote[]): FretNote[] {
  const seen = new Set<string>()
  const out: FretNote[] = []
  for (const n of notes) {
    const k = noteKey(n)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(n)
  }
  return out
}

export function App() {
  const { key, scale, positionIndex, setKey, setScale, cycleKey, cycleScale, cyclePosition } =
    useScaleState()
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()

  const positions = positionsForScale(scale)
  const position = positions[positionIndex]
  const rootFret = rootFretOnLowE(key)
  const pitchClasses = scalePitchClasses(key, scale)

  const library = useScoreLibrary()
  const { score } = library
  const [playFrom, setPlayFrom] = useState(0)
  const [preferred, setPreferred] = useState<PlayTarget | null>(null)

  const lickId = searchParams.get('lick')
  const songId = searchParams.get('song')
  const lick = useMemo(() => (lickId ? getLick(lickId) : null), [lickId])
  const song = useMemo(() => (songId ? getSong(songId) : null), [songId])
  const resolved = useMemo(() => (lick ? resolveLick(lick, key) : null), [lick, key])

  const selectLick = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(searchParams)
      if (id) next.set('lick', id)
      else next.delete('lick')
      setSearchParams(next)
      // Picking a lick makes it what the transport plays, even with a tab open.
      if (id) setPreferred('lick')
    },
    [searchParams, setSearchParams],
  )

  /**
   * Picking a song moves the whole app into that solo's key and scale, so the
   * fretboard and every lick below it are already in the right place.
   */
  const selectSong = useCallback(
    (id: string) => {
      const next = getSong(id)
      if (!next) return
      navigate(`/${pcToSlug(next.key)}/${next.scaleId}/1?song=${next.id}`)
    },
    [navigate],
  )

  const clearSong = useCallback(() => {
    const next = new URLSearchParams(searchParams)
    next.delete('song')
    setSearchParams(next)
  }, [searchParams, setSearchParams])

  /** The stretch of the imported score a press would play. */
  const scoreSlice = useMemo(() => {
    if (!score || score.measures.length === 0) return null
    const from = Math.min(playFrom, score.measures.length - 1)
    return sliceScore(score, from, from + SCORE_PLAY_BARS - 1)
  }, [score, playFrom])

  /** Whichever thing the user touched last, falling back to what is on screen. */
  const target: PlayTarget = useMemo(() => {
    if (preferred === 'lick' && resolved) return 'lick'
    if (preferred === 'score' && score) return 'score'
    if (resolved) return 'lick'
    if (score) return 'score'
    return 'scale'
  }, [preferred, resolved, score])

  const playback = useGuitarPlayback()
  const lickIsSounding = playback.source === 'lick'
  const scoreIsSounding = playback.source === 'score'

  const beat = useBeatPlayhead(
    lickIsSounding && playback.playing,
    playback.visualStartPerf,
    lick?.bpm ?? 90,
    resolved?.totalBeats ?? 0,
  )

  const activeNotes = useMemo(
    () => notesAtBeat(resolved?.notes ?? [], beat),
    [resolved, beat],
  )

  // The score playhead runs in slice time; the sheet is addressed in score time.
  const scoreBeatLocal = useBeatPlayhead(
    scoreIsSounding && playback.playing,
    playback.visualStartPerf,
    score?.bpm ?? 90,
    scoreSlice?.totalBeats ?? 0,
  )
  const scoreBeat =
    scoreBeatLocal === null || !score || !scoreSlice
      ? null
      : scoreBeatLocal + scoreSlice.fromMeasure * score.beatsPerBar

  const scoreActiveNotes = useMemo(() => {
    if (!scoreSlice) return []
    return notesAtBeat(scoreSlice.notes, scoreBeatLocal).map(
      (i) => scoreSlice.notes[i].noteIndex,
    )
  }, [scoreSlice, scoreBeatLocal])

  const playingMeasure =
    scoreBeat === null || !score ? null : Math.floor(scoreBeat / score.beatsPerBar)

  /**
   * The bar the fretboard illustrates: the one sounding, or the one a press
   * would start from. A whole 32-bar window at once would light up most of the
   * neck and show nothing useful.
   */
  const scoreFretNotes = useMemo(() => {
    if (!score || target !== 'score' || !scoreSlice) return null
    const focus = playingMeasure ?? scoreSlice.fromMeasure
    const inBar = fretNotesInRange(score, focus, focus)
    if (inBar.length > 0) return inBar
    return fretNotesInRange(score, scoreSlice.fromMeasure, scoreSlice.toMeasure)
  }, [score, target, scoreSlice, playingMeasure])

  // With a lick or an imported bar open the fretboard follows its span instead
  // of the box, so the shape is always fully visible wherever it sits.
  const scoreFrets = scoreFretNotes?.map((n) => n.fret) ?? []
  const highStart = scoreFretNotes
    ? Math.max(0, Math.min(...scoreFrets) - 1)
    : resolved
      ? Math.max(0, resolved.minFret - 1)
      : rootFret + position.startOffset
  const highEnd = scoreFretNotes
    ? Math.min(FRET_COUNT, Math.max(...scoreFrets) + 1)
    : resolved
      ? Math.min(FRET_COUNT, resolved.maxFret + 1)
      : rootFret + position.endOffset

  const displayNotes = useMemo(() => {
    if (scoreFretNotes) return dedupeByPosition(scoreFretNotes)
    if (!resolved) return notesInPosition(key, scale, positionIndex)
    const inRange = allScaleNotes(key, scale).filter(
      (n) => n.fret >= highStart && n.fret <= highEnd,
    )
    // A lick borrowed from another scale can touch a note the selected scale
    // lacks; append those so the tab and the diagram never disagree.
    const known = new Set(inRange.map(noteKey))
    const extra = resolved.notes.filter((n) => !known.has(noteKey(n)))
    return dedupeByPosition([...inRange, ...extra])
  }, [scoreFretNotes, resolved, key, scale, positionIndex, highStart, highEnd])

  const overlayNotes = useMemo(() => {
    if (scoreFretNotes) return dedupeByPosition(scoreFretNotes)
    return resolved ? dedupeByPosition(resolved.notes) : undefined
  }, [scoreFretNotes, resolved])

  const activeKeys = useMemo(() => {
    if (scoreIsSounding && score) {
      const keys: string[] = []
      for (const i of scoreActiveNotes) {
        const note = score.notes[i]
        // Slicing already dropped dead notes, so a fret is always present here.
        if (note && note.fret !== null) keys.push(`${note.stringIdx}-${note.fret}`)
      }
      return keys
    }
    if (resolved && lickIsSounding) return activeNotes.map((i) => noteKey(resolved.notes[i]))
    return undefined
  }, [scoreIsSounding, score, scoreActiveNotes, resolved, lickIsSounding, activeNotes])

  /**
   * Play the imported score from a bar, slicing it here rather than reading the
   * memoised slice so a tap on a bar sounds that bar without waiting a render.
   */
  const playScoreFrom = useCallback(
    (from: number) => {
      if (!score || score.measures.length === 0) return
      const clamped = Math.min(Math.max(0, from), score.measures.length - 1)
      const slice = sliceScore(score, clamped, clamped + SCORE_PLAY_BARS - 1)
      if (slice.notes.length === 0) return
      void playback.start('score', () =>
        playLickAudio(slice.notes, score.bpm, score.tuningShift),
      )
    },
    [score, playback],
  )

  const startTarget = useCallback(
    (next: PlayTarget) => {
      if (next === 'score') {
        playScoreFrom(playFrom)
        return
      }
      if (next === 'lick') {
        if (!resolved || resolved.notes.length === 0) return
        void playback.start('lick', () => playLickAudio(resolved.notes, resolved.lick.bpm))
        return
      }
      const sequence = scaleSequence(displayNotes)
      if (sequence.length === 0) return
      void playback.start('scale', () => playScaleAudio(sequence, 0.26))
    },
    [playback, playScoreFrom, playFrom, resolved, displayNotes],
  )

  /**
   * Stop, leaving the tab standing at the bar it had reached.
   *
   * Stopping is how you take a run at a passage again, so the next press picks
   * the tab up where it left off rather than at the top of the section. Tapping
   * a bar is what moves that checkpoint somewhere else.
   */
  const stopPlayback = useCallback(() => {
    if (score && playingMeasure !== null) {
      setPlayFrom(Math.min(playingMeasure, score.measures.length - 1))
    }
    playback.stop()
  }, [playback, playingMeasure, score])

  const handleTogglePlay = useCallback(() => {
    if (playback.playing || playback.loading) {
      stopPlayback()
      return
    }
    startTarget(target)
  }, [playback.playing, playback.loading, stopPlayback, startTarget, target])

  const handlePlayLick = useCallback(() => {
    setPreferred('lick')
    if (playback.playing || playback.loading) {
      stopPlayback()
      return
    }
    startTarget('lick')
  }, [playback.playing, playback.loading, stopPlayback, startTarget])

  const handlePlayFromBar = useCallback(
    (measureIndex: number) => {
      setPreferred('score')
      setPlayFrom(measureIndex)
      playScoreFrom(measureIndex)
    },
    [playScoreFrom],
  )

  const { stop } = playback
  useEffect(() => {
    stop()
  }, [key, scale.id, positionIndex, lickId, score, stop])

  useEffect(() => {
    preloadGuitar()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (keystrokeIsTaken(e.key, e.target)) return
      if (e.key === ' ') {
        // Space is the transport, wherever you are on the page — except under an
        // overlay, where it belongs to whatever is open in front.
        if (overlayIsOpen(document) || e.metaKey || e.ctrlKey || e.altKey) return
        // Held down it would scroll the page and machine-gun the transport.
        e.preventDefault()
        if (!e.repeat) handleTogglePlay()
      } else if (e.key === 'ArrowLeft') {
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
  }, [cycleKey, cycleScale, cyclePosition, handleTogglePlay])

  const borrowedFrom =
    lick && lick.scaleId !== scale.id ? getScale(lick.scaleId)?.displayName ?? null : null
  const lickOutOfScale = lick ? !isLickPlayableIn(lick, scale) : false

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
          <SoloBrowser
            scale={scale}
            keyPc={key}
            selectedLickId={lickId}
            selectedSongId={songId}
            onSelectLick={selectLick}
            onSelectSong={selectSong}
          />
          <LibraryBrowser
            entries={library.entries}
            openId={library.entry?.id ?? null}
            status={library.status}
            error={library.error}
            progress={library.progress}
            videoStage={library.videoJob?.stage ?? null}
            videoProgress={library.videoJob?.progress ?? null}
            videoReady={library.videoReady}
            videoNamesShapes={library.videoNamesShapes}
            onCheckVideoServer={() => void library.checkVideoServer()}
            onImport={(file) => {
              setPreferred('score')
              setPlayFrom(0)
              void library.importFile(file)
            }}
            onImportUrl={(url) => {
              setPreferred('score')
              setPlayFrom(0)
              void library.importUrl(url)
            }}
            onOpen={(id) => {
              setPreferred('score')
              setPlayFrom(0)
              void library.open(id)
            }}
            onRename={(id, title) => void library.rename(id, title)}
            onRemove={(id) => void library.remove(id)}
            onDismissError={library.dismissError}
          />
          {library.videoJob?.state === 'naming' && (
            <ShapeNamer
              job={library.videoJob}
              busy={library.status === 'reading'}
              onSubmit={(labels) => void library.nameShapes(labels)}
              onCancel={library.cancelVideo}
            />
          )}
          <Tuner />
          <button
            type="button"
            className={`app__playPill ${playback.source !== null ? 'is-on' : ''}`}
            onClick={handleTogglePlay}
            aria-pressed={playback.playing}
            aria-busy={playback.loading}
            title="Space"
            aria-label={
              playback.playing
                ? 'Stop playback'
                : target === 'score'
                  ? `Play ${score?.title ?? 'imported tab'} from bar ${playFrom + 1}`
                  : target === 'lick'
                    ? `Play ${resolved?.lick.name ?? 'lick'}`
                    : 'Play scale'
            }
          >
            <span className="app__playIcon" aria-hidden="true">
              {playback.loading ? '◌' : playback.playing ? '■' : '▶'}
            </span>
            <span>{playback.loading ? 'loading' : playback.playing ? 'stop' : 'play'}</span>
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
            notes={displayNotes}
            highlightRangeStart={highStart}
            highlightRangeEnd={highEnd}
            scaleName={
              target === 'score' && score
                ? `${score.title ?? 'Imported tab'}, bar ${(playingMeasure ?? playFrom) + 1}`
                : `${noteName(key)} ${scale.displayName}`
            }
            isPlaying={playback.playing}
            playStartPerf={playback.visualStartPerf}
            overlayNotes={overlayNotes}
            activeKeys={activeKeys}
          />
        </div>
      </section>

      {score && (
        <div className="app__lick">
          <ScorePanel
            score={score}
            beat={scoreBeat}
            activeNotes={scoreActiveNotes}
            playingMeasure={playingMeasure}
            playWindow={Math.min(SCORE_PLAY_BARS, score.measures.length)}
            onPlayFrom={handlePlayFromBar}
            onNoteChange={library.editNote}
            onBpmChange={library.setBpm}
            onTuningShiftChange={library.setTuningShift}
            onBeatsPerBarChange={(beats) => void library.setBeatsPerBar(beats)}
            onClose={library.close}
          />
        </div>
      )}

      {song && (
        <div className="app__lick">
          <SongPanel
            song={song}
            selectedLickId={lickId}
            onSelectLick={selectLick}
            onClose={clearSong}
          />
        </div>
      )}

      {resolved && (
        <div className="app__lick">
          <LickPanel
            resolved={resolved}
            keyPc={key}
            borrowedFrom={borrowedFrom}
            outOfScale={lickOutOfScale}
            beat={beat}
            activeNotes={activeNotes}
            playing={lickIsSounding && playback.playing}
            loading={lickIsSounding && playback.loading}
            onTogglePlay={handlePlayLick}
            onClose={() => selectLick(null)}
          />
        </div>
      )}

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
          {target === 'score' && score
            ? `${score.title ?? 'Imported tab'} · bar ${(playingMeasure ?? playFrom) + 1} of ${score.measures.length}`
            : resolved
              ? `${resolved.lick.name} · frets ${resolved.minFret}–${resolved.maxFret}`
              : `Position ${position.label} · frets ${highStart}–${highEnd}`}
        </div>
      </footer>

    </div>
  )
}
