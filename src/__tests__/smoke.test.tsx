import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import { MemoryRouter, Routes, Route, Navigate } from 'react-router-dom'
import { App } from '../App'

function renderAt(path: string): string {
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<Navigate to="/a/minor-pentatonic/1" replace />} />
        <Route path="/:keySlug/:scaleId/:positionIdx" element={<App />} />
        <Route path="/:keySlug/:scaleId" element={<App />} />
        <Route path="*" element={<Navigate to="/a/minor-pentatonic/1" replace />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('App renders without errors', () => {
  it('default route', () => {
    const html = renderAt('/a/minor-pentatonic/1')
    expect(html).toContain('Fretted')
    expect(html).toContain('minor pentatonic')
  })

  it('E major position 3', () => {
    const html = renderAt('/e/major/3')
    expect(html).toContain('major')
  })

  it('G♯ Dorian position 5', () => {
    const html = renderAt('/g-sharp/dorian/5')
    expect(html).toContain('Dorian')
  })

  it('C harmonic minor position 7 (edge of neck)', () => {
    const html = renderAt('/c/harmonic-minor/7')
    expect(html).toContain('Harmonic Minor')
  })

  it('A blues — all 5 boxes render', () => {
    for (let pos = 1; pos <= 5; pos++) {
      const html = renderAt(`/a/blues/${pos}`)
      expect(html).toContain('Blues')
    }
  })

  it('every key × every scale renders without throwing', () => {
    const keys = [
      'a', 'a-sharp', 'b', 'c', 'c-sharp', 'd', 'd-sharp',
      'e', 'f', 'f-sharp', 'g', 'g-sharp',
    ]
    const scales = [
      'major', 'natural-minor', 'major-pentatonic', 'minor-pentatonic',
      'blues', 'harmonic-minor', 'melodic-minor',
      'dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian',
    ]
    for (const k of keys) {
      for (const s of scales) {
        const html = renderAt(`/${k}/${s}/1`)
        expect(html).toContain('Fretted')
      }
    }
  })
})
