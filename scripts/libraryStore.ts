import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Connect, Plugin } from 'vite'

/**
 * The song library, kept in a folder by the dev server.
 *
 * Browser storage belongs to one origin, port included, so a library kept there
 * vanishes whenever the app is served from a different port. A folder on disk is
 * the same library whichever port serves the app. It lives outside the repo
 * because the songs are copyrighted material.
 *
 * Metadata and notes are separate files so listing the library never reads
 * anybody's notes.
 */

export const LIBRARY_ROUTE = '/library'
export const DEFAULT_LIBRARY_DIR = join(homedir(), '.noodlebox', 'library')

/** Ids are UUIDs; anything else could name a path outside the library. */
const ID = /^[A-Za-z0-9-]{1,128}$/
/** A stored PDF travels as base64, so this allows for a PDF of about 45 MB. */
const MAX_BODY_BYTES = 64 * 1024 * 1024

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Song is too large to store.')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'Body is not JSON.')
  }
}

function hasId(value: unknown, id: string): boolean {
  return typeof value === 'object' && value !== null && (value as { id?: unknown }).id === id
}

function isMissing(problem: unknown): boolean {
  return (problem as NodeJS.ErrnoException).code === 'ENOENT'
}

/** Write beside the target and rename over it, so a crash never leaves half a song. */
async function writeAtomically(path: string, text: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, text)
  await rename(temporary, path)
}

function send(res: ServerResponse, status: number, body?: string) {
  res.statusCode = status
  if (body === undefined) {
    res.end()
    return
  }
  res.setHeader('Content-Type', 'application/json')
  res.end(body)
}

export function createLibraryHandler(dir: string): Connect.NextHandleFunction {
  const metaDir = join(dir, 'meta')
  const dataDir = join(dir, 'data')

  async function list(res: ServerResponse) {
    let names: string[]
    try {
      names = await readdir(metaDir)
    } catch (problem) {
      if (!isMissing(problem)) throw problem
      names = []
    }
    const entries = await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map(async (name) => JSON.parse(await readFile(join(metaDir, name), 'utf8')) as unknown),
    )
    send(res, 200, JSON.stringify(entries))
  }

  async function read(res: ServerResponse, id: string) {
    try {
      send(res, 200, await readFile(join(dataDir, `${id}.json`), 'utf8'))
    } catch (problem) {
      if (!isMissing(problem)) throw problem
      send(res, 404, JSON.stringify({ error: 'No such song.' }))
    }
  }

  async function write(req: IncomingMessage, res: ServerResponse, id: string) {
    const body = await readBody(req)
    const { entry, data } = (body ?? {}) as { entry?: unknown; data?: unknown }
    if (!hasId(entry, id) || !hasId(data, id)) {
      throw new HttpError(400, 'Entry and data must both carry the id in the path.')
    }
    await mkdir(metaDir, { recursive: true })
    await mkdir(dataDir, { recursive: true })
    // Notes first: the list only shows songs whose metadata exists, so it never
    // offers one that cannot be opened.
    await writeAtomically(join(dataDir, `${id}.json`), JSON.stringify(data))
    await writeAtomically(join(metaDir, `${id}.json`), JSON.stringify(entry))
    send(res, 204)
  }

  async function remove(res: ServerResponse, id: string) {
    await rm(join(metaDir, `${id}.json`), { force: true })
    await rm(join(dataDir, `${id}.json`), { force: true })
    send(res, 204)
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path === '/' && req.method === 'GET') return list(res)

    const id = decodeURIComponent(path.slice(1))
    if (!ID.test(id)) throw new HttpError(404, 'No such song.')
    if (req.method === 'GET') return read(res, id)
    if (req.method === 'PUT') return write(req, res, id)
    if (req.method === 'DELETE') return remove(res, id)
    throw new HttpError(405, 'Method not allowed.')
  }

  return (req, res) => {
    route(req, res).catch((problem: unknown) => {
      if (problem instanceof HttpError) {
        send(res, problem.status, JSON.stringify({ error: problem.message }))
        return
      }
      console.error('[library]', req.method, req.url, problem)
      send(res, 500, JSON.stringify({ error: 'The library could not be read or written.' }))
    })
  }
}

export function libraryStore(dir: string = DEFAULT_LIBRARY_DIR): Plugin {
  return {
    name: 'noodlebox-library',
    configureServer(server) {
      server.middlewares.use(LIBRARY_ROUTE, createLibraryHandler(dir))
    },
  }
}
