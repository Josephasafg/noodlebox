import { describe, expect, it } from 'vitest'
import { lickSchedule } from '../guitar'
import { ALL_LICKS } from '../../data/licks'
import { resolveLick } from '../../theory/licks'
import { CHROMATIC_KEYS, mod12 } from '../../theory/notes'
import { STANDARD_TUNING } from '../../theory/fretboard'

/**
 * These lock in the guarantee that playback matches the printed tab: one attack
 * per notated note, at the pitch that note's fret number produces.
 */
describe('lickSchedule', () => {
  it('schedules exactly one attack per notated note', () => {
    for (const lick of ALL_LICKS) {
      const resolved = resolveLick(lick, 9)
      const schedule = lickSchedule(resolved.notes, lick.bpm)
      expect(schedule.length, lick.id).toBe(resolved.notes.length)
    }
  })

  it('never sounds a pitch the tab did not print, including on bends', () => {
    const bendLicks = ALL_LICKS.filter((l) =>
      l.notes.some((n) => n.art === 'bend-half' || n.art === 'bend-full'),
    )
    expect(bendLicks.length).toBeGreaterThan(0)

    for (const lick of bendLicks) {
      const resolved = resolveLick(lick, 9)
      const schedule = lickSchedule(resolved.notes, lick.bpm)
      // One attack per note, and every pitch traces back to a printed fret.
      expect(schedule.length, lick.id).toBe(resolved.notes.length)
      schedule.forEach((s, i) => {
        expect(mod12(s.midi), `${lick.id} note ${i}`).toBe(resolved.notes[i].pitch)
      })
    }
  })

  it('sounds the pitch each printed fret number produces, in every key', () => {
    for (const lick of ALL_LICKS) {
      for (const key of CHROMATIC_KEYS) {
        const resolved = resolveLick(lick, key)
        const schedule = lickSchedule(resolved.notes, lick.bpm)
        schedule.forEach((s, i) => {
          const note = resolved.notes[i]
          // The scheduled pitch must equal the note the tab tells you to fret.
          expect(mod12(s.midi), `${lick.id} key ${key} note ${i}`).toBe(
            mod12(STANDARD_TUNING[note.stringIdx] + note.fret),
          )
          expect(s.noteIndex).toBe(i)
        })
      }
    }
  })

  it('places attacks on the beat the tab draws them', () => {
    const lick = ALL_LICKS.find((l) => l.id === 'minpent-box1-run')!
    const resolved = resolveLick(lick, 9)
    const schedule = lickSchedule(resolved.notes, 120) // 0.5s per beat
    schedule.forEach((s, i) => {
      expect(s.offsetSeconds).toBeCloseTo(resolved.notes[i].beat * 0.5)
    })
  })

  it('keeps simultaneous notes simultaneous', () => {
    // A double stop is written as one column in the tab and must sound as one.
    const lick = ALL_LICKS.find((l) => l.id === 'minpent-fourths-doublestop')!
    const resolved = resolveLick(lick, 9)
    const schedule = lickSchedule(resolved.notes, 120)
    const firstBeat = schedule.filter((s) => s.offsetSeconds === schedule[0].offsetSeconds)
    expect(firstBeat.length).toBe(2)
    expect(firstBeat[0].midi).not.toBe(firstBeat[1].midi)
  })

  it('softens legato notes but still sounds them', () => {
    const lick = ALL_LICKS.find((l) => l.id === 'minpent-hammer-roll')!
    const resolved = resolveLick(lick, 9)
    const schedule = lickSchedule(resolved.notes, lick.bpm)
    const hammered = resolved.notes
      .map((n, i) => (n.art === 'hammer' ? i : -1))
      .filter((i) => i >= 0)
    expect(hammered.length).toBeGreaterThan(0)
    for (const i of hammered) expect(schedule[i].velocity).toBe(72)
    expect(schedule[0].velocity).toBe(92)
  })
})
