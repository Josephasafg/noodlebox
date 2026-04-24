import { useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { CHROMATIC_KEYS, pcFromName, pcToSlug, type PitchClass } from '../theory/notes'
import { getScale, SCALES, SCALE_LIST, type ScaleDef } from '../theory/scales'
import { positionsForScale } from '../theory/fretboard'

export const DEFAULT_KEY: PitchClass = 9 // A
export const DEFAULT_SCALE: ScaleDef = SCALES['minor-pentatonic']
export const DEFAULT_POSITION = 0

export interface ScaleState {
  key: PitchClass
  scale: ScaleDef
  positionIndex: number
  setKey: (pc: PitchClass) => void
  setScale: (scaleId: string) => void
  setPosition: (index: number) => void
  cycleKey: (delta: number) => void
  cycleScale: (delta: number) => void
  cyclePosition: (delta: number) => void
}

function buildPath(key: PitchClass, scale: ScaleDef, positionIndex: number): string {
  return `/${pcToSlug(key)}/${scale.id}/${positionIndex + 1}`
}

export function useScaleState(): ScaleState {
  const params = useParams<{ keySlug: string; scaleId: string; positionIdx: string }>()
  const navigate = useNavigate()

  const key: PitchClass = pcFromName(params.keySlug ?? '') ?? DEFAULT_KEY
  const scale: ScaleDef = getScale(params.scaleId ?? '') ?? DEFAULT_SCALE
  const totalPositions = positionsForScale(scale).length
  const rawIndex = Number(params.positionIdx ?? 1) - 1
  const positionIndex = Number.isFinite(rawIndex)
    ? Math.min(totalPositions - 1, Math.max(0, rawIndex))
    : DEFAULT_POSITION

  const setKey = useCallback(
    (pc: PitchClass) => {
      navigate(buildPath(pc, scale, positionIndex), { replace: false })
    },
    [navigate, scale, positionIndex],
  )

  const setScale = useCallback(
    (scaleId: string) => {
      const next = getScale(scaleId)
      if (!next) return
      const clamped = Math.min(positionIndex, positionsForScale(next).length - 1)
      navigate(buildPath(key, next, clamped), { replace: false })
    },
    [navigate, key, positionIndex],
  )

  const setPosition = useCallback(
    (index: number) => {
      const clamped = Math.min(totalPositions - 1, Math.max(0, index))
      navigate(buildPath(key, scale, clamped), { replace: false })
    },
    [navigate, key, scale, totalPositions],
  )

  const cycleKey = useCallback(
    (delta: number) => {
      const idx = CHROMATIC_KEYS.indexOf(key)
      const next = CHROMATIC_KEYS[(idx + delta + CHROMATIC_KEYS.length) % CHROMATIC_KEYS.length]
      setKey(next)
    },
    [key, setKey],
  )

  const cycleScale = useCallback(
    (delta: number) => {
      const idx = SCALE_LIST.findIndex((s) => s.id === scale.id)
      const next = SCALE_LIST[(idx + delta + SCALE_LIST.length) % SCALE_LIST.length]
      setScale(next.id)
    },
    [scale.id, setScale],
  )

  const cyclePosition = useCallback(
    (delta: number) => {
      const next = (positionIndex + delta + totalPositions) % totalPositions
      setPosition(next)
    },
    [positionIndex, totalPositions, setPosition],
  )

  return {
    key,
    scale,
    positionIndex,
    setKey,
    setScale,
    setPosition,
    cycleKey,
    cycleScale,
    cyclePosition,
  }
}
