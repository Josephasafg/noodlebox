import type { Lick } from '../../theory/licks'
import { PENTATONIC_LICKS } from './pentatonic'
import { BLUES_LICKS } from './blues'
import { MINOR_LICKS } from './minor'
import { MAJOR_LICKS } from './major'
import { MODAL_LICKS } from './modal'

export const ALL_LICKS: readonly Lick[] = [
  ...PENTATONIC_LICKS,
  ...BLUES_LICKS,
  ...MINOR_LICKS,
  ...MAJOR_LICKS,
  ...MODAL_LICKS,
]

export function getLick(id: string): Lick | null {
  return ALL_LICKS.find((l) => l.id === id) ?? null
}

/** Every tag in the library, sorted, for filter chips. */
export const ALL_TAGS: readonly string[] = [
  ...new Set(ALL_LICKS.flatMap((l) => l.tags)),
].sort()
