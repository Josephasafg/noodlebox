import { afterEach, describe, expect, it, vi } from 'vitest'
import { TabPdfError } from '../load'
import {
  START_SERVER_COMMAND,
  classifyUrl,
  fetchSource,
  fileNameFor,
  parsePrimitives,
} from '../source'
import type { TabPagePrimitives } from '../types'

function page(over: Partial<TabPagePrimitives> = {}): TabPagePrimitives {
  return {
    pageIndex: 0,
    width: 800,
    height: 300,
    segments: [{ x0: 10, y0: 20, x1: 700, y1: 20 }],
    texts: [{ str: '7', x: 100, y: 155, fontSize: 10, width: 6 }],
    ...over,
  }
}

/** Stand in for a server answering one request. */
function respond(body: string | Blob, headers: Record<string, string>, ok = true) {
  const blob = typeof body === 'string' ? new Blob([body]) : body
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 404,
    headers: new Headers(headers),
    blob: () => Promise.resolve(blob),
  } as unknown as Response)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('classifying a link', () => {
  it('recognises the video hosts a tab is usually shown on', () => {
    expect(classifyUrl('https://www.youtube.com/watch?v=abc')).toBe('video')
    expect(classifyUrl('https://youtu.be/abc')).toBe('video')
    expect(classifyUrl('https://music.youtube.com/watch?v=abc')).toBe('video')
    expect(classifyUrl('https://vimeo.com/12345')).toBe('video')
  })

  it('recognises a video by its extension wherever it is hosted', () => {
    expect(classifyUrl('https://example.com/lesson.mp4')).toBe('video')
    expect(classifyUrl('https://example.com/a/b/clip.MKV')).toBe('video')
  })

  it('recognises the two kinds it can actually read', () => {
    expect(classifyUrl('https://example.com/tab.pdf')).toBe('pdf')
    expect(classifyUrl('https://example.com/out/primitives.json')).toBe('primitives')
  })

  it('recognises a chord site song page by its host', () => {
    expect(classifyUrl('https://www.tab4u.com/tabs/songs/66169_song.html')).toBe('chords')
    expect(classifyUrl('https://tab4u.com/tabs/songs/66169_song.html')).toBe('chords')
  })

  it('recognises a song page on a subdomain of a chord site', () => {
    // Ultimate Guitar serves its song pages from `tabs.`, not the bare domain.
    expect(classifyUrl('https://tabs.ultimate-guitar.com/tab/a/b-tabs-1')).toBe('chords')
    expect(classifyUrl('https://www.ultimate-guitar.com/tab/a/b-tabs-1')).toBe('chords')
  })

  it('leaves anything else to be judged by its content type', () => {
    expect(classifyUrl('https://example.com/download?id=9')).toBe('unknown')
    expect(classifyUrl('not a link at all')).toBe('unknown')
  })
})

describe('reading primitives that came from outside the app', () => {
  it('accepts a well formed file', () => {
    const pages = parsePrimitives(JSON.stringify([page(), page({ pageIndex: 1 })]))
    expect(pages).toHaveLength(2)
    expect(pages[1].pageIndex).toBe(1)
    expect(pages[0].texts[0].str).toBe('7')
  })

  it('numbers pages by position when the file does not', () => {
    const [first, second] = parsePrimitives(
      JSON.stringify([{ ...page(), pageIndex: undefined }, { ...page(), pageIndex: undefined }]),
    )
    expect([first.pageIndex, second.pageIndex]).toEqual([0, 1])
  })

  it('drops keys it was not expecting', () => {
    const [only] = parsePrimitives(JSON.stringify([{ ...page(), extra: 'ignored' }]))
    expect(only).not.toHaveProperty('extra')
  })

  it('rejects anything that is not a list of pages', () => {
    expect(() => parsePrimitives('not json')).toThrow(TabPdfError)
    expect(() => parsePrimitives('{}')).toThrow(/list of pages/)
    expect(() => parsePrimitives('[]')).toThrow(/no pages/)
    expect(() => parsePrimitives('[null]')).toThrow(/not an object/)
  })

  it('rejects a page with no usable geometry', () => {
    expect(() => parsePrimitives(JSON.stringify([{ width: 8, height: 3 }]))).toThrow(/no geometry/)
    expect(() => parsePrimitives(JSON.stringify([page({ width: 0 })]))).toThrow(/no size/)
  })

  /**
   * The parser takes its input to be numbers, so a NaN here would surface much
   * later as a note on string NaN rather than as a bad file.
   */
  it('rejects numbers that are not finite', () => {
    const withNaN = JSON.stringify([page()]).replace('"width":800', '"width":null')
    expect(() => parsePrimitives(withNaN)).toThrow(/not a number/)

    const badSegment = [page({ segments: [{ x0: 1, y0: 2, x1: 3 } as never] })]
    expect(() => parsePrimitives(JSON.stringify(badSegment))).toThrow(/x1|not a number/)
  })

  it('rejects a text item whose content is not text', () => {
    const pages = [page({ texts: [{ str: 7, x: 1, y: 2, fontSize: 3, width: 4 } as never] })]
    expect(() => parsePrimitives(JSON.stringify(pages))).toThrow(/not text/)
  })

  it('cuts an implausibly long run rather than refusing the file', () => {
    const pages = [page({ texts: [{ str: 'x'.repeat(500), x: 1, y: 2, fontSize: 3, width: 4 }] })]
    expect(parsePrimitives(JSON.stringify(pages))[0].texts[0].str.length).toBe(64)
  })

  it('refuses a file with an implausible number of pages', () => {
    const many = JSON.stringify(Array.from({ length: 2001 }, () => page()))
    expect(() => parsePrimitives(many)).toThrow(/more than/)
  })
})

describe('fetching a link', () => {
  /**
   * A video reaching here means the extraction service was not used, since the
   * import path sends video links straight to it. The message therefore has to
   * point at the service rather than at the browser's own limits.
   */
  it('refuses a video without going to the network, and says how to get it read', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchSource('https://www.youtube.com/watch?v=abc')).rejects.toThrow(
      /extraction service/,
    )
    await expect(fetchSource('https://www.youtube.com/watch?v=abc')).rejects.toThrow(
      START_SERVER_COMMAND,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a link that is not plain web traffic', async () => {
    await expect(fetchSource('file:///etc/passwd')).rejects.toThrow(/Only https/)
    await expect(fetchSource('javascript:alert(1)')).rejects.toThrow(/Only https/)
  })

  it('reads primitives from a link', async () => {
    vi.stubGlobal('fetch', respond(JSON.stringify([page()]), { 'content-type': 'application/json' }))
    const source = await fetchSource('https://example.com/out/primitives.json')
    expect(source.kind).toBe('primitives')
    expect(source.pages).toHaveLength(1)
    expect(source.fileName).toBe('primitives.json')
  })

  it('trusts the content type over a path with no extension', async () => {
    vi.stubGlobal('fetch', respond('%PDF-1.4', { 'content-type': 'application/pdf' }))
    const source = await fetchSource('https://example.com/download?id=9')
    expect(source.kind).toBe('pdf')
    expect(source.file).toBeInstanceOf(File)
  })

  it('explains a cross-origin refusal in terms of what to do next', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(fetchSource('https://example.com/tab.pdf')).rejects.toThrow(/download the file/)
  })

  it('reports the status when the server says no', async () => {
    vi.stubGlobal('fetch', respond('', { 'content-type': 'application/pdf' }, false))
    await expect(fetchSource('https://example.com/tab.pdf')).rejects.toThrow(/answered 404/)
  })

  it('refuses an empty body rather than parsing nothing', async () => {
    vi.stubGlobal('fetch', respond('', { 'content-type': 'application/json' }))
    await expect(fetchSource('https://example.com/p.json')).rejects.toThrow(/Nothing came back/)
  })

  it('refuses a file larger than it will read, on the declared length alone', async () => {
    vi.stubGlobal(
      'fetch',
      respond('short', { 'content-type': 'application/pdf', 'content-length': String(50e6) }),
    )
    await expect(fetchSource('https://example.com/tab.pdf')).rejects.toThrow(/over 40 MB/)
  })

  it('says what an unreadable type was', async () => {
    vi.stubGlobal('fetch', respond('hello', { 'content-type': 'text/html' }))
    await expect(fetchSource('https://example.com/page')).rejects.toThrow(/text\/html/)
  })

  it('refuses a video that only announces itself by content type', async () => {
    vi.stubGlobal('fetch', respond('binary', { 'content-type': 'video/mp4' }))
    await expect(fetchSource('https://example.com/stream')).rejects.toThrow(/extraction service/)
  })
})

describe('naming what a link points at', () => {
  it('uses the last path segment', () => {
    expect(fileNameFor(new URL('https://example.com/tabs/bold.pdf'))).toBe('bold.pdf')
    expect(fileNameFor(new URL('https://example.com/a/b%20c.json'))).toBe('b c.json')
  })

  it('falls back to the host when there is no path', () => {
    expect(fileNameFor(new URL('https://example.com/'))).toBe('example.com')
  })
})
