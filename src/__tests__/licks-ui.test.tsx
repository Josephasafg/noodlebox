import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { App } from '../App'
import { ALL_LICKS } from '../data/licks'
import { resolveLick } from '../theory/licks'

function renderAt(path: string): string {
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/:keySlug/:scaleId/:positionIdx" element={<App />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('lick selected via the URL', () => {
  it('presents the tab for the selected lick', () => {
    const html = renderAt('/a/minor-pentatonic/1?lick=minpent-bend-climb')
    expect(html).toContain('Box I Bend Climb')
    expect(html).toContain('guitar tab')
    // The practice note travels with the tab.
    expect(html).toContain('Push the ♭7 a full step')
  })

  it('reports the fret span the lick occupies in the current key', () => {
    // A minor pentatonic box I sits at frets 5–8.
    const html = renderAt('/a/minor-pentatonic/1?lick=minpent-box1-run')
    expect(html).toContain('frets 5–8')
  })

  it('transposes the same lick when the key changes', () => {
    // The shape slides up three frets from A to C.
    const inA = renderAt('/a/minor-pentatonic/1?lick=minpent-box1-run')
    const inC = renderAt('/c/minor-pentatonic/1?lick=minpent-box1-run')
    expect(inA).toContain('frets 5–8')
    expect(inC).toContain('frets 8–11')
  })

  it('labels a lick borrowed from another scale', () => {
    const html = renderAt('/a/natural-minor/1?lick=minpent-box1-run')
    expect(html).toContain('borrowed from')
    expect(html).toContain('Minor Pentatonic')
  })

  it('warns when the selected scale cannot contain the lick', () => {
    // A blues lick carries a ♭5 that natural minor does not have.
    const html = renderAt('/a/natural-minor/1?lick=blues-box1-run')
    expect(html).toContain('outside this scale')
  })

  it('does not mark an exact match as borrowed', () => {
    const html = renderAt('/a/minor-pentatonic/1?lick=minpent-box1-run')
    expect(html).not.toContain('borrowed from')
  })

  it('ignores an unknown lick id and still renders the scale view', () => {
    const html = renderAt('/a/minor-pentatonic/1?lick=does-not-exist')
    expect(html).toContain('noodlebox')
    expect(html).not.toContain('guitar tab')
  })

  it('renders every lick in every key without throwing', () => {
    const keys = ['a', 'c', 'd-sharp', 'e', 'g-sharp']
    for (const lick of ALL_LICKS) {
      for (const k of keys) {
        const html = renderAt(`/${k}/${lick.scaleId}/1?lick=${lick.id}`)
        expect(html, `${lick.id} in ${k}`).toContain('guitar tab')
      }
    }
  })

  it('draws one fret number per note in the lick', () => {
    const lick = ALL_LICKS.find((l) => l.id === 'minpent-box1-run')!
    const resolved = resolveLick(lick, 9)
    const html = renderAt('/a/minor-pentatonic/1?lick=minpent-box1-run')
    // Each note gets its own <title> describing the string it sits on.
    const titles = html.match(/fret \d+ on the/g) ?? []
    expect(titles.length).toBe(resolved.notes.length)
  })

  it('shows articulation names for the techniques a lick uses', () => {
    const html = renderAt('/a/minor-pentatonic/1?lick=minpent-hammer-roll')
    expect(html).toContain('hammer-on')
  })
})
