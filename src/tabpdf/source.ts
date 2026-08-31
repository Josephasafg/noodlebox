import { TabPdfError } from './load'
import type { TabLineSeg, TabPagePrimitives, TabTextItem } from './types'

/**
 * Importing a tab from a link.
 *
 * Two kinds of link can be read in the browser: a PDF, which goes through the
 * same reader a picked file does, and the primitives JSON that
 * `scripts/tabvideo` writes, which is already in the shape the parser wants.
 *
 * A video link cannot be read here at all. Fetching one is blocked by the origin
 * policy, and recognising the notation in it needs a video decoder and OpenCV,
 * so it stays an offline step. Saying that plainly, with the command to run, is
 * more use than a generic failure.
 */

/** Same ceiling as a picked file: enough for a long score, not a whole album. */
const MAX_BYTES = 40 * 1024 * 1024

/** Guards against a hostile or truncated primitives file rather than a large score. */
const MAX_PAGES = 2000
const MAX_ITEMS_PER_PAGE = 20000
const MAX_TEXT_LENGTH = 64

const VIDEO_HOSTS = [
  'youtube.com',
  'youtu.be',
  'm.youtube.com',
  'music.youtube.com',
  'vimeo.com',
  'dailymotion.com',
]
const VIDEO_EXTENSIONS = /\.(mp4|mkv|webm|mov|avi|m4v|flv)$/i

/** Sites whose song pages are read as chords and plain-text tablature. */
const CHORD_HOSTS = ['tab4u.com', 'ultimate-guitar.com']

export type UrlKind = 'pdf' | 'primitives' | 'video' | 'chords' | 'unknown'

/** How to get the service that reads videos running, when it is not. */
export const START_SERVER_COMMAND = 'npm run dev'

/**
 * What a link points at, judged before anything is fetched.
 *
 * Only the shape of the URL is available at this point, so a link with no
 * extension is `unknown` and gets classified again from its content type once it
 * has been read.
 */
export function classifyUrl(raw: string): UrlKind {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return 'unknown'
  }
  const host = url.hostname.replace(/^www\./, '').toLowerCase()
  // Song pages sit on a subdomain as often as not — tabs.ultimate-guitar.com.
  if (CHORD_HOSTS.some((site) => host === site || host.endsWith(`.${site}`))) return 'chords'
  if (VIDEO_HOSTS.includes(host) || VIDEO_EXTENSIONS.test(url.pathname)) return 'video'
  if (/\.pdf$/i.test(url.pathname)) return 'pdf'
  if (/\.json$/i.test(url.pathname)) return 'primitives'
  return 'unknown'
}

/** Reject anything that is not a plain web link before it reaches `fetch`. */
function requireHttpUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new TabPdfError('That does not look like a link. Paste a full https:// address.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TabPdfError('Only https links can be imported.')
  }
  return url
}

function videoRefusal(): never {
  throw new TabPdfError(
    'A video has to be read by the extraction service, which is not reachable. ' +
      `Start it with \`${START_SERVER_COMMAND}\` and try the link again.`,
  )
}

function number(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TabPdfError(`That primitives file is not valid: ${field} is not a number.`)
  }
  return value
}

function segmentFrom(value: unknown, where: string): TabLineSeg {
  if (typeof value !== 'object' || value === null) {
    throw new TabPdfError(`That primitives file is not valid: ${where} is not a segment.`)
  }
  const raw = value as Record<string, unknown>
  return {
    x0: number(raw.x0, `${where}.x0`),
    y0: number(raw.y0, `${where}.y0`),
    x1: number(raw.x1, `${where}.x1`),
    y1: number(raw.y1, `${where}.y1`),
  }
}

function textFrom(value: unknown, where: string): TabTextItem {
  if (typeof value !== 'object' || value === null) {
    throw new TabPdfError(`That primitives file is not valid: ${where} is not a text item.`)
  }
  const raw = value as Record<string, unknown>
  if (typeof raw.str !== 'string') {
    throw new TabPdfError(`That primitives file is not valid: ${where}.str is not text.`)
  }
  return {
    // A pathologically long run would only ever fail to parse as a fret number,
    // so it is cut rather than rejected.
    str: raw.str.slice(0, MAX_TEXT_LENGTH),
    x: number(raw.x, `${where}.x`),
    y: number(raw.y, `${where}.y`),
    fontSize: number(raw.fontSize, `${where}.fontSize`),
    width: number(raw.width, `${where}.width`),
  }
}

/**
 * Validate primitives that came from outside the app.
 *
 * The parser trusts its input to be numbers, so everything is checked here
 * instead: a missing field or a NaN would otherwise surface much later as a note
 * on string `NaN`. Rebuilding each object also drops any extra keys that came
 * along with the file.
 */
export function parsePrimitives(text: string): TabPagePrimitives[] {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new TabPdfError('That file is not valid JSON.')
  }
  return pagesFrom(raw)
}

/**
 * The same validation for primitives that arrived already decoded.
 *
 * The extraction service answers in JSON, so its pages have been parsed by the
 * time they get here. They are no more trustworthy for it — a service on a port
 * is not necessarily the one expected — so they go through exactly these checks
 * rather than a laxer copy of them.
 */
export function pagesFrom(raw: unknown): TabPagePrimitives[] {
  if (!Array.isArray(raw)) {
    throw new TabPdfError('A primitives file should be a list of pages.')
  }
  if (raw.length === 0) {
    throw new TabPdfError('That primitives file has no pages in it.')
  }
  if (raw.length > MAX_PAGES) {
    throw new TabPdfError(`That primitives file has more than ${MAX_PAGES} pages.`)
  }

  return raw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new TabPdfError(`That primitives file is not valid: page ${index} is not an object.`)
    }
    const page = entry as Record<string, unknown>
    const segments = page.segments
    const texts = page.texts
    if (!Array.isArray(segments) || !Array.isArray(texts)) {
      throw new TabPdfError(`That primitives file is not valid: page ${index} has no geometry.`)
    }
    if (segments.length > MAX_ITEMS_PER_PAGE || texts.length > MAX_ITEMS_PER_PAGE) {
      throw new TabPdfError(`Page ${index} of that primitives file has too many items.`)
    }
    const width = number(page.width, `page ${index} width`)
    const height = number(page.height, `page ${index} height`)
    if (width <= 0 || height <= 0) {
      throw new TabPdfError(`That primitives file is not valid: page ${index} has no size.`)
    }
    return {
      // A missing index is recoverable — position in the list is the same thing.
      pageIndex: typeof page.pageIndex === 'number' ? page.pageIndex : index,
      width,
      height,
      segments: segments.map((segment, i) => segmentFrom(segment, `page ${index} segment ${i}`)),
      texts: texts.map((item, i) => textFrom(item, `page ${index} text ${i}`)),
    }
  })
}

/** The name a link should be filed under in the library. */
export function fileNameFor(url: URL): string {
  const last = url.pathname.split('/').filter(Boolean).pop()
  return last && last.length > 0 ? decodeURIComponent(last) : url.hostname
}

async function readBody(response: Response, url: URL): Promise<Blob> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    throw new TabPdfError('That file is over 40 MB, which is too large to read in the browser.')
  }
  const blob = await response.blob()
  if (blob.size > MAX_BYTES) {
    throw new TabPdfError('That file is over 40 MB, which is too large to read in the browser.')
  }
  if (blob.size === 0) {
    throw new TabPdfError(`Nothing came back from ${url.hostname}.`)
  }
  return blob
}

export interface FetchedSource {
  kind: 'pdf' | 'primitives'
  fileName: string
  /** Set for a PDF, so the reader and the library both get the bytes. */
  file?: File
  /** Set for primitives, already validated. */
  pages?: TabPagePrimitives[]
}

/**
 * Fetch a link and work out what came back.
 *
 * The content type is trusted over the extension, because a link that serves a
 * PDF from a path with no `.pdf` on it is common and worth accepting.
 */
export async function fetchSource(raw: string): Promise<FetchedSource> {
  if (classifyUrl(raw) === 'video') videoRefusal()
  const url = requireHttpUrl(raw)

  let response: Response
  try {
    response = await fetch(url, { redirect: 'follow' })
  } catch {
    // A cross-origin fetch that the other server does not allow fails here with
    // nothing useful attached, and it is by far the likeliest reason.
    throw new TabPdfError(
      `${url.hostname} could not be read from the browser. It may not allow other sites to ` +
        'fetch from it, in which case download the file and pick it instead.',
    )
  }
  if (!response.ok) {
    throw new TabPdfError(`${url.hostname} answered ${response.status} for that link.`)
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  const fileName = fileNameFor(url)
  if (contentType.includes('pdf') || classifyUrl(raw) === 'pdf') {
    const blob = await readBody(response, url)
    return { kind: 'pdf', fileName, file: new File([blob], fileName, { type: 'application/pdf' }) }
  }
  if (contentType.includes('json') || classifyUrl(raw) === 'primitives') {
    const blob = await readBody(response, url)
    return { kind: 'primitives', fileName, pages: parsePrimitives(await blob.text()) }
  }
  if (contentType.startsWith('video/')) videoRefusal()
  throw new TabPdfError(
    `That link is ${contentType || 'of an unknown type'}. Import a PDF, or the ` +
      'primitives.json written by the tab video reader.',
  )
}
