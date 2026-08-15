import { useCallback, useEffect, useRef, useState } from 'react'
import type { ScalePlayback } from '../audio/guitar'

export type PlaybackSource = 'scale' | 'lick' | 'score'

export interface GuitarPlayback {
  /** Which control is currently sounding, or null when idle. */
  source: PlaybackSource | null
  playing: boolean
  loading: boolean
  /** performance.now() timestamp the audio starts at, for syncing visuals. */
  visualStartPerf: number | null
  /** Start playback, cancelling anything already sounding. */
  start: (source: PlaybackSource, begin: () => Promise<ScalePlayback>) => Promise<void>
  stop: () => void
}

/**
 * Owns the single audio voice the app has. Both the scale player and the lick
 * player go through here so starting one always cancels the other, and a stale
 * async start can never resurrect playback the user already stopped.
 */
export function useGuitarPlayback(): GuitarPlayback {
  const [source, setSource] = useState<PlaybackSource | null>(null)
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(false)
  const [visualStartPerf, setVisualStartPerf] = useState<number | null>(null)

  const playbackRef = useRef<ScalePlayback | null>(null)
  const stopTimerRef = useRef<number | null>(null)
  const tokenRef = useRef(0)

  const stop = useCallback(() => {
    tokenRef.current++
    if (stopTimerRef.current !== null) {
      window.clearTimeout(stopTimerRef.current)
      stopTimerRef.current = null
    }
    if (playbackRef.current) {
      playbackRef.current.stop()
      playbackRef.current = null
    }
    setLoading(false)
    setPlaying(false)
    setSource(null)
    setVisualStartPerf(null)
  }, [])

  const start = useCallback(
    async (nextSource: PlaybackSource, begin: () => Promise<ScalePlayback>) => {
      stop()
      const token = ++tokenRef.current
      setSource(nextSource)
      setLoading(true)
      try {
        const playback = await begin()
        if (token !== tokenRef.current) {
          playback.stop()
          return
        }
        playbackRef.current = playback
        setVisualStartPerf(playback.visualStartPerf)
        setLoading(false)
        setPlaying(true)
        stopTimerRef.current = window.setTimeout(() => {
          stopTimerRef.current = null
          playbackRef.current = null
          setPlaying(false)
          setSource(null)
          setVisualStartPerf(null)
        }, playback.durationMs + 300)
      } catch (err) {
        console.error('audio failed', err)
        if (token === tokenRef.current) {
          setLoading(false)
          setPlaying(false)
          setSource(null)
        }
      }
    },
    [stop],
  )

  useEffect(() => () => stop(), [stop])

  return { source, playing, loading, visualStartPerf, start, stop }
}
