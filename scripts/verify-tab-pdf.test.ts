/**
 * Checks the tab reader against a real PDF on disk.
 *
 * Tab PDFs are copyrighted, so none is committed here and this skips by default.
 * Point it at one to run it:
 *
 *     TAB_PDF="/path/to/tab.pdf" npx vitest run scripts/verify-tab-pdf.test.ts
 *
 * The assertions are deliberately about shape rather than content, so they hold
 * for any engraved tab rather than one particular file.
 */
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { extractPrimitives } from '../src/tabpdf/extract'
import { findTabStaves, parseScore } from '../src/tabpdf/parse'
import { bendMark } from '../src/tabpdf/notation'
import { sliceScore } from '../src/tabpdf/playable'

const FILE = process.env.TAB_PDF ?? ''
const present = FILE.length > 0 && existsSync(FILE)

describe.skipIf(!present)('reading a real tab PDF', () => {
  async function read() {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const data = new Uint8Array(readFileSync(FILE))
    const doc = await pdfjs.getDocument({ data }).promise
    const pages = await extractPrimitives(doc as never, pdfjs.OPS as never)
    return { pages, score: parseScore(pages) }
  }

  it('finds tab staves on the pages', async () => {
    const { pages } = await read()
    const staves = pages.reduce((n, p) => n + findTabStaves(p).length, 0)
    expect(staves).toBeGreaterThan(0)
    for (const page of pages) {
      for (const staff of findTabStaves(page)) {
        expect(staff.lines).toHaveLength(6)
        expect(staff.spacing).toBeGreaterThan(1)
      }
    }
  }, 120_000)

  it('reads bars and notes without leaving marks behind', async () => {
    const { score } = await read()
    expect(score.measures.length).toBeGreaterThan(0)
    expect(score.notes.length).toBeGreaterThan(0)
    expect(score.unreadCount).toBe(0)
  }, 120_000)

  it('keeps every note on a real string at a reachable fret', async () => {
    const { score } = await read()
    for (const note of score.notes) {
      expect(note.stringIdx).toBeGreaterThanOrEqual(0)
      expect(note.stringIdx).toBeLessThanOrEqual(5)
      if (note.fret !== null) {
        expect(note.fret).toBeGreaterThanOrEqual(0)
        expect(note.fret).toBeLessThanOrEqual(24)
      }
    }
  }, 120_000)

  it('turns every bend it reads into a mark the sheet can print', async () => {
    const { score } = await read()
    for (const note of score.notes) {
      const bend = note.bend
      if (!bend) continue
      if (bend.semitones !== null) {
        expect(bend.semitones).toBeGreaterThan(0)
        // Beyond two whole tones is a misread rather than a playable bend.
        expect(bend.semitones).toBeLessThanOrEqual(4)
      }
      expect(bendMark(note)).toMatch(/^(b\d{1,2}|↑|↓)$/)
    }
  }, 120_000)

  it('keeps every note inside the bar it belongs to', async () => {
    const { score } = await read()
    for (const note of score.notes) {
      const measure = score.measures[note.measureIndex]
      expect(measure).toBeDefined()
      expect(note.beat).toBeGreaterThanOrEqual(measure.startBeat)
      expect(note.beat).toBeLessThan(measure.startBeat + score.beatsPerBar)
    }
  }, 120_000)

  it('numbers bars consecutively from the start', async () => {
    const { score } = await read()
    score.measures.forEach((m, i) => {
      expect(m.index).toBe(i)
      expect(m.startBeat).toBe(i * score.beatsPerBar)
    })
  }, 120_000)

  it('slices into playable notes that stay in order', async () => {
    const { score } = await read()
    const slice = sliceScore(score, 0, Math.min(31, score.measures.length - 1))
    expect(slice.notes.length).toBeGreaterThan(0)
    for (let i = 1; i < slice.notes.length; i++) {
      expect(slice.notes[i].beat).toBeGreaterThanOrEqual(slice.notes[i - 1].beat)
    }
    expect(slice.notes.every((n) => n.fret !== null)).toBe(true)
  }, 120_000)
})
