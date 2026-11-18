import { afterEach, describe, expect, it, vi } from 'vitest'
import { listOnDisk, readOnDisk, writeOnDisk } from '../diskLibrary'
import type { LibraryEntry } from '../library'

afterEach(() => {
  vi.unstubAllGlobals()
})

const entry = { id: 'abc-1', title: 'Bold as Love' } as LibraryEntry

/** Stands in for the dev server: whatever was PUT is what a GET returns. */
function storeInMemory() {
  const saved = new Map<string, string>()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        saved.set(url, JSON.stringify(JSON.parse(init.body as string).data))
        return new Response(null, { status: 204 })
      }
      const body = saved.get(url)
      return body ? new Response(body) : new Response(null, { status: 404 })
    }),
  )
}

describe('the library on disk', () => {
  it('brings a stored PDF back byte for byte', async () => {
    storeInMemory()
    const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => i % 256)
    await writeOnDisk(entry, { id: 'abc-1', pdf: new Blob([bytes], { type: 'application/pdf' }) })

    const stored = await readOnDisk('abc-1')

    expect(stored?.pdf?.type).toBe('application/pdf')
    expect(new Uint8Array(await stored!.pdf!.arrayBuffer())).toEqual(bytes)
  })

  it('reports a song that is not there as missing rather than failing', async () => {
    storeInMemory()
    expect(await readOnDisk('missing')).toBeNull()
  })

  it('fails loudly when the server cannot list the library', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })))
    await expect(listOnDisk()).rejects.toThrow('500')
  })
})
