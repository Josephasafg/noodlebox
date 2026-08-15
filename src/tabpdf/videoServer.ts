import { TabPdfError } from './load'
import { pagesFrom } from './source'
import type { TabPagePrimitives } from './types'

/**
 * Talking to the local service that reads tab videos.
 *
 * Recognising notation in a video needs a video decoder and OpenCV, so it cannot
 * happen in a browser. `scripts/tabvideo/server.py` runs beside the dev server and
 * Vite proxies `/api` to it, which is what makes pasting a video link work without
 * anyone opening a terminal.
 *
 * A job stops at `naming` for shapes nobody has confirmed before. That is not a
 * gap waiting to be filled by a cleverer classifier: matching fret digits against
 * system fonts measured 38% on real video pixels and Tesseract 7-24%, because the
 * digits are around ten pixels tall and OCR needs about fourteen. Names confirmed
 * once are remembered, so the cost falls on the first video in a font and not the
 * rest.
 */

/** The dev server proxies this; an explicit host lets the built app reach one. */
const BASE = import.meta.env.VITE_TAB_SERVER || '/api'

/** Health has to answer fast or it is not there; reading a video does not. */
const PROBE_TIMEOUT_MS = 2500
const REQUEST_TIMEOUT_MS = 30_000

/** Bounds on an answer, so a wrong service on the port cannot exhaust memory. */
const MAX_SHAPES = 2000
const MAX_PNG_LENGTH = 512 * 1024

export type VideoJobState =
  | 'queued'
  | 'downloading'
  | 'reading'
  | 'naming'
  | 'emitting'
  | 'done'
  | 'error'

export interface VideoShape {
  index: number
  /** How many marks in the video have this shape; the list is commonest first. */
  count: number
  /** Base64 PNG of the shape as it appears, magnified. */
  png: string
  /** What it is called, when that is already known. */
  label: string | null
  /** True when the name came from a previous video rather than this one. */
  remembered: boolean
}

export interface VideoJob {
  id: string
  state: VideoJobState
  stage: string
  /** 0..1 while downloading, null when there is nothing meaningful to show. */
  progress: number | null
  title: string
  error: string | null
  systems: number | null
  staves: number | null
  shapeCount: number | null
  rememberedCount: number | null
  unresolvedCount: number | null
  shapes: VideoShape[] | null
  pages: TabPagePrimitives[] | null
  unreadCount: number | null
}

const STATES: readonly VideoJobState[] = [
  'queued',
  'downloading',
  'reading',
  'naming',
  'emitting',
  'done',
  'error',
]

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new TabPdfError('The extraction service sent something unexpected.')
  }
  return value as Record<string, unknown>
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Only base64 is allowed through, because the string is used as an image source.
 * A malformed one would fail to render anyway; rejecting it keeps anything
 * surprising out of the DOM in the first place.
 */
function pngFrom(value: unknown): string {
  const raw = text(value)
  if (raw.length === 0 || raw.length > MAX_PNG_LENGTH) return ''
  return /^[A-Za-z0-9+/=]+$/.test(raw) ? raw : ''
}

function shapesFrom(value: unknown): VideoShape[] | null {
  if (!Array.isArray(value)) return null
  return value.slice(0, MAX_SHAPES).map((entry, position) => {
    const raw = record(entry)
    return {
      index: count(raw.index) ?? position,
      count: count(raw.count) ?? 0,
      png: pngFrom(raw.png),
      label: typeof raw.label === 'string' ? raw.label : null,
      remembered: raw.remembered === true,
    }
  })
}

function jobFrom(value: unknown): VideoJob {
  const raw = record(value)
  const state = text(raw.state)
  return {
    id: text(raw.id),
    state: (STATES as readonly string[]).includes(state) ? (state as VideoJobState) : 'error',
    stage: text(raw.stage, 'working'),
    progress: count(raw.progress),
    title: text(raw.title),
    error: typeof raw.error === 'string' ? raw.error : null,
    systems: count(raw.systems),
    staves: count(raw.staves),
    shapeCount: count(raw.shapeCount),
    rememberedCount: count(raw.rememberedCount),
    unresolvedCount: count(raw.unresolvedCount),
    shapes: shapesFrom(raw.shapes),
    // Primitives get exactly the checks a file picked off disk gets. The parser
    // trusts its input to be numbers, so this is the only place that can enforce it.
    pages: raw.primitives === undefined ? null : pagesFrom(raw.primitives),
    unreadCount: count(raw.unreadCount),
  }
}

async function call(
  path: string,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  let response: Response
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      signal: abort.signal,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    })
  } catch {
    throw new TabPdfError(
      'The extraction service could not be reached. Start it with `npm run dev` and try again.',
    )
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    // The service explains its own refusals — an over-long video, a private
    // link — and those messages are more use than the status code.
    let detail: string
    try {
      detail = text(record(await response.json()).detail)
    } catch {
      detail = ''
    }
    throw new TabPdfError(detail || `The extraction service answered ${response.status}.`)
  }
  return response.json()
}

/** Whether reading a video is possible at all right now. */
export async function serverAvailable(): Promise<boolean> {
  try {
    const answer = await call('/health', { method: 'GET' }, PROBE_TIMEOUT_MS)
    return record(answer).ok === true
  } catch {
    return false
  }
}

export async function startVideoExtraction(url: string): Promise<string> {
  const answer = record(await call('/extract', { method: 'POST', body: JSON.stringify({ url }) }))
  const id = text(answer.id)
  if (!id) throw new TabPdfError('The extraction service did not start a job.')
  return id
}

export async function readVideoJob(id: string): Promise<VideoJob> {
  return jobFrom(await call(`/extract/${encodeURIComponent(id)}`, { method: 'GET' }))
}

/** Hand over the names for the shapes, which builds the score. */
export async function nameVideoShapes(
  id: string,
  labels: Record<string, string>,
): Promise<VideoJob> {
  return jobFrom(
    await call(`/extract/${encodeURIComponent(id)}/labels`, {
      method: 'POST',
      body: JSON.stringify({ labels }),
    }),
  )
}

export async function discardVideoJob(id: string): Promise<void> {
  try {
    await call(`/extract/${encodeURIComponent(id)}`, { method: 'DELETE' })
  } catch {
    // Abandoning a job is housekeeping; the service ages them out by itself.
  }
}
