import { describe, expect, it } from 'vitest'
import {
  SONGS,
  getSong,
  licksForSong,
  searchSongs,
  songsterrUrl,
  ultimateGuitarUrl,
} from '../songs'
import { ALL_LICKS } from '../licks'
import { SCALES, getScale, isScaleSubsetOf } from '../../theory/scales'
import { isLickPlayableIn } from '../../theory/licks'

describe('song catalog integrity', () => {
  it('has songs to search', () => {
    expect(SONGS.length).toBeGreaterThan(20)
  })

  it('uses unique ids', () => {
    const ids = SONGS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('references scales that exist and keys in range', () => {
    for (const song of SONGS) {
      expect(getScale(song.scaleId), song.id).not.toBeNull()
      expect(song.key, song.id).toBeGreaterThanOrEqual(0)
      expect(song.key, song.id).toBeLessThanOrEqual(11)
    }
  })

  it('gives every song a title, artist and note', () => {
    for (const song of SONGS) {
      expect(song.title.length, song.id).toBeGreaterThan(0)
      expect(song.artist.length, song.id).toBeGreaterThan(0)
      expect(song.note.length, song.id).toBeGreaterThan(10)
    }
  })

  it('finds songs by id', () => {
    expect(getSong(SONGS[0].id)).toBe(SONGS[0])
    expect(getSong('nope')).toBeNull()
  })
})

describe('tab links', () => {
  it('builds an encoded Songsterr search for title and artist', () => {
    const song = SONGS.find((s) => s.id === 'comfortably-numb')!
    const url = songsterrUrl(song)
    expect(url).toBe('https://www.songsterr.com/?pattern=Comfortably%20Numb%20Pink%20Floyd')
  })

  it('builds an encoded Ultimate Guitar search', () => {
    const song = SONGS.find((s) => s.id === 'hotel-california')!
    expect(ultimateGuitarUrl(song)).toContain('ultimate-guitar.com/search.php')
    expect(ultimateGuitarUrl(song)).toContain('Hotel%20California')
  })

  it('produces valid https urls for every song', () => {
    for (const song of SONGS) {
      for (const url of [songsterrUrl(song), ultimateGuitarUrl(song)]) {
        expect(() => new URL(url), song.id).not.toThrow()
        expect(new URL(url).protocol, song.id).toBe('https:')
      }
    }
  })

  it('round-trips a title containing an apostrophe', () => {
    // encodeURIComponent leaves apostrophes as-is; they are legal in a query
    // string, so the requirement is that the value survives parsing intact.
    const song = SONGS.find((s) => s.id === 'since-ive-been-loving-you')!
    const parsed = new URL(songsterrUrl(song))
    expect(parsed.searchParams.get('pattern')).toBe(
      "Since I've Been Loving You Led Zeppelin",
    )
  })

  it('round-trips titles and artists for every song', () => {
    for (const song of SONGS) {
      const parsed = new URL(songsterrUrl(song))
      expect(parsed.searchParams.get('pattern'), song.id).toBe(
        `${song.title} ${song.artist}`,
      )
    }
  })
})

describe('searchSongs', () => {
  it('ranks solos written in the scale above related ones', () => {
    const results = searchSongs(SONGS, { scale: SCALES['natural-minor'] })
    const firstRelated = results.findIndex((r) => r.match === 'compatible')
    const lastExact = results.map((r) => r.match).lastIndexOf('exact')
    expect(firstRelated).toBeGreaterThan(-1)
    expect(lastExact).toBeLessThan(firstRelated)
  })

  it('returns only exact matches when related scales are off', () => {
    const results = searchSongs(SONGS, {
      scale: SCALES['minor-pentatonic'],
      includeCompatible: false,
    })
    expect(results.length).toBeGreaterThan(0)
    expect(results.every((r) => r.song.scaleId === 'minor-pentatonic')).toBe(true)
  })

  it('offers pentatonic solos while studying natural minor', () => {
    const results = searchSongs(SONGS, { scale: SCALES['natural-minor'] })
    const ids = results.map((r) => r.song.id)
    expect(ids).toContain('stairway-to-heaven')
    expect(results.find((r) => r.song.id === 'stairway-to-heaven')!.match).toBe('compatible')
  })

  it('never offers a blues solo for the major scale', () => {
    const results = searchSongs(SONGS, { scale: SCALES['major'] })
    expect(results.some((r) => r.song.scaleId === 'blues')).toBe(false)
  })

  it('only returns solos whose scale fits the selected one', () => {
    for (const scale of Object.values(SCALES)) {
      for (const r of searchSongs(SONGS, { scale })) {
        const songScale = getScale(r.song.scaleId)!
        expect(isScaleSubsetOf(songScale, scale), `${r.song.id} in ${scale.id}`).toBe(true)
      }
    }
  })

  it('searches by band name', () => {
    const results = searchSongs(SONGS, { scale: SCALES['natural-minor'], text: 'floyd' })
    expect(results.length).toBeGreaterThan(0)
    expect(results.every((r) => r.song.artist.toLowerCase().includes('floyd'))).toBe(true)
  })

  it('searches by song title', () => {
    const results = searchSongs(SONGS, {
      scale: SCALES['minor-pentatonic'],
      text: 'stairway',
    })
    expect(results.map((r) => r.song.id)).toContain('stairway-to-heaven')
  })

  it('requires every term to match', () => {
    const results = searchSongs(SONGS, {
      scale: SCALES['natural-minor'],
      text: 'floyd zzzz',
    })
    expect(results).toEqual([])
  })

  it('filters by difficulty', () => {
    const results = searchSongs(SONGS, { scale: SCALES['minor-pentatonic'], difficulty: 1 })
    expect(results.length).toBeGreaterThan(0)
    expect(results.every((r) => r.song.difficulty === 1)).toBe(true)
  })
})

describe('licksForSong', () => {
  it('only suggests licks that fit the solo’s scale', () => {
    for (const song of SONGS) {
      const scale = getScale(song.scaleId)!
      for (const lick of licksForSong(song, ALL_LICKS)) {
        expect(isLickPlayableIn(lick, scale), `${lick.id} for ${song.id}`).toBe(true)
      }
    }
  })

  it('suggests at least one lick for every song', () => {
    for (const song of SONGS) {
      expect(licksForSong(song, ALL_LICKS).length, song.id).toBeGreaterThan(0)
    }
  })

  it('puts licks written for the solo’s own scale first', () => {
    const song = SONGS.find((s) => s.id === 'stairway-to-heaven')!
    const picks = licksForSong(song, ALL_LICKS, 4)
    expect(picks[0].scaleId).toBe('minor-pentatonic')
  })

  it('respects the limit', () => {
    const song = SONGS.find((s) => s.id === 'stairway-to-heaven')!
    expect(licksForSong(song, ALL_LICKS, 3)).toHaveLength(3)
  })
})
