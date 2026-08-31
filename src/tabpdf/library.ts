import { sheetStats, type AsciiSource, type ChordSheet } from '../chords/types'
import type { ParsedScore, TabPagePrimitives } from './types'

/**
 * Storage for imported tabs.
 *
 * IndexedDB rather than local storage: a single fourteen-page score is a couple
 * of hundred kilobytes of notes, and the original PDF is kept alongside it so a
 * tab can be re-read later — for a different bar length, say — without asking
 * for the file again. That would exhaust the local-storage quota within a dozen
 * tabs.
 *
 * Metadata lives in its own store so listing the library never has to load
 * anybody's notes.
 */

const DB_NAME = 'noodlebox-tabs'
const DB_VERSION = 1
const META_STORE = 'meta'
const DATA_STORE = 'data'

/**
 * Where a tab came from, shown in the list so two imports of one song can be
 * told apart.
 *
 * `pdf` is a PDF that was picked, `url` came from a link, `tab` is the
 * primitives file the video reader writes, and `chords` is a chord sheet read
 * from a song page. The distinction is worth surfacing because it says how
 * much to trust what is on screen: a PDF was engraved, whereas a video was
 * recognised and may have gaps.
 */
export type TabSource = 'pdf' | 'url' | 'tab' | 'video' | 'chords'

/** What the library list needs to show a row. */
export interface LibraryEntry {
  id: string
  title: string
  artist: string | null
  bars: number
  noteCount: number
  pageCount: number
  fileName: string
  /** Epoch milliseconds, used only for ordering the list. */
  addedAt: number
  source: TabSource
  /** 1 unless another import already had this title and artist. */
  version: number
  /** Lyric lines, for a song imported from a chord site. */
  lyricLines?: number
  /** Chord names printed over the words, for a song from a chord site. */
  chordCount?: number
}

/**
 * What a tab was read from, kept so it can be read again — for a different bar
 * length, say — without asking for the source a second time.
 *
 * A PDF is stored as bytes because reading it is the expensive part. Primitives
 * arrive already decoded, so those are stored as they are.
 */
export type StoredSource = { pdf: Blob } | { primitives: TabPagePrimitives[] }

export interface StoredData {
  id: string
  /** Present whenever there is tablature, however it was read. */
  score?: ParsedScore
  /** Present when the song came from a chord site and has words. */
  sheet?: ChordSheet
  /** Present when the tab came from a PDF. */
  pdf?: Blob
  /** Present when the tab came from a primitives file. */
  primitives?: TabPagePrimitives[]
  /**
   * The plain-text staves a chord-site score was built from, kept so it can be
   * read again at a different bar length without fetching the page twice.
   */
  blocks?: AsciiSource[]
}

export class LibraryUnavailableError extends Error {}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
  })
}

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new LibraryUnavailableError('This browser has no IndexedDB.'))
  }
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION)
    open.onupgradeneeded = () => {
      const db = open.result
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(DATA_STORE)) {
        db.createObjectStore(DATA_STORE, { keyPath: 'id' })
      }
    }
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => reject(open.error ?? new LibraryUnavailableError('Could not open storage.'))
  })
}

async function withStores<T>(
  mode: IDBTransactionMode,
  run: (meta: IDBObjectStore, data: IDBObjectStore) => Promise<T> | T,
): Promise<T> {
  const db = await openDb()
  try {
    const tx = db.transaction([META_STORE, DATA_STORE], mode)
    // Listen before anything is awaited. A transaction commits once its last
    // request lands, and a `complete` handler attached after that event has
    // fired would never run — leaving this waiting forever on a store that has
    // already finished. Task ordering makes that unlikely rather than
    // impossible, and the cost of being wrong is a write that never returns, so
    // the handler goes on while the transaction is certain to still be open.
    const settled = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Storage transaction failed'))
    })
    const result = await run(tx.objectStore(META_STORE), tx.objectStore(DATA_STORE))
    await settled
    return result
  } finally {
    db.close()
  }
}

/** Every stored tab, newest first. */
export async function listTabs(): Promise<LibraryEntry[]> {
  const entries = await withStores('readonly', (meta) =>
    request(meta.getAll() as IDBRequest<LibraryEntry[]>),
  )
  // Rows stored before a tab recorded where it came from: everything importable
  // then was a picked PDF, and nothing had a second version.
  return entries
    .map((entry) => ({ ...entry, source: entry.source ?? 'pdf', version: entry.version ?? 1 }))
    .sort((a, b) => b.addedAt - a.addedAt)
}

export async function readTab(id: string): Promise<StoredData | null> {
  const stored = await withStores('readonly', (_meta, data) =>
    request(data.get(id) as IDBRequest<StoredData | undefined>),
  )
  return stored ?? null
}

/** What a tab will be called, which is also how duplicate songs are spotted. */
export function titleFor(score: ParsedScore, fileName: string): string {
  // A video-derived tab is filed as `<video title>.tab`, since a video has no
  // file name to take and its own title is the recognisable thing.
  return score.title ?? fileName.replace(/\.(pdf|json|tab)$/i, '')
}

export function entryFor(
  id: string,
  score: ParsedScore,
  fileName: string,
  addedAt: number,
  source: TabSource = 'pdf',
  version = 1,
): LibraryEntry {
  return {
    id,
    title: titleFor(score, fileName),
    artist: score.artist,
    bars: score.measures.length,
    noteCount: score.notes.length,
    pageCount: score.pageCount,
    fileName,
    addedAt,
    source,
    version,
  }
}

export async function saveTab(
  entry: LibraryEntry,
  score: ParsedScore,
  source: StoredSource,
): Promise<void> {
  await withStores('readwrite', (meta, data) => {
    meta.put(entry)
    data.put({ id: entry.id, score, ...source } satisfies StoredData)
  })
}

/** What a song from a chord site will be called, mirroring `titleFor`. */
export function sheetTitleFor(sheet: ChordSheet, fileName: string): string {
  return sheet.title ?? fileName.replace(/\.html?$/i, '')
}

/**
 * The list row for a song imported from a chord site.
 *
 * Such a song can have tablature, words, or both, so the row carries both
 * sizes: bars and notes come from whatever tab was engraved, and the lyric and
 * chord counts from the words above it.
 */
export function sheetEntryFor(
  id: string,
  sheet: ChordSheet,
  score: ParsedScore | null,
  fileName: string,
  addedAt: number,
  version = 1,
): LibraryEntry {
  const stats = sheetStats(sheet)
  return {
    id,
    title: sheetTitleFor(sheet, fileName),
    artist: sheet.artist,
    bars: score?.measures.length ?? 0,
    noteCount: score?.notes.length ?? 0,
    pageCount: 1,
    fileName,
    addedAt,
    source: 'chords',
    version,
    lyricLines: stats.lines,
    chordCount: stats.chords,
  }
}

/** Store a song read from a chord site: its words, its tab, and the tab's source. */
export async function saveSheet(
  entry: LibraryEntry,
  sheet: ChordSheet,
  score: ParsedScore | null,
  blocks: AsciiSource[],
): Promise<void> {
  await withStores('readwrite', (meta, data) => {
    meta.put(entry)
    data.put({
      id: entry.id,
      sheet,
      ...(score ? { score } : {}),
      ...(blocks.length > 0 ? { blocks } : {}),
    } satisfies StoredData)
  })
}

/** Replace a stored score in place, keeping its list entry current. */
export async function updateTab(entry: LibraryEntry, score: ParsedScore): Promise<void> {
  await withStores('readwrite', async (meta, data) => {
    const existing = await request(data.get(entry.id) as IDBRequest<StoredData | undefined>)
    if (!existing) return
    meta.put(entry)
    data.put({ ...existing, score })
  })
}

/**
 * Give a stored tab a different name.
 *
 * The name is written to the score as well as to the list entry: every later
 * write goes through `entryFor`, which takes the title from the score, so a name
 * kept only on the entry would be undone by the next tempo change.
 */
export async function renameTab(id: string, title: string): Promise<void> {
  await withStores('readwrite', async (meta, data) => {
    // Both reads are issued before either is awaited, so the transaction is
    // still open when they land.
    const [entry, stored] = await Promise.all([
      request(meta.get(id) as IDBRequest<LibraryEntry | undefined>),
      request(data.get(id) as IDBRequest<StoredData | undefined>),
    ])
    if (!entry || !stored) return
    meta.put({ ...entry, title })
    const renamed: StoredData = { ...stored }
    if (renamed.score) renamed.score = { ...renamed.score, title }
    if (renamed.sheet) renamed.sheet = { ...renamed.sheet, title }
    data.put(renamed)
  })
}

export async function deleteTab(id: string): Promise<void> {
  await withStores('readwrite', (meta, data) => {
    meta.delete(id)
    data.delete(id)
  })
}
