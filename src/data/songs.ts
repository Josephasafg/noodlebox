import type { PitchClass } from '../theory/notes'
import { getScale, isScaleSubsetOf, type ScaleDef, type ScaleId } from '../theory/scales'
import type { Difficulty, Lick } from '../theory/licks'
import { isLickPlayableIn } from '../theory/licks'

/**
 * A well-known solo, with the key and scale it is usually taught in.
 *
 * This is a study index, not a transcription. The tab itself lives with the
 * sites licensed to publish it, which is what `tabUrl` opens — so the notation
 * you read is always the rights holder's, and always current.
 */
export interface Song {
  id: string
  title: string
  artist: string
  /** Root of the scale the solo sits in. */
  key: PitchClass
  scaleId: ScaleId
  /** One line on what the solo is known for. */
  note: string
  difficulty: Difficulty
  year?: number
}

// Pitch-class shorthand, to keep the table readable.
const C = 0, Db = 1, D = 2, Eb = 3, E = 4, F = 5, G = 7, A = 9, Bb = 10, B = 11

export const SONGS: readonly Song[] = [
  {
    id: 'stairway-to-heaven',
    title: 'Stairway to Heaven', artist: 'Led Zeppelin', year: 1971,
    key: A, scaleId: 'minor-pentatonic', difficulty: 2,
    note: 'Page builds the whole solo from one box, then repeats a bent phrase to climb out.',
  },
  {
    id: 'comfortably-numb',
    title: 'Comfortably Numb', artist: 'Pink Floyd', year: 1979,
    key: B, scaleId: 'natural-minor', difficulty: 2,
    note: 'Gilmour holds long bends and leaves space; the second solo is mostly six notes.',
  },
  {
    id: 'hotel-california',
    title: 'Hotel California', artist: 'Eagles', year: 1976,
    key: B, scaleId: 'natural-minor', difficulty: 3,
    note: 'Twin-guitar harmony in thirds and sixths over a descending minor progression.',
  },
  {
    id: 'while-my-guitar-gently-weeps',
    title: 'While My Guitar Gently Weeps', artist: 'The Beatles', year: 1968,
    key: A, scaleId: 'natural-minor', difficulty: 2,
    note: 'Clapton, uncredited — vocal phrasing and heavy vibrato rather than speed.',
  },
  {
    id: 'layla',
    title: 'Layla', artist: 'Derek and the Dominos', year: 1970,
    key: D, scaleId: 'minor-pentatonic', difficulty: 2,
    note: 'The signature riff is a minor pentatonic shape doubled in harmony.',
  },
  {
    id: 'crossroads',
    title: 'Crossroads', artist: 'Cream', year: 1968,
    key: A, scaleId: 'blues', difficulty: 3,
    note: 'Clapton at speed over a shuffle — box I and box II joined by the ♭5.',
  },
  {
    id: 'sunshine-of-your-love',
    title: 'Sunshine of Your Love', artist: 'Cream', year: 1967,
    key: D, scaleId: 'minor-pentatonic', difficulty: 1,
    note: 'One of the most recognisable minor pentatonic riffs ever written.',
  },
  {
    id: 'texas-flood',
    title: 'Texas Flood', artist: 'Stevie Ray Vaughan', year: 1983,
    key: G, scaleId: 'blues', difficulty: 3,
    note: 'Slow blues with aggressive over-bends and a huge attack.',
  },
  {
    id: 'pride-and-joy',
    title: 'Pride and Joy', artist: 'Stevie Ray Vaughan', year: 1983,
    key: E, scaleId: 'blues', difficulty: 3,
    note: 'Texas shuffle — the lead and the rhythm are the same hand.',
  },
  {
    id: 'the-thrill-is-gone',
    title: 'The Thrill Is Gone', artist: 'B.B. King', year: 1969,
    key: B, scaleId: 'minor-pentatonic', difficulty: 2,
    note: 'The BB box: a small cluster of notes, endless vibrato, no wasted movement.',
  },
  {
    id: 'little-wing',
    title: 'Little Wing', artist: 'Jimi Hendrix', year: 1967,
    key: E, scaleId: 'natural-minor', difficulty: 2,
    note: 'Chord melody and lead woven together, drenched in Univibe.',
  },
  {
    id: 'voodoo-child',
    title: 'Voodoo Child (Slight Return)', artist: 'Jimi Hendrix', year: 1968,
    key: E, scaleId: 'minor-pentatonic', difficulty: 2,
    note: 'Wah-driven pentatonic phrasing over a one-chord vamp.',
  },
  {
    id: 'purple-haze',
    title: 'Purple Haze', artist: 'Jimi Hendrix', year: 1967,
    key: E, scaleId: 'blues', difficulty: 2,
    note: 'The ♭5 as a hook rather than a passing note.',
  },
  {
    id: 'all-along-the-watchtower',
    title: 'All Along the Watchtower', artist: 'Jimi Hendrix', year: 1968,
    key: Db, scaleId: 'natural-minor', difficulty: 3,
    note: 'Four solos in a row, each with a different texture — slide, wah, then clean.',
  },
  {
    id: 'whole-lotta-love',
    title: 'Whole Lotta Love', artist: 'Led Zeppelin', year: 1969,
    key: E, scaleId: 'minor-pentatonic', difficulty: 2,
    note: 'Short, fast pentatonic bursts answering the riff.',
  },
  {
    id: 'since-ive-been-loving-you',
    title: "Since I've Been Loving You", artist: 'Led Zeppelin', year: 1970,
    key: C, scaleId: 'blues', difficulty: 3,
    note: 'Minor blues at a crawl — the phrasing carries it, not the notes.',
  },
  {
    id: 'sultans-of-swing',
    title: 'Sultans of Swing', artist: 'Dire Straits', year: 1978,
    key: D, scaleId: 'natural-minor', difficulty: 3,
    note: 'Knopfler fingerpicks the whole thing; the outro is a study in repeating licks.',
  },
  {
    id: 'money-for-nothing',
    title: 'Money for Nothing', artist: 'Dire Straits', year: 1985,
    key: G, scaleId: 'minor-pentatonic', difficulty: 2,
    note: 'That riff is a pentatonic double stop with a wah parked half-open.',
  },
  {
    id: 'sweet-home-alabama',
    title: 'Sweet Home Alabama', artist: 'Lynyrd Skynyrd', year: 1974,
    key: D, scaleId: 'major-pentatonic', difficulty: 2,
    note: 'Bright major pentatonic country-rock, full of double stops.',
  },
  {
    id: 'free-bird',
    title: 'Free Bird', artist: 'Lynyrd Skynyrd', year: 1973,
    key: G, scaleId: 'major-pentatonic', difficulty: 3,
    note: 'The long outro moves from major to minor pentatonic as it builds.',
  },
  {
    id: 'back-in-black',
    title: 'Back in Black', artist: 'AC/DC', year: 1980,
    key: E, scaleId: 'mixolydian', difficulty: 2,
    note: 'Angus over a major-flavoured riff — mixolydian, not minor.',
  },
  {
    id: 'highway-to-hell',
    title: 'Highway to Hell', artist: 'AC/DC', year: 1979,
    key: A, scaleId: 'mixolydian', difficulty: 2,
    note: 'Open chords and a solo that never leaves the major pentatonic for long.',
  },
  {
    id: 'paranoid',
    title: 'Paranoid', artist: 'Black Sabbath', year: 1970,
    key: E, scaleId: 'minor-pentatonic', difficulty: 2,
    note: 'Iommi at speed with heavy bends and almost no rests.',
  },
  {
    id: 'iron-man',
    title: 'Iron Man', artist: 'Black Sabbath', year: 1970,
    key: B, scaleId: 'minor-pentatonic', difficulty: 1,
    note: 'The riff every beginner learns, then the solo doubles it an octave up.',
  },
  {
    id: 'nothing-else-matters',
    title: 'Nothing Else Matters', artist: 'Metallica', year: 1991,
    key: E, scaleId: 'natural-minor', difficulty: 2,
    note: 'Hammett plays melody first; the fast run is the last thing that happens.',
  },
  {
    id: 'fade-to-black',
    title: 'Fade to Black', artist: 'Metallica', year: 1984,
    key: B, scaleId: 'natural-minor', difficulty: 3,
    note: 'Builds from clean arpeggios to a full aeolian shred outro.',
  },
  {
    id: 'master-of-puppets',
    title: 'Master of Puppets', artist: 'Metallica', year: 1986,
    key: E, scaleId: 'natural-minor', difficulty: 3,
    note: 'The melodic middle solo is pure E minor; the outro is chromatic aggression.',
  },
  {
    id: 'mr-crowley',
    title: 'Mr. Crowley', artist: 'Ozzy Osbourne', year: 1980,
    key: D, scaleId: 'harmonic-minor', difficulty: 3,
    note: 'Randy Rhoads leans on the natural 7 — classical phrasing over a rock band.',
  },
  {
    id: 'eruption',
    title: 'Eruption', artist: 'Van Halen', year: 1978,
    key: A, scaleId: 'minor-pentatonic', difficulty: 3,
    note: 'Tapping, dive bombs, and pentatonic sequences played impossibly clean.',
  },
  {
    id: 'black-magic-woman',
    title: 'Black Magic Woman', artist: 'Santana', year: 1970,
    key: D, scaleId: 'dorian', difficulty: 2,
    note: 'Sustain and vibrato over a minor vamp — the natural 6 is the whole colour.',
  },
  {
    id: 'oye-como-va',
    title: 'Oye Como Va', artist: 'Santana', year: 1970,
    key: A, scaleId: 'dorian', difficulty: 1,
    note: 'Two chords forever; the mode does all the work.',
  },
  {
    id: 'shine-on-you-crazy-diamond',
    title: 'Shine On You Crazy Diamond', artist: 'Pink Floyd', year: 1975,
    key: G, scaleId: 'natural-minor', difficulty: 2,
    note: 'Four notes as a theme, then bends held longer than feels reasonable.',
  },
  {
    id: 'wish-you-were-here',
    title: 'Wish You Were Here', artist: 'Pink Floyd', year: 1975,
    key: G, scaleId: 'major', difficulty: 1,
    note: 'The solo is a major-scale melody you could sing.',
  },
  {
    id: 'smells-like-teen-spirit',
    title: 'Smells Like Teen Spirit', artist: 'Nirvana', year: 1991,
    key: F, scaleId: 'minor-pentatonic', difficulty: 1,
    note: 'Cobain plays the vocal melody back at you, almost note for note.',
  },
  {
    id: 'cliffs-of-dover',
    title: 'Cliffs of Dover', artist: 'Eric Johnson', year: 1990,
    key: G, scaleId: 'major', difficulty: 3,
    note: 'Cascading major-scale runs with hybrid picking and a violin-smooth tone.',
  },
  {
    id: 'johnny-b-goode',
    title: 'Johnny B. Goode', artist: 'Chuck Berry', year: 1958,
    key: Bb, scaleId: 'major-pentatonic', difficulty: 2,
    note: 'The intro that invented rock lead guitar — double stops in fourths.',
  },
  {
    id: 'bohemian-rhapsody',
    title: 'Bohemian Rhapsody', artist: 'Queen', year: 1975,
    key: Eb, scaleId: 'major', difficulty: 2,
    note: 'Brian May writes it like a vocal counter-melody, then harmonises it.',
  },
  {
    id: 'hey-joe',
    title: 'Hey Joe', artist: 'Jimi Hendrix', year: 1966,
    key: E, scaleId: 'major-pentatonic', difficulty: 2,
    note: 'Major pentatonic over a cycle-of-fifths progression.',
  },
]

/** Search the tab for a song on Songsterr, which has an interactive player. */
export function songsterrUrl(song: Song): string {
  return `https://www.songsterr.com/?pattern=${encodeURIComponent(`${song.title} ${song.artist}`)}`
}

/** Search the tab for a song on Ultimate Guitar. */
export function ultimateGuitarUrl(song: Song): string {
  const query = `${song.title} ${song.artist}`
  return `https://www.ultimate-guitar.com/search.php?search_type=title&value=${encodeURIComponent(query)}`
}

export function getSong(id: string): Song | null {
  return SONGS.find((s) => s.id === id) ?? null
}

export interface SongMatch {
  song: Song
  /** 'exact' when the solo's scale is the one selected, 'compatible' when it fits inside it. */
  match: 'exact' | 'compatible'
  songScale: ScaleDef | null
}

export interface SongQuery {
  scale: ScaleDef
  /** Also return solos in other scales whose notes fit inside `scale`. */
  includeCompatible?: boolean
  text?: string
  difficulty?: Difficulty | null
}

/**
 * Find solos to study for a given scale. Songs whose solo is written in that
 * scale rank first, then ones in a scale that fits inside it.
 */
export function searchSongs(songs: readonly Song[], query: SongQuery): SongMatch[] {
  const { scale, includeCompatible = true, text = '', difficulty = null } = query
  const terms = text.trim().toLowerCase().split(/\s+/).filter(Boolean)

  const matches: SongMatch[] = []
  for (const song of songs) {
    const songScale = getScale(song.scaleId)
    const isExact = song.scaleId === scale.id
    if (!isExact) {
      if (!includeCompatible) continue
      if (!songScale || !isScaleSubsetOf(songScale, scale)) continue
    }
    if (difficulty !== null && song.difficulty !== difficulty) continue

    if (terms.length > 0) {
      const hay = [song.title, song.artist, song.note, songScale?.displayName ?? '']
        .join(' ')
        .toLowerCase()
      if (!terms.every((t) => hay.includes(t))) continue
    }

    matches.push({ song, match: isExact ? 'exact' : 'compatible', songScale })
  }

  return matches.sort((a, b) => {
    if (a.match !== b.match) return a.match === 'exact' ? -1 : 1
    if (a.song.difficulty !== b.song.difficulty) return a.song.difficulty - b.song.difficulty
    return a.song.title.localeCompare(b.song.title)
  })
}

/** Licks whose notes all fit the scale a song's solo sits in. */
export function licksForSong(song: Song, licks: readonly Lick[], limit = 6): Lick[] {
  const scale = getScale(song.scaleId)
  if (!scale) return []
  return licks
    .filter((l) => l.scaleId === song.scaleId || isLickPlayableIn(l, scale))
    .sort((a, b) => {
      const aExact = a.scaleId === song.scaleId ? 0 : 1
      const bExact = b.scaleId === song.scaleId ? 0 : 1
      if (aExact !== bExact) return aExact - bExact
      return a.difficulty - b.difficulty
    })
    .slice(0, limit)
}
