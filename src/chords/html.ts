/**
 * Decoding the entities a song page uses, without a DOM.
 *
 * Worth doing thoroughly rather than for the obvious few: an entity left
 * undecoded does not merely look wrong in tablature, it is read as notation.
 * `&mdash;` survives as seven characters, two of which are `s` and `h` — the
 * marks for a slide and a hammer-on — so a dash the tabber typed as padding
 * would otherwise invent articulations that are not in the tab.
 */

const NAMED: Record<string, string> = {
  nbsp: ' ',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  deg: '°',
  sharp: '♯',
  flat: '♭',
}

export function decodeEntities(text: string): string {
  return (
    text
      .replace(/&#x([0-9a-f]{1,6});/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d{1,7});/g, (_, code) => String.fromCodePoint(Number(code)))
      .replace(/&([a-z]+);/gi, (whole, name: string) => NAMED[name.toLowerCase()] ?? whole)
      // Last, so a doubly-encoded entity resolves to text rather than to markup.
      .replace(/&amp;/g, '&')
  )
}
