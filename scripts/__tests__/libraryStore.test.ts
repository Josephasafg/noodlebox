import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLibraryHandler } from '../libraryStore'

let dir: string
let server: Server
let base: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'noodlebox-library-'))
  const handler = createLibraryHandler(dir)
  server = createServer((req, res) => handler(req, res, () => {}))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve))
  rmSync(dir, { recursive: true, force: true })
})

const put = (id: string, body: unknown) =>
  fetch(`${base}/${id}`, { method: 'PUT', body: JSON.stringify(body) })

const song = (id: string) => ({
  entry: { id, title: 'Little Wing', addedAt: 1 },
  data: { id, sheet: { title: 'Little Wing' } },
})

describe('the library folder', () => {
  it('lists nothing before anything is stored', async () => {
    expect(await (await fetch(`${base}/`)).json()).toEqual([])
  })

  it('lists and reads back a stored song', async () => {
    expect((await put('abc-1', song('abc-1'))).status).toBe(204)

    expect(await (await fetch(`${base}/`)).json()).toEqual([song('abc-1').entry])
    expect(await (await fetch(`${base}/abc-1`)).json()).toEqual(song('abc-1').data)
  })

  it('answers 404 for a song that is not there', async () => {
    expect((await fetch(`${base}/missing`)).status).toBe(404)
  })

  it('refuses a body whose id disagrees with the path, and stores nothing', async () => {
    expect((await put('abc-1', song('other'))).status).toBe(400)
    expect(await (await fetch(`${base}/`)).json()).toEqual([])
  })

  it('refuses an id that could name a path outside the library', async () => {
    const response = await fetch(`${base}/..%2F..%2Fescaped`, { method: 'PUT', body: '{}' })
    expect(response.status).toBe(404)
    expect(existsSync(join(dir, '..', 'escaped.json'))).toBe(false)
  })

  it('forgets a deleted song entirely', async () => {
    await put('abc-1', song('abc-1'))
    expect((await fetch(`${base}/abc-1`, { method: 'DELETE' })).status).toBe(204)

    expect(await (await fetch(`${base}/`)).json()).toEqual([])
    expect((await fetch(`${base}/abc-1`)).status).toBe(404)
  })
})
