import { useEffect, useState } from 'react'

export function useSequencePlayhead(
  count: number,
  stepMs: number = 260,
  enabled: boolean = true,
  startAt: number | null = null,
): number {
  const [i, setI] = useState(-1)

  useEffect(() => {
    if (!enabled || count === 0) {
      setI(-1)
      return
    }

    const start = startAt ?? performance.now()
    let raf = 0
    let lastIdx = -2

    const tick = () => {
      const elapsed = performance.now() - start
      let idx: number
      if (elapsed < 0) {
        idx = -1
      } else {
        const step = Math.floor(elapsed / stepMs)
        idx = step >= count ? -1 : step
      }
      if (idx !== lastIdx) {
        lastIdx = idx
        setI(idx)
      }
      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [count, stepMs, enabled, startAt])

  return i
}
