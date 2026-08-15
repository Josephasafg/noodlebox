/**
 * Checks that primitives read out of a video parse as a score.
 *
 * The video reader in `scripts/tabvideo` emits the same `TabPagePrimitives` a
 * PDF would have produced, so the existing parser should need no special case.
 * Videos and the transcriptions in them are copyrighted, so nothing is committed
 * here and this skips by default. Point it at a run's output to check it:
 *
 *     python3 -m scripts.tabvideo.cli clip.mp4 --out build/tab
 *     # name the shapes in build/tab/labels.json, then
 *     python3 -m scripts.tabvideo.cli clip.mp4 --out build/tab --labels build/tab/labels.json
 *     TAB_VIDEO_PRIMITIVES="build/tab/primitives.json" npx vitest run scripts/verify-tab-video.test.ts
 *
 * As with the PDF check, the assertions are about shape rather than content, so
 * they hold for any video rather than one particular upload.
 */
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { findTabStaves, parseScore } from '../src/tabpdf/parse'
import { sliceScore } from '../src/tabpdf/playable'
import type { TabPagePrimitives } from '../src/tabpdf/types'

const FILE = process.env.TAB_VIDEO_PRIMITIVES ?? ''
const present = FILE.length > 0 && existsSync(FILE)

function read(): TabPagePrimitives[] {
  return JSON.parse(readFileSync(FILE, 'utf-8')) as TabPagePrimitives[]
}

describe.skipIf(!present)('reading tab primitives from a video', () => {
  it('finds one six-line tab staff per system', () => {
    const pages = read()
    expect(pages.length).toBeGreaterThan(0)
    for (const page of pages) {
      const staves = findTabStaves(page)
      // Each composited page holds a single engraved system.
      expect(staves).toHaveLength(1)
      expect(staves[0].lines).toHaveLength(6)
      expect(staves[0].spacing).toBeGreaterThan(1)
    }
  })

  it('reads bars and notes off the systems', () => {
    const score = parseScore(read())
    expect(score.measures.length).toBeGreaterThan(0)
    expect(score.notes.length).toBeGreaterThan(0)
  })

  it('keeps every note on a real string at a reachable fret', () => {
    const score = parseScore(read())
    for (const note of score.notes) {
      expect(note.stringIdx).toBeGreaterThanOrEqual(0)
      expect(note.stringIdx).toBeLessThanOrEqual(5)
      if (note.fret !== null) {
        expect(note.fret).toBeGreaterThanOrEqual(0)
        expect(note.fret).toBeLessThanOrEqual(24)
      }
    }
  })

  it('lays measures out in playing order', () => {
    const score = parseScore(read())
    for (let i = 1; i < score.measures.length; i += 1) {
      expect(score.measures[i].startBeat).toBeGreaterThan(score.measures[i - 1].startBeat)
    }
  })

  it('produces something playable', () => {
    const score = parseScore(read())
    const slice = sliceScore(score, 0, score.measures.length - 1)
    expect(slice.notes.length).toBeGreaterThan(0)
    expect(slice.totalBeats).toBeGreaterThan(0)
  })
})
