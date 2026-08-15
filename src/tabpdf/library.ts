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
 * `pdf` is a PDF that was picked, `url` came from a link, and `tab` is the
 * primitives file the video reader writes. The distinction is worth surfacing
 * because it says how much to trust what is on screen: a PDF was engraved,
 * whereas a video was recognised and may have gaps.
 */
export type TabSource = 'pdf' | 'url' | 'tab' | 'video'

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
  score: ParsedScore
  /** Present when the tab came from a PDF. */
  pdf?: Blob
  /** Present when the tab came from a primitives file. */
  primitives?: TabPagePrimitives[]
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
    const result = await run(tx.objectStore(META_STORE), tx.objectStore(DATA_STORE))
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Storage transaction failed'))
    })
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

/** Replace a stored score in place, keeping its list entry current. */
export async function updateTab(entry: LibraryEntry, score: ParsedScore): Promise<void> {
  await withStores('readwrite', async (meta, data) => {
    const existing = await request(data.get(entry.id) as IDBRequest<StoredData | undefined>)
    if (!existing) return
    meta.put(entry)
    data.put({ ...existing, score })
  })
}

export async function deleteTab(id: string): Promise<void> {
  await withStores('readwrite', (meta, data) => {
    meta.delete(id)
    data.delete(id)
  })
}
