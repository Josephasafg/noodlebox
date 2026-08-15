import { mod12, type PitchClass } from './notes'
import { getScale, type ScaleDef, type ScaleId } from './scales'
import {
  FRET_COUNT,
  STANDARD_TUNING,
  noteAt,
  rootFretOnLowE,
  type FretNote,
} from './fretboard'
import { scalePitchClasses } from './scales'

/**
 * Expressive marks a lick note can carry. These affect notation and, for bends,
 * playback — everything else is purely how the note is attacked.
 */
export type Articulation =
  | 'bend-half'
  | 'bend-full'
  | 'slide-up'
  | 'slide-down'
  | 'hammer'
  | 'pull'
  | 'vibrato'
  | 'harmonic'

/**
 * A note inside a lick, stored relative to the root so the shape can slide to
 * any key. `offset` is semitones above the root's fret on the lowest string,
 * which makes the whole library key-agnostic.
 */
export interface LickNote {
  /** 0 = lowest string (E in standard tuning) … 5 = highest. */
  string: number
  /** Semitones above the root fret on the lowest string. */
  offset: number
  /** Onset in beats from the start of the lick (1 = quarter note). */
  beat: number
  /** Sounding length in beats. */
  length: number
  art?: Articulation
}

export type Difficulty = 1 | 2 | 3

export interface Lick {
  id: string
  name: string
  /** Genre / player flavour, e.g. "blues-rock · B.B. King vocabulary". */
  style: string
  /** The scale the lick is written from. */
  scaleId: ScaleId
  /** Box this sits in, as an index into positionsForScale. */
  position?: number
  difficulty: Difficulty
  bpm: number
  beatsPerBar: number
  tags: readonly string[]
  notes: readonly LickNote[]
  /** One-line practice note shown alongside the tab. */
  tip?: string
}

/**
 * Semitone distance of each string above the lowest, derived from a pitch-class
 * tuning by assuming every string is the nearest ascending interval from the one
 * below it. Standard tuning yields [0, 5, 10, 15, 19, 24].
 */
export function stringSemitones(tuning: readonly PitchClass[] = STANDARD_TUNING): number[] {
  const out = [0]
  for (let s = 1; s < tuning.length; s++) {
    const step = mod12(tuning[s] - tuning[s - 1])
    out.push(out[s - 1] + (step === 0 ? 12 : step))
  }
  return out
}

const BEND_SEMITONES: Partial<Record<Articulation, number>> = {
  'bend-half': 1,
  'bend-full': 2,
}

/** Semitones a note is bent up to, 0 when it is not a bend. */
export function bendAmount(art: Articulation | undefined): number {
  return art ? (BEND_SEMITONES[art] ?? 0) : 0
}

/**
 * The scale degrees (semitones above the root) a lick strikes. Independent of
 * key, which is what makes scale matching a pure set comparison.
 *
 * Bend targets are deliberately excluded: bending ♭3 up a half step to the major
 * 3rd is standard blues phrasing, and counting that passing pitch would wrongly
 * disqualify the lick from the minor pentatonic it belongs to.
 */
export function lickIntervals(
  lick: Lick,
  tuning: readonly PitchClass[] = STANDARD_TUNING,
): Set<number> {
  const semis = stringSemitones(tuning)
  const out = new Set<number>()
  for (const n of lick.notes) out.add(mod12(semis[n.string] + n.offset))
  return out
}

/** True when every note the lick strikes exists in `scale`, in any key. */
export function isLickPlayableIn(
  lick: Lick,
  scale: ScaleDef,
  tuning: readonly PitchClass[] = STANDARD_TUNING,
): boolean {
  const allowed = new Set<number>(scale.intervals)
  for (const iv of lickIntervals(lick, tuning)) {
    if (!allowed.has(iv)) return false
  }
  return true
}

export interface ResolvedLickNote extends FretNote {
  /** Index into the lick's own note array, so notation and audio stay aligned. */
  noteIndex: number
  beat: number
  length: number
  art?: Articulation
}

export interface ResolvedLick {
  lick: Lick
  key: PitchClass
  notes: ResolvedLickNote[]
  minFret: number
  maxFret: number
  /** Octaves the shape was slid by to keep it on the neck. */
  octaveShift: number
  totalBeats: number
}

/**
 * Choose an octave for the shape so it lands on the playable neck. Shapes rooted
 * high up (root fret 11) can push past the last fret, in which case dropping an
 * octave is the same shape in a reachable place.
 */
function fitOctaveShift(rootFret: number, lo: number, hi: number, maxFret: number): number {
  const candidates = [0, -12, 12, -24, 24]
  let best = 0
  let bestPenalty = Infinity
  for (const shift of candidates) {
    const low = rootFret + lo + shift
    const high = rootFret + hi + shift
    const penalty = Math.max(0, -low) + Math.max(0, high - maxFret)
    if (penalty < bestPenalty) {
      bestPenalty = penalty
      best = shift
      if (penalty === 0) break
    }
  }
  return best
}

/** Place a lick on the fretboard in a concrete key. */
export function resolveLick(
  lick: Lick,
  key: PitchClass,
  tuning: readonly PitchClass[] = STANDARD_TUNING,
  maxFret: number = FRET_COUNT,
): ResolvedLick {
  const scale = getScale(lick.scaleId)
  const scalePcs = scale ? scalePitchClasses(key, scale) : []
  const degreeOf = new Map<PitchClass, number>()
  scalePcs.forEach((pc, i) => {
    if (!degreeOf.has(pc)) degreeOf.set(pc, i)
  })

  const rootFret = rootFretOnLowE(key, tuning)
  const offsets = lick.notes.map((n) => n.offset)
  const lo = offsets.length ? Math.min(...offsets) : 0
  const hi = offsets.length ? Math.max(...offsets) : 0
  const octaveShift = fitOctaveShift(rootFret, lo, hi, maxFret)

  const notes: ResolvedLickNote[] = lick.notes.map((n, noteIndex) => {
    const fret = rootFret + n.offset + octaveShift
    const pitch = noteAt(n.string, fret, tuning)
    return {
      noteIndex,
      stringIdx: n.string,
      fret,
      pitch,
      degreeIndex: degreeOf.get(pitch) ?? 0,
      isRoot: pitch === key,
      beat: n.beat,
      length: n.length,
      art: n.art,
    }
  })

  const frets = notes.map((n) => n.fret)
  const totalBeats = lick.notes.reduce((max, n) => Math.max(max, n.beat + n.length), 0)

  return {
    lick,
    key,
    notes,
    minFret: frets.length ? Math.min(...frets) : 0,
    maxFret: frets.length ? Math.max(...frets) : 0,
    octaveShift,
    totalBeats,
  }
}

export type MatchKind = 'exact' | 'compatible'

export interface LickMatch {
  lick: Lick
  /** 'exact' when written from the selected scale, 'compatible' when it merely fits inside it. */
  match: MatchKind
  /** Scale the lick was written from, for display on compatible matches. */
  sourceScale: ScaleDef | null
}

export interface LickQuery {
  scale: ScaleDef
  /** Also return licks from other scales whose notes all fit inside `scale`. */
  includeCompatible?: boolean
  text?: string
  difficulty?: Difficulty | null
  /** Restrict to licks tagged with this box index. */
  position?: number | null
  tuning?: readonly PitchClass[]
}

function textHaystack(lick: Lick, sourceScale: ScaleDef | null): string {
  return [lick.name, lick.style, lick.tags.join(' '), sourceScale?.displayName ?? '', lick.tip ?? '']
    .join(' ')
    .toLowerCase()
}

const DIFFICULTY_ORDER: Record<MatchKind, number> = { exact: 0, compatible: 1 }

/**
 * Find licks for the scale being studied. Exact matches (written from that scale)
 * rank above compatible ones (borrowed from a scale that fits inside it), then
 * easiest first.
 */
export function searchLicks(licks: readonly Lick[], query: LickQuery): LickMatch[] {
  const { scale, includeCompatible = true, text = '', difficulty = null, position = null, tuning } = query
  const needle = text.trim().toLowerCase()
  const terms = needle.length > 0 ? needle.split(/\s+/) : []

  const matches: LickMatch[] = []
  for (const lick of licks) {
    const isExact = lick.scaleId === scale.id
    if (!isExact) {
      if (!includeCompatible) continue
      if (!isLickPlayableIn(lick, scale, tuning)) continue
    }
    if (difficulty !== null && lick.difficulty !== difficulty) continue
    if (position !== null && lick.position !== position) continue

    const sourceScale = getScale(lick.scaleId)
    if (terms.length > 0) {
      const hay = textHaystack(lick, sourceScale)
      if (!terms.every((t) => hay.includes(t))) continue
    }

    matches.push({ lick, match: isExact ? 'exact' : 'compatible', sourceScale })
  }

  return matches.sort((a, b) => {
    const byMatch = DIFFICULTY_ORDER[a.match] - DIFFICULTY_ORDER[b.match]
    if (byMatch !== 0) return byMatch
    if (a.lick.difficulty !== b.lick.difficulty) return a.lick.difficulty - b.lick.difficulty
    return a.lick.name.localeCompare(b.lick.name)
  })
}

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  1: 'easy',
  2: 'medium',
  3: 'hard',
}

export const ARTICULATION_LABELS: Record<Articulation, string> = {
  'bend-half': 'half-step bend',
  'bend-full': 'whole-step bend',
  'slide-up': 'slide up',
  'slide-down': 'slide down',
  hammer: 'hammer-on',
  pull: 'pull-off',
  vibrato: 'vibrato',
  harmonic: 'natural harmonic',
}
