import { useEffect, useState } from 'react'

/**
 * Current position inside a lick, in beats, driven off the audio clock's start
 * time so notation and sound stay locked together. Returns null when idle or
 * before the scheduled start, and stops at the end of the timeline.
 */
export function useBeatPlayhead(
  enabled: boolean,
  startPerf: number | null,
  bpm: number,
  totalBeats: number,
): number | null {
  // The frame's own start time is stored with it, so a position measured against
  // a previous playback can never leak into a new one as a stale first frame.
  const [frame, setFrame] = useState<{ start: number; beat: number | null } | null>(null)
  const running = enabled && startPerf !== null && totalBeats > 0

  useEffect(() => {
    if (!running || startPerf === null) return

    const msPerBeat = 60000 / bpm
    let raf = 0

    const tick = () => {
      const elapsed = performance.now() - startPerf
      const position = elapsed / msPerBeat
      const beat = elapsed < 0 || position > totalBeats ? null : position
      setFrame({ start: startPerf, beat })
      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [running, startPerf, bpm, totalBeats])

  if (!running || frame === null || frame.start !== startPerf) return null
  return frame.beat
}

/** Indices of the notes sounding at `beat`, for highlighting notation and fretboard. */
export function notesAtBeat(
  notes: readonly { beat: number; length: number }[],
  beat: number | null,
): number[] {
  if (beat === null) return []
  const active: number[] = []
  notes.forEach((n, i) => {
    if (beat >= n.beat && beat < n.beat + n.length) active.push(i)
  })
  return active
}
