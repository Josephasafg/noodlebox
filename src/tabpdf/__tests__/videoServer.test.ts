import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  nameVideoShapes,
  readVideoJob,
  serverHealth,
  startVideoExtraction,
} from '../videoServer'
import type { TabPagePrimitives } from '../types'

/**
 * The extraction service is a separate process on a port, so its answers get the
 * same treatment as a file picked off disk: checked before the parser sees them.
 * Nothing here talks to a real service.
 */

function respond(body: unknown, init: { status?: number } = {}) {
  return vi.fn().mockResolvedValue({
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    json: async () => body,
  })
}

const page = (): TabPagePrimitives => ({
  pageIndex: 0,
  width: 100,
  height: 50,
  segments: [{ x0: 1, y0: 2, x1: 3, y1: 2 }],
  texts: [{ str: '7', x: 5, y: 6, fontSize: 8, width: 4 }],
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('finding the service', () => {
  it('reports it is there when health answers', async () => {
    vi.stubGlobal('fetch', respond({ ok: true }))
    expect(await serverHealth()).toEqual({ namesShapes: false, model: '' })
  })

  it('reports it is absent rather than throwing when nothing answers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('refused')))
    expect(await serverHealth()).toBeNull()
  })

  it('reports it is absent when something else is on the port', async () => {
    vi.stubGlobal('fetch', respond({ hello: 'not the tab reader' }))
    expect(await serverHealth()).toBeNull()
  })

  it('says when a model will name the printed shapes', async () => {
    // What the library promises before an import depends on this: a tab
    // straight away, or a screen of shapes to name.
    vi.stubGlobal(
      'fetch',
      respond({ ok: true, vision: { configured: true, ready: true, model: 'qwen-vl' } }),
    )
    expect(await serverHealth()).toEqual({ namesShapes: true, model: 'qwen-vl' })
  })

  it('does not promise automatic naming for an endpoint that cannot be used', async () => {
    // Configured but broken must read as manual, since manual is what happens.
    vi.stubGlobal(
      'fetch',
      respond({ ok: true, vision: { configured: true, ready: false, problem: 'no openai' } }),
    )
    expect(await serverHealth()).toEqual({ namesShapes: false, model: '' })
  })
})

describe('starting an extraction', () => {
  it('hands back the job id', async () => {
    vi.stubGlobal('fetch', respond({ id: 'abc123', state: 'queued' }))
    expect(await startVideoExtraction('https://example.com/watch?v=a')).toBe('abc123')
  })

  it('passes on the reason a link was refused', async () => {
    // The service knows why — too long, points at a private address — and that is
    // more use to read than a status code.
    vi.stubGlobal('fetch', respond({ detail: 'That video is 91 minutes long' }, { status: 400 }))
    await expect(startVideoExtraction('https://example.com/long')).rejects.toThrow(/91 minutes/)
  })

  it('explains an unreachable service instead of failing obscurely', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(startVideoExtraction('https://example.com/a')).rejects.toThrow(/could not be reached/)
  })
})

describe('reading a job', () => {
  it('carries through what the app shows while it works', async () => {
    vi.stubGlobal(
      'fetch',
      respond({
        id: 'j1',
        state: 'downloading',
        stage: 'fetching the video',
        progress: 0.4,
        title: 'A Lesson',
        systems: null,
      }),
    )
    const job = await readVideoJob('j1')
    expect(job.state).toBe('downloading')
    expect(job.stage).toBe('fetching the video')
    expect(job.progress).toBe(0.4)
    expect(job.title).toBe('A Lesson')
  })

  it('carries through the counts that say how the reading went', async () => {
    // Both are things a reader cannot hear from the notes alone: articulation
    // that was found and dropped, and a number the service decided was really
    // two. Losing either on the way to the app makes it invisible again.
    vi.stubGlobal(
      'fetch',
      respond({
        id: 'j1',
        state: 'done',
        unreadCount: 3,
        silentTechniqueCount: 73,
        splitRunCount: 5,
      }),
    )
    const job = await readVideoJob('j1')
    expect(job.unreadCount).toBe(3)
    expect(job.silentTechniqueCount).toBe(73)
    expect(job.splitRunCount).toBe(5)
  })

  it('treats a state it does not know as an error rather than passing it on', async () => {
    vi.stubGlobal('fetch', respond({ id: 'j1', state: 'transcending', stage: '' }))
    expect((await readVideoJob('j1')).state).toBe('error')
  })

  it('validates primitives with the same checks a picked file gets', async () => {
    vi.stubGlobal(
      'fetch',
      respond({
        id: 'j1',
        state: 'done',
        primitives: [{ pageIndex: 0, width: 10, height: 5, segments: [], texts: [] }],
      }),
    )
    const job = await readVideoJob('j1')
    expect(job.pages).toHaveLength(1)
  })

  it('refuses primitives with a value the parser would read as a note on NaN', async () => {
    vi.stubGlobal(
      'fetch',
      respond({
        id: 'j1',
        state: 'done',
        primitives: [
          {
            pageIndex: 0,
            width: 10,
            height: 5,
            segments: [],
            texts: [{ str: '7', x: 'over there', y: 1, fontSize: 2, width: 3 }],
          },
        ],
      }),
    )
    await expect(readVideoJob('j1')).rejects.toThrow(/not a number/)
  })

  it('keeps a shape list in the order it was given, commonest first', async () => {
    vi.stubGlobal(
      'fetch',
      respond({
        id: 'j1',
        state: 'naming',
        shapes: [
          { index: 0, count: 50, png: 'aGVsbG8=', label: '7', remembered: true },
          { index: 1, count: 3, png: 'aGVsbG8=', label: null, remembered: false },
        ],
      }),
    )
    const job = await readVideoJob('j1')
    expect(job.shapes?.map((shape) => shape.count)).toEqual([50, 3])
    expect(job.shapes?.[0].remembered).toBe(true)
    expect(job.shapes?.[1].label).toBeNull()
  })

  it('drops a shape picture that is not base64, since it becomes an image source', async () => {
    vi.stubGlobal(
      'fetch',
      respond({
        id: 'j1',
        state: 'naming',
        shapes: [{ index: 0, count: 1, png: '"><script>bad()</script>', label: null }],
      }),
    )
    expect((await readVideoJob('j1')).shapes?.[0].png).toBe('')
  })
})

describe('naming the shapes', () => {
  it('sends the names and returns the finished job', async () => {
    const fetchMock = respond({
      id: 'j1',
      state: 'done',
      unreadCount: 2,
      primitives: [page()],
    })
    vi.stubGlobal('fetch', fetchMock)

    const job = await nameVideoShapes('j1', { '0': '7', '1': '' })
    expect(job.state).toBe('done')
    expect(job.unreadCount).toBe(2)
    expect(job.pages?.[0].texts[0].str).toBe('7')

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body as string)).toEqual({ labels: { '0': '7', '1': '' } })
  })
})
