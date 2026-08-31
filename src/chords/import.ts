import { TabPdfError } from '../tabpdf/load'
import { parseTab4u } from './tab4u'
import { parseUltimateGuitar } from './ultimateGuitar'
import type { ChordPage } from './types'

/**
 * Importing a song from a chord site.
 *
 * Neither site sends CORS headers, so the browser cannot read them directly.
 * The dev server proxies to each one instead, the same way `/api` reaches the
 * video service — see `vite.config.ts`. That keeps the fetch same-origin and
 * means no key, no extension and no copy-and-paste.
 */

interface ChordSite {
  /** Matches the host itself and any subdomain of it. */
  domain: string
  /** The dev-server path that proxies to it. */
  proxy: string
  name: string
  parse: (html: string, sourceUrl: string) => ChordPage
}

const SITES: ChordSite[] = [
  { domain: 'tab4u.com', proxy: '/tab4u', name: 'tab4u', parse: parseTab4u },
  {
    domain: 'ultimate-guitar.com',
    proxy: '/ug',
    name: 'Ultimate Guitar',
    parse: parseUltimateGuitar,
  },
]

export function chordSiteFor(url: URL): ChordSite | null {
  const host = url.hostname.toLowerCase()
  return (
    SITES.find((site) => host === site.domain || host.endsWith(`.${site.domain}`)) ?? null
  )
}

/** Every site a song link can be imported from, for what the UI says. */
export const CHORD_SITE_NAMES = SITES.map((site) => site.name)

export async function importChordPage(raw: string): Promise<ChordPage> {
  const trimmed = raw.trim()
  const url = new URL(trimmed)
  const site = chordSiteFor(url)
  if (!site) {
    throw new TabPdfError(`Songs can be imported from ${CHORD_SITE_NAMES.join(' and ')}.`)
  }

  let response: Response
  try {
    response = await fetch(`${site.proxy}${url.pathname}${url.search}`)
  } catch {
    throw new TabPdfError(`${site.name} could not be reached. Check the connection and try again.`)
  }
  if (!response.ok) {
    throw new TabPdfError(
      response.status === 404
        ? `${site.name} answered 404 for that link — either the song page is gone, or the app ` +
          'is not running behind the dev server. Start it with npm run dev and try again.'
        : `${site.name} answered ${response.status} for that link.`,
    )
  }
  return site.parse(await response.text(), trimmed)
}
