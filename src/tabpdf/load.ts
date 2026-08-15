import { extractPrimitives } from './extract'
import { parseScore, type ParseOptions } from './parse'
import type { ParsedScore, TabPagePrimitives } from './types'

/** Refuse anything implausibly large before handing it to the PDF worker. */
const MAX_BYTES = 40 * 1024 * 1024

export class TabPdfError extends Error {}

/**
 * pdf.js is a large dependency and most sessions never import a PDF, so it is
 * loaded on first use rather than bundled into the initial payload.
 */
async function loadPdfjs() {
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ])
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  return pdfjs
}

/**
 * Read the drawing primitives out of a PDF file.
 *
 * Kept separate from parsing so that changing a parse option — the bar length,
 * say — does not mean decoding the document again.
 */
export async function readTabPdf(
  file: File,
  onProgress?: (page: number, total: number) => void,
): Promise<TabPagePrimitives[]> {
  if (file.size > MAX_BYTES) {
    throw new TabPdfError('That file is over 40 MB, which is too large to read in the browser.')
  }
  const pdfjs = await loadPdfjs()
  const data = new Uint8Array(await file.arrayBuffer())

  let doc
  try {
    doc = await pdfjs.getDocument({ data }).promise
  } catch (cause) {
    const message =
      cause instanceof Error && /password/i.test(cause.message)
        ? 'That PDF is password protected, so its contents cannot be read.'
        : 'That file could not be opened as a PDF.'
    throw new TabPdfError(message)
  }

  try {
    return await extractPrimitives(doc, pdfjs.OPS, onProgress)
  } finally {
    void doc.cleanup()
  }
}

export async function importTabPdf(
  file: File,
  options: ParseOptions = {},
  onProgress?: (page: number, total: number) => void,
): Promise<{ score: ParsedScore; pages: TabPagePrimitives[] }> {
  const pages = await readTabPdf(file, onProgress)
  return { score: parseScore(pages, options), pages }
}
