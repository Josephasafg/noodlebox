import { describe, it, expect } from 'vitest'
import { SCALES, scalePitchClasses, getScale } from '../scales'
import { pcFromName } from '../notes'

describe('scalePitchClasses', () => {
  it('C major → C D E F G A B', () => {
    expect(scalePitchClasses(0, SCALES['major'])).toEqual([0, 2, 4, 5, 7, 9, 11])
  })

  it('A natural minor → A B C D E F G', () => {
    expect(scalePitchClasses(9, SCALES['natural-minor'])).toEqual([9, 11, 0, 2, 4, 5, 7])
  })

  it('A minor pentatonic → A C D E G', () => {
    expect(scalePitchClasses(9, SCALES['minor-pentatonic'])).toEqual([9, 0, 2, 4, 7])
  })

  it('A blues → A C D D♯ E G', () => {
    expect(scalePitchClasses(9, SCALES['blues'])).toEqual([9, 0, 2, 3, 4, 7])
  })

  it('E harmonic minor → E F♯ G A B C D♯', () => {
    expect(scalePitchClasses(4, SCALES['harmonic-minor'])).toEqual([4, 6, 7, 9, 11, 0, 3])
  })

  it('D dorian shares pitches with C major', () => {
    const dDorian = scalePitchClasses(2, SCALES['dorian']).sort((a, b) => a - b)
    const cMajor = scalePitchClasses(0, SCALES['major']).sort((a, b) => a - b)
    expect(dDorian).toEqual(cMajor)
  })

  it('E phrygian shares pitches with C major', () => {
    const ePhrygian = scalePitchClasses(4, SCALES['phrygian']).sort((a, b) => a - b)
    const cMajor = scalePitchClasses(0, SCALES['major']).sort((a, b) => a - b)
    expect(ePhrygian).toEqual(cMajor)
  })
})

describe('pcFromName', () => {
  it('parses sharp, flat, and unicode forms', () => {
    expect(pcFromName('A')).toBe(9)
    expect(pcFromName('a')).toBe(9)
    expect(pcFromName('A#')).toBe(10)
    expect(pcFromName('A♯')).toBe(10)
    expect(pcFromName('Bb')).toBe(10)
    expect(pcFromName('B♭')).toBe(10)
    expect(pcFromName('a-sharp')).toBe(10)
    expect(pcFromName('e-flat')).toBe(3)
  })

  it('returns null for invalid names', () => {
    expect(pcFromName('H')).toBeNull()
    expect(pcFromName('')).toBeNull()
  })
})

describe('getScale', () => {
  it('returns null for unknown scale', () => {
    expect(getScale('bogus')).toBeNull()
  })

  it('returns the scale def for a known id', () => {
    expect(getScale('major')?.displayName).toBe('Major')
  })
})
