import { describe, expect, it } from 'vitest'
import { parseUltimateGuitar } from '../ultimateGuitar'
import { sheetHasWords } from '../types'

const URL = 'https://tabs.ultimate-guitar.com/tab/a-player/a-song-tabs-1.html'

/**
 * Ultimate Guitar ships the whole tab as JSON in a `js-store` div, so a page is
 * built here the same way: the JSON is HTML-escaped into the attribute, and the
 * body uses the site's own `[tab]`, `[ch]` and `[Section]` markers.
 */
function page(content: string, extra: Record<string, unknown> = {}): string {
  const store = {
    store: {
      page: {
        data: {
          tab: { song_name: 'A Song', artist_name: 'A Player' },
          tab_view: { wiki_tab: { content }, meta: {}, ...extra },
        },
      },
    },
  }
  const attr = JSON.stringify(store).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  return `<html><body><div class="js-store" data-content="${attr}"></div></body></html>`
}

const TAB_BODY = [
  'A Song',
  'By A Player',
  'Tabbed By Somebody',
  '',
  '[Intro]',
  '',
  '[tab]e|---------5------|',
  'B|-------5--------|',
  'G|-----6----------|',
  'D|----------------|',
  'A|----------------|',
  'E|----5-----------|[/tab]',
  '',
  '[Solo]',
  '',
  '[tab]e|---12b14--------|',
  'B|----------------|',
  'G|----------------|',
  'D|----------------|',
  'A|----------------|',
  'E|----------------|[/tab]',
].join('\r\n')

describe('parseUltimateGuitar', () => {
  const parsed = parseUltimateGuitar(page(TAB_BODY), URL)

  it('takes the song and artist from the data the page ships', () => {
    expect(parsed.sheet.title).toBe('A Song')
    expect(parsed.sheet.artist).toBe('A Player')
    expect(parsed.sheet.sourceUrl).toBe(URL)
  })

  it('engraves every staff as a score', () => {
    expect(parsed.blocks).toHaveLength(2)
    expect(parsed.score).not.toBeNull()
    expect(parsed.score?.notes.length).toBeGreaterThan(0)
  })

  it('names the bars each staff opens with after its section', () => {
    const markers = parsed.score?.measures.filter((m) => m.marker).map((m) => m.marker)
    expect(markers).toEqual(['Intro', 'Solo'])
  })

  it('reads the notation the site prints', () => {
    const bent = parsed.score?.notes.find((n) => n.bend)
    expect(bent?.fret).toBe(12)
    expect(bent?.bend).toEqual({ semitones: 2, direction: 'up' })
  })

  it('leaves an instrumental with no sheet to show', () => {
    // Credits and headings are not words to sing, so nothing is invented from
    // them — the score is the whole song.
    expect(sheetHasWords(parsed.sheet)).toBe(false)
  })

  it('reads the tuning the page records', () => {
    const tuned = parseUltimateGuitar(
      page(TAB_BODY, { meta: { tuning: { name: 'Standard', value: 'E A D G B E' } } }),
      URL,
    )
    expect(tuned.score?.tuningNote).toBe('E A D G B E')
  })
})

describe('a page of chords over words', () => {
  const body = [
    '[Verse 1]',
    '[ch]Am[/ch]      [ch]C[/ch]',
    'one placeholder line',
    '[ch]G[/ch]',
    'another placeholder line',
  ].join('\n')
  const parsed = parseUltimateGuitar(page(body), URL)

  it('anchors each chord to the column it starts on, markers removed', () => {
    expect(sheetHasWords(parsed.sheet)).toBe(true)
    expect(parsed.sheet.blocks[0].lines).toEqual([
      { kind: 'label', text: 'Verse 1' },
      {
        kind: 'lyrics',
        text: 'one placeholder line',
        // `Am` occupies columns 0-1, then six spaces, so `C` lands on column 8.
        chords: [
          { name: 'Am', column: 0 },
          { name: 'C', column: 8 },
        ],
      },
      {
        kind: 'lyrics',
        text: 'another placeholder line',
        chords: [{ name: 'G', column: 0 }],
      },
    ])
  })

  it('has no tablature to engrave', () => {
    expect(parsed.score).toBeNull()
    expect(parsed.blocks).toHaveLength(0)
  })

  it('shows chord names without fingerings, which the body does not carry', () => {
    expect(parsed.sheet.shapes).toEqual({})
  })
})

describe('a page with no readable tab', () => {
  it('says so plainly when the tab is player-only', () => {
    expect(() => parseUltimateGuitar(page(''), URL)).toThrow(/Pro or official/)
  })

  it('says so when the page ships no data at all', () => {
    expect(() => parseUltimateGuitar('<html><body>nothing</body></html>', URL)).toThrow(
      /could not be read/,
    )
  })
})
