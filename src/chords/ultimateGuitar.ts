import { TabPdfError } from '../tabpdf/load'
import { isStaffLine, scoreFromAscii } from './ascii'
import { decodeEntities } from './html'
import type { AsciiSource, ChordPage, SheetBlock, SheetChord, SheetLine } from './types'

/**
 * Reading an Ultimate Guitar tab page.
 *
 * The page ships its own data: a `js-store` div carries the whole tab as JSON,
 * which is far steadier than scraping the rendered markup. Inside it the song
 * body is plain text with three markers — `[tab]` around a staff, `[ch]` around
 * a chord name, and a bracketed line such as `[Intro]` for a section — so the
 * body is classified a line at a time rather than by trusting the markers to
 * bracket only one kind of content.
 *
 * A `Tabs`-type page is usually all tablature and no words, so most of what
 * comes back is the score; a `Chords`-type page is the other way round. Both
 * come through here and whichever halves exist are returned.
 */

const STORE_RE = /<div class="js-store" data-content="([^"]*)"/
const CH_RE = /\[ch\]([\s\S]*?)\[\/ch\]/g
/** `[tab]` and `[/tab]` only delimit a staff; they are not part of the grid. */
const TAB_MARKER_RE = /\[\/?tab\]/g
/** A section heading on its own line, such as `[Intro]` or `[Verse 1]`. */
const LABEL_RE = /^\[([^\]]{1,40})\]$/
const STRINGS = 6

interface UgStore {
  song: string | null
  artist: string | null
  content: string
  tuning: string | null
}

function readStore(html: string): UgStore {
  const found = STORE_RE.exec(html)
  if (!found) {
    throw new TabPdfError(
      'That Ultimate Guitar page could not be read. Official and Pro tabs are player-only, ' +
        'so open a regular tab or chords version of the song.',
    )
  }
  let raw: unknown
  try {
    raw = JSON.parse(decodeEntities(found[1]))
  } catch {
    throw new TabPdfError('That Ultimate Guitar page carried data this app could not read.')
  }
  const page = (raw as { store?: { page?: { data?: Record<string, unknown> } } })?.store?.page?.data
  if (!page) throw new TabPdfError('That Ultimate Guitar page has no tab on it.')
  const tab = (page.tab ?? {}) as Record<string, unknown>
  const view = (page.tab_view ?? {}) as Record<string, unknown>
  const wiki = (view.wiki_tab ?? {}) as Record<string, unknown>
  const meta = (view.meta ?? {}) as Record<string, unknown>
  const tuning = (meta.tuning ?? null) as { value?: unknown } | null

  const content = typeof wiki.content === 'string' ? wiki.content : ''
  if (content.trim().length === 0) {
    throw new TabPdfError(
      'That Ultimate Guitar tab has no text version to read — it is a Pro or official tab, ' +
        'which only plays in their own player.',
    )
  }
  return {
    song: typeof tab.song_name === 'string' ? tab.song_name : null,
    artist: typeof tab.artist_name === 'string' ? tab.artist_name : null,
    content,
    tuning: tuning && typeof tuning.value === 'string' ? tuning.value : null,
  }
}

/** The chords in one line, each at the column its name starts on. */
function chordsFromLine(line: string): SheetChord[] {
  const chords: SheetChord[] = []
  let plain = ''
  let consumed = 0
  for (const match of line.matchAll(CH_RE)) {
    plain += line.slice(consumed, match.index)
    const name = match[1].trim()
    if (name.length > 0) chords.push({ name, column: plain.length })
    plain += name
    consumed = match.index + match[0].length
  }
  return chords
}

export function parseUltimateGuitar(html: string, sourceUrl: string): ChordPage {
  const store = readStore(html)
  const lines = store.content.replace(/\r/g, '').split('\n')

  const staves: AsciiSource[] = []
  const blocks: SheetBlock[] = []
  let run: string[] = []
  let sheetLines: SheetLine[] = []
  let pendingLabel: string | undefined
  /** Chords waiting for the words they sit over. */
  let openChords: SheetChord[] | null = null

  /** A staff is six lines; a run of twelve is two staves printed together. */
  const flushRun = () => {
    for (let i = 0; i + STRINGS <= run.length; i += STRINGS) {
      staves.push({
        strings: run.slice(i, i + STRINGS),
        marker: i === 0 ? pendingLabel : undefined,
      })
      if (i === 0) pendingLabel = undefined
    }
    run = []
  }

  const flushChords = () => {
    if (openChords) {
      sheetLines.push({ kind: 'chords', chords: openChords })
      openChords = null
    }
  }

  const flushBlock = () => {
    flushChords()
    if (sheetLines.length > 0) {
      blocks.push({ lines: sheetLines })
      sheetLines = []
    }
  }

  for (const original of lines) {
    const line = original.replace(TAB_MARKER_RE, '')
    const bare = line.trim()

    if (bare.length === 0) {
      flushRun()
      flushBlock()
      continue
    }

    const label = LABEL_RE.exec(bare)
    if (label && !bare.startsWith('[ch]')) {
      flushRun()
      flushBlock()
      pendingLabel = label[1]
      continue
    }

    if (isStaffLine(line)) {
      // Words never continue across a staff, so anything open is finished.
      flushBlock()
      run.push(line)
      continue
    }
    flushRun()

    if (line.includes('[ch]')) {
      flushChords()
      openChords = chordsFromLine(line)
      continue
    }

    // Plain text is only kept when it is the line a chord row sits over.
    // Everything else on the page is credits and notes to the reader.
    if (openChords) {
      if (pendingLabel) {
        sheetLines.push({ kind: 'label', text: pendingLabel })
        pendingLabel = undefined
      }
      sheetLines.push({ kind: 'lyrics', text: line.replace(/\s+$/, ''), chords: openChords })
      openChords = null
    }
  }
  flushRun()
  flushBlock()

  return {
    sheet: {
      title: store.song,
      artist: store.artist,
      sourceUrl,
      rtl: false,
      blocks,
      // Ultimate Guitar keeps its fingerings out of the tab body, so a chord
      // here is a name only.
      shapes: {},
    },
    score: scoreFromAscii(staves, {
      title: store.song,
      artist: store.artist,
      tuningNote: store.tuning,
    }),
    blocks: staves,
  }
}
