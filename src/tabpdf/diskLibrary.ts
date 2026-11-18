import type { LibraryEntry, StoredData } from './library'

/**
 * The library as the dev server keeps it, in a folder on disk
 * (`scripts/libraryStore.ts`), so it is the same whichever port serves the app.
 *
 * A stored PDF is a Blob, which JSON cannot carry, so it travels as base64.
 */

const ROUTE = '/library'

type WirePdf = { type: string; base64: string }
type WireData = Omit<StoredData, 'pdf'> & { pdf?: WirePdf }

/** Chunked so a large PDF does not exceed the argument limit of `fromCharCode`. */
const CHUNK = 0x8000

async function pdfToWire(pdf: Blob): Promise<WirePdf> {
  const bytes = new Uint8Array(await pdf.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return { type: pdf.type, base64: btoa(binary) }
}

function pdfFromWire({ type, base64 }: WirePdf): Blob {
  return new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type })
}

const songUrl = (id: string) => `${ROUTE}/${encodeURIComponent(id)}`

function check(response: Response): Response {
  if (!response.ok) throw new Error(`The library on disk answered ${response.status}.`)
  return response
}

export async function listOnDisk(): Promise<LibraryEntry[]> {
  return check(await fetch(`${ROUTE}/`)).json()
}

export async function readOnDisk(id: string): Promise<StoredData | null> {
  const response = await fetch(songUrl(id))
  if (response.status === 404) return null
  const { pdf, ...rest } = (await check(response).json()) as WireData
  return pdf ? { ...rest, pdf: pdfFromWire(pdf) } : rest
}

export async function writeOnDisk(entry: LibraryEntry, data: StoredData): Promise<void> {
  const { pdf, ...rest } = data
  const wire: WireData = pdf ? { ...rest, pdf: await pdfToWire(pdf) } : rest
  check(
    await fetch(songUrl(entry.id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entry, data: wire }),
    }),
  )
}

export async function deleteOnDisk(id: string): Promise<void> {
  check(await fetch(songUrl(id), { method: 'DELETE' }))
}
