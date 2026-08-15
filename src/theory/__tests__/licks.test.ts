import { describe, expect, it } from 'vitest'
import { ALL_LICKS, ALL_TAGS, getLick } from '../../data/licks'
import { CHROMATIC_KEYS, mod12, type PitchClass } from '../notes'
import { FRET_COUNT, positionsForScale } from '../fretboard'
import { SCALES, getScale, scalePitchClasses } from '../scales'
import {
  bendAmount,
  isLickPlayableIn,
  lickIntervals,
  resolveLick,
  searchLicks,
  stringSemitones,
} from '../licks'

describe('stringSemitones', () => {
  it('derives standard tuning distances from pitch classes', () => {
    expect(stringSemitones()).toEqual([0, 5, 10, 15, 19, 24])
  })

  it('handles a lowered sixth string without collapsing the interval', () => {
    // Drop D: the E→A gap becomes a whole extra tone.
    expect(stringSemitones([2, 9, 2, 7, 11, 4])).toEqual([0, 7, 12, 17, 21, 26])
  })
})

describe('lick library integrity', () => {
  it('has licks to search', () => {
    expect(ALL_LICKS.length).toBeGreaterThan(20)
  })

  it('uses unique ids', () => {
    const ids = ALL_LICKS.map((l) => l.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('references scales that exist', () => {
    for (const lick of ALL_LICKS) {
      expect(getScale(lick.scaleId), lick.id).not.toBeNull()
    }
  })

  it.each(ALL_LICKS.map((l) => [l.id, l] as const))(
    '%s only strikes notes that belong to its own scale',
    (_id, lick) => {
      const scale = getScale(lick.scaleId)!
      const allowed = new Set<number>(scale.intervals)
      const offenders = [...lickIntervals(lick)].filter((iv) => !allowed.has(iv))
      expect(offenders).toEqual([])
    },
  )

  it.each(ALL_LICKS.map((l) => [l.id, l] as const))(
    '%s lands on the playable neck in all twelve keys',
    (_id, lick) => {
      for (const key of CHROMATIC_KEYS) {
        const resolved = resolveLick(lick, key)
        expect(resolved.minFret, `${lick.id} in key ${key}`).toBeGreaterThanOrEqual(0)
        expect(resolved.maxFret, `${lick.id} in key ${key}`).toBeLessThanOrEqual(FRET_COUNT)
      }
    },
  )

  it.each(ALL_LICKS.map((l) => [l.id, l] as const))(
    '%s has a coherent timeline and playable strings',
    (_id, lick) => {
      expect(lick.notes.length).toBeGreaterThan(0)
      expect(lick.bpm).toBeGreaterThan(30)
      expect(lick.beatsPerBar).toBeGreaterThan(0)
      for (const n of lick.notes) {
        expect(n.string, 'string index').toBeGreaterThanOrEqual(0)
        expect(n.string, 'string index').toBeLessThanOrEqual(5)
        expect(n.offset, 'offset').toBeGreaterThanOrEqual(0)
        expect(n.beat, 'beat').toBeGreaterThanOrEqual(0)
        expect(n.length, 'length').toBeGreaterThan(0)
      }
    },
  )

  it.each(ALL_LICKS.filter((l) => l.position !== undefined).map((l) => [l.id, l] as const))(
    '%s declares a position that exists for its scale',
    (_id, lick) => {
      const scale = getScale(lick.scaleId)!
      expect(lick.position!).toBeLessThan(positionsForScale(scale).length)
    },
  )

  it('exposes every tag used by the library', () => {
    const used = new Set(ALL_LICKS.flatMap((l) => l.tags))
    expect(new Set(ALL_TAGS)).toEqual(used)
  })

  it('finds licks by id', () => {
    expect(getLick(ALL_LICKS[0].id)).toBe(ALL_LICKS[0])
    expect(getLick('nope')).toBeNull()
  })
})

describe('resolveLick', () => {
  it('slides the shape so the root lands under the written offsets', () => {
    const lick = ALL_LICKS.find((l) => l.id === 'minpent-box1-run')!
    // A minor pentatonic: root fret 5 on the low E string.
    const a = resolveLick(lick, 9)
    expect(a.notes[0].fret).toBe(5)
    expect(a.notes[0].isRoot).toBe(true)
    // E minor pentatonic: the same shape at the nut.
    const e = resolveLick(lick, 4)
    expect(e.notes[0].fret).toBe(0)
    expect(e.notes[0].isRoot).toBe(true)
  })

  it('keeps every resolved pitch inside the scale, in every key', () => {
    for (const lick of ALL_LICKS) {
      const scale = getScale(lick.scaleId)!
      for (const key of CHROMATIC_KEYS) {
        const allowed = new Set(scalePitchClasses(key, scale))
        const resolved = resolveLick(lick, key)
        for (const n of resolved.notes) {
          expect(allowed.has(n.pitch), `${lick.id} key ${key} pitch ${n.pitch}`).toBe(true)
        }
      }
    }
  })

  it('transposes by exactly the interval between two keys', () => {
    const lick = ALL_LICKS.find((l) => l.id === 'minpent-triplet-descent')!
    const a = resolveLick(lick, 9)
    const c = resolveLick(lick, 0)
    a.notes.forEach((note, i) => {
      const shift = c.notes[i].fret - note.fret
      expect(mod12(shift)).toBe(mod12(0 - 9))
    })
  })

  it('reports the timeline length in beats', () => {
    const lick = ALL_LICKS.find((l) => l.id === 'minpent-box1-run')!
    expect(resolveLick(lick, 9).totalBeats).toBeCloseTo(3)
  })

  it('assigns degree indices that point back into the scale', () => {
    const lick = ALL_LICKS.find((l) => l.id === 'minpent-box1-run')!
    const scale = SCALES['minor-pentatonic']
    const pcs = scalePitchClasses(9, scale)
    for (const n of resolveLick(lick, 9).notes) {
      expect(pcs[n.degreeIndex]).toBe(n.pitch)
    }
  })
})

describe('bendAmount', () => {
  it('measures half and whole step bends and ignores other marks', () => {
    expect(bendAmount('bend-half')).toBe(1)
    expect(bendAmount('bend-full')).toBe(2)
    expect(bendAmount('vibrato')).toBe(0)
    expect(bendAmount(undefined)).toBe(0)
  })
})

describe('isLickPlayableIn', () => {
  it('lets minor pentatonic licks be used over natural minor and blues', () => {
    const lick = ALL_LICKS.find((l) => l.id === 'minpent-box1-run')!
    expect(isLickPlayableIn(lick, SCALES['natural-minor'])).toBe(true)
    expect(isLickPlayableIn(lick, SCALES['blues'])).toBe(true)
    expect(isLickPlayableIn(lick, SCALES['dorian'])).toBe(true)
  })

  it('rejects a minor pentatonic lick over the major scale', () => {
    const lick = ALL_LICKS.find((l) => l.id === 'minpent-box1-run')!
    expect(isLickPlayableIn(lick, SCALES['major'])).toBe(false)
  })

  it('keeps the ♭5 out of scales that do not contain it', () => {
    const lick = ALL_LICKS.find((l) => l.id === 'blues-box1-run')!
    expect(isLickPlayableIn(lick, SCALES['blues'])).toBe(true)
    expect(isLickPlayableIn(lick, SCALES['natural-minor'])).toBe(false)
    expect(isLickPlayableIn(lick, SCALES['minor-pentatonic'])).toBe(false)
  })

  it('is independent of key', () => {
    const lick = ALL_LICKS.find((l) => l.id === 'aeolian-3nps-run')!
    const keys: PitchClass[] = [...CHROMATIC_KEYS]
    const results = keys.map(() => isLickPlayableIn(lick, SCALES['natural-minor']))
    expect(new Set(results).size).toBe(1)
  })
})

describe('searchLicks', () => {
  it('ranks licks written for the scale above borrowed ones', () => {
    const results = searchLicks(ALL_LICKS, { scale: SCALES['natural-minor'] })
    const firstCompatible = results.findIndex((r) => r.match === 'compatible')
    const lastExact = results.map((r) => r.match).lastIndexOf('exact')
    expect(firstCompatible).toBeGreaterThan(-1)
    expect(lastExact).toBeLessThan(firstCompatible)
  })

  it('returns only exact matches when compatibility is off', () => {
    const results = searchLicks(ALL_LICKS, {
      scale: SCALES['natural-minor'],
      includeCompatible: false,
    })
    expect(results.length).toBeGreaterThan(0)
    expect(results.every((r) => r.lick.scaleId === 'natural-minor')).toBe(true)
  })

  it('surfaces pentatonic licks as compatible options for natural minor', () => {
    const results = searchLicks(ALL_LICKS, { scale: SCALES['natural-minor'] })
    const ids = results.map((r) => r.lick.id)
    expect(ids).toContain('minpent-box1-run')
    expect(results.find((r) => r.lick.id === 'minpent-box1-run')!.match).toBe('compatible')
  })

  it('never offers a blues ♭5 lick for the major scale', () => {
    const results = searchLicks(ALL_LICKS, { scale: SCALES['major'] })
    expect(results.some((r) => r.lick.scaleId === 'blues')).toBe(false)
  })

  it('matches text against name, style and tags', () => {
    const byName = searchLicks(ALL_LICKS, { scale: SCALES['minor-pentatonic'], text: 'bend climb' })
    expect(byName.map((r) => r.lick.id)).toContain('minpent-bend-climb')

    const byTag = searchLicks(ALL_LICKS, { scale: SCALES['minor-pentatonic'], text: 'triplets' })
    expect(byTag.length).toBeGreaterThan(0)
    expect(byTag.every((r) => [r.lick.name, r.lick.style, ...r.lick.tags].join(' ').toLowerCase().includes('triplet'))).toBe(true)
  })

  it('requires every search term to match', () => {
    const results = searchLicks(ALL_LICKS, {
      scale: SCALES['minor-pentatonic'],
      text: 'bend zzzz',
    })
    expect(results).toEqual([])
  })

  it('filters by difficulty', () => {
    const results = searchLicks(ALL_LICKS, { scale: SCALES['minor-pentatonic'], difficulty: 1 })
    expect(results.length).toBeGreaterThan(0)
    expect(results.every((r) => r.lick.difficulty === 1)).toBe(true)
  })

  it('filters by position', () => {
    const results = searchLicks(ALL_LICKS, { scale: SCALES['minor-pentatonic'], position: 0 })
    expect(results.length).toBeGreaterThan(0)
    expect(results.every((r) => r.lick.position === 0)).toBe(true)
  })

  it('finds something for every scale in the picker', () => {
    for (const scale of Object.values(SCALES)) {
      const results = searchLicks(ALL_LICKS, { scale })
      expect(results.length, `no licks for ${scale.id}`).toBeGreaterThan(0)
    }
  })
})
