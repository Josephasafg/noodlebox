import type { TabLineSeg, TabPagePrimitives, TabTextItem } from './types'

/**
 * The slice of pdf.js this module needs, described structurally so the extractor
 * can run against either the browser build or the Node build. The Node one is
 * what the parser is exercised with in tests.
 */
export interface PdfOps {
  save: number
  restore: number
  transform: number
  constructPath: number
}

interface PageLike {
  getViewport(options: { scale: number }): { width: number; height: number }
  getOperatorList(): Promise<{ fnArray: ArrayLike<number>; argsArray: unknown[] }>
  getTextContent(): Promise<{ items: unknown[] }>
}

export interface DocumentLike {
  numPages: number
  getPage(pageNumber: number): Promise<PageLike>
}

type Matrix = [number, number, number, number, number, number]

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ]
}

function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

// Path sub-operators, from pdf.js's DrawOPS.
const MOVE_TO = 0
const LINE_TO = 1
const CURVE_TO = 2
const QUADRATIC_CURVE_TO = 3
const CLOSE_PATH = 4

/**
 * Collect the straight strokes of a page in top-left coordinates.
 *
 * Staff lines and barlines are the only geometry the parser needs, and both are
 * straight, so curves are walked past rather than flattened. Coordinates inside
 * a path are in the space of whatever transform was in force, hence the matrix
 * stack.
 */
function collectSegments(
  fnArray: ArrayLike<number>,
  argsArray: unknown[],
  ops: PdfOps,
  pageHeight: number,
): TabLineSeg[] {
  const segments: TabLineSeg[] = []
  const stack: Matrix[] = []
  let ctm: Matrix = IDENTITY

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]
    if (fn === ops.save) {
      stack.push(ctm)
    } else if (fn === ops.restore) {
      ctm = stack.pop() ?? IDENTITY
    } else if (fn === ops.transform) {
      const args = argsArray[i] as number[]
      if (args && args.length >= 6) ctm = multiply(ctm, args.slice(0, 6) as Matrix)
    } else if (fn === ops.constructPath) {
      const args = argsArray[i] as [unknown, ArrayLike<number>[] | undefined, unknown]
      const paths = args?.[1]
      if (!paths) continue
      for (const raw of paths) {
        const data = Array.from(raw as ArrayLike<number>)
        let cx = 0
        let cy = 0
        let startX = 0
        let startY = 0
        let k = 0
        while (k < data.length) {
          const op = data[k++]
          if (op === MOVE_TO) {
            ;[cx, cy] = applyMatrix(ctm, data[k], data[k + 1])
            startX = cx
            startY = cy
            k += 2
          } else if (op === LINE_TO) {
            const [x, y] = applyMatrix(ctm, data[k], data[k + 1])
            segments.push({ x0: cx, y0: pageHeight - cy, x1: x, y1: pageHeight - y })
            cx = x
            cy = y
            k += 2
          } else if (op === CURVE_TO) {
            ;[cx, cy] = applyMatrix(ctm, data[k + 4], data[k + 5])
            k += 6
          } else if (op === QUADRATIC_CURVE_TO) {
            ;[cx, cy] = applyMatrix(ctm, data[k + 2], data[k + 3])
            k += 4
          } else if (op === CLOSE_PATH) {
            segments.push({ x0: cx, y0: pageHeight - cy, x1: startX, y1: pageHeight - startY })
            cx = startX
            cy = startY
          } else {
            // An operator we do not know; the rest of this path is unreadable.
            break
          }
        }
      }
    }
  }
  return segments
}

interface RawTextItem {
  str?: unknown
  transform?: unknown
  width?: unknown
}

/**
 * Text runs in top-left coordinates. Runs holding several space-separated tokens
 * are split so that each fret number keeps its own horizontal position.
 */
function collectTexts(items: unknown[], pageHeight: number): TabTextItem[] {
  const out: TabTextItem[] = []
  for (const raw of items) {
    const item = raw as RawTextItem
    const str = typeof item.str === 'string' ? item.str : ''
    if (str.trim().length === 0) continue
    const transform = item.transform
    if (!Array.isArray(transform) || transform.length < 6) continue
    const x = Number(transform[4])
    const baseline = pageHeight - Number(transform[5])
    const fontSize = Math.hypot(Number(transform[2]), Number(transform[3])) || Number(transform[3])
    const width = typeof item.width === 'number' ? item.width : str.length * fontSize * 0.5
    if (!Number.isFinite(x) || !Number.isFinite(baseline)) continue

    const tokens = str.split(/(\s+)/).filter((t) => t.length > 0)
    if (tokens.length <= 1) {
      out.push({ str, x, y: baseline, fontSize, width })
      continue
    }
    // Distribute the advance width across the run by character count, which is
    // accurate enough to keep tokens in their own columns.
    const perChar = width / str.length
    let cursor = x
    for (const token of tokens) {
      const tokenWidth = perChar * token.length
      if (token.trim().length > 0) {
        out.push({ str: token, x: cursor, y: baseline, fontSize, width: tokenWidth })
      }
      cursor += tokenWidth
    }
  }
  return out
}

/** Pull the drawing primitives out of every page of an open PDF. */
export async function extractPrimitives(
  doc: DocumentLike,
  ops: PdfOps,
  onProgress?: (page: number, total: number) => void,
): Promise<TabPagePrimitives[]> {
  const pages: TabPagePrimitives[] = []
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const viewport = page.getViewport({ scale: 1 })
    const [opList, textContent] = await Promise.all([
      page.getOperatorList(),
      page.getTextContent(),
    ])
    pages.push({
      pageIndex: n - 1,
      width: viewport.width,
      height: viewport.height,
      segments: collectSegments(opList.fnArray, opList.argsArray, ops, viewport.height),
      texts: collectTexts(textContent.items, viewport.height),
    })
    onProgress?.(n, doc.numPages)
  }
  return pages
}
