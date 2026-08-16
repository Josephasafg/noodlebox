import { useCallback, useEffect, useRef, useState } from 'react'
import { TabPdfError, importTabPdf, readTabPdf } from '../tabpdf/load'
import { parseScore } from '../tabpdf/parse'
import { classifyUrl, fetchSource, parsePrimitives } from '../tabpdf/source'
import {
  discardVideoJob,
  nameVideoShapes,
  readVideoJob,
  serverHealth,
  startVideoExtraction,
  type VideoJob,
} from '../tabpdf/videoServer'
import {
  deleteTab,
  entryFor,
  listTabs,
  readTab,
  saveTab,
  titleFor,
  updateTab,
  type LibraryEntry,
  type StoredSource,
  type TabSource,
} from '../tabpdf/library'
import type { ParsedScore, TabPagePrimitives } from '../tabpdf/types'

/** Which tab was open last, so a refresh reopens it. */
const LAST_OPEN_KEY = 'noodlebox.lastTab'

export type LibraryStatus = 'idle' | 'reading' | 'error'

function rememberLastOpen(id: string | null) {
  if (typeof localStorage === 'undefined') return
  try {
    if (id) localStorage.setItem(LAST_OPEN_KEY, id)
    else localStorage.removeItem(LAST_OPEN_KEY)
  } catch {
    // Not being able to remember which tab was open is not worth failing over.
  }
}

function lastOpenId(): string | null {
  if (typeof localStorage === 'undefined') return null
  try {
    return localStorage.getItem(LAST_OPEN_KEY)
  } catch {
    return null
  }
}

/**
 * The library of imported tabs, and whichever one is open.
 *
 * Scores and their source PDFs live in IndexedDB, so importing a tab is a
 * one-time cost — afterwards it is picked from the list. Page primitives for the
 * open tab are cached in memory so re-reading it with a different bar length is
 * instant; when they are not to hand the stored PDF is read again instead.
 */
export function useScoreLibrary() {
  const [entries, setEntries] = useState<LibraryEntry[]>([])
  const [entry, setEntry] = useState<LibraryEntry | null>(null)
  const [score, setScore] = useState<ParsedScore | null>(null)
  const [status, setStatus] = useState<LibraryStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ page: number; total: number } | null>(null)
  const [videoJob, setVideoJob] = useState<VideoJob | null>(null)
  /** Whether videos can be read at all; null until it has been checked. */
  const [videoReady, setVideoReady] = useState<boolean | null>(null)
  /** Whether a vision model is naming the shapes, so the library can say so. */
  const [videoNamesShapes, setVideoNamesShapes] = useState(false)
  const pagesRef = useRef<TabPagePrimitives[] | null>(null)
  /** The job being followed. Anything else polling is stale and must stop. */
  const followingRef = useRef<string | null>(null)

  const fail = useCallback((cause: unknown, fallback: string) => {
    setError(cause instanceof TabPdfError ? cause.message : fallback)
    setStatus('error')
  }, [])

  const open = useCallback(
    async (id: string) => {
      setStatus('reading')
      setError(null)
      try {
        const [stored, all] = await Promise.all([readTab(id), listTabs()])
        if (!stored) {
          setError('That tab is no longer in the library.')
          setStatus('error')
          return null
        }
        pagesRef.current = null
        setEntries(all)
        setEntry(all.find((e) => e.id === id) ?? null)
        setScore(stored.score)
        rememberLastOpen(id)
        setStatus('idle')
        return stored.score
      } catch (cause) {
        fail(cause, 'That tab could not be opened.')
        return null
      }
    },
    [fail],
  )

  // Restore the library list, reopening whatever was last in front.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const all = await listTabs()
        if (cancelled) return
        setEntries(all)
        const wanted = lastOpenId()
        const match = wanted ? all.find((e) => e.id === wanted) : undefined
        if (!match) return
        const stored = await readTab(match.id)
        if (cancelled || !stored) return
        setEntry(match)
        setScore(stored.score)
      } catch {
        // An unavailable store just means the library starts out empty.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * Take a freshly read score into the library and put it in front.
   *
   * Shared by both ways in, so a tab behaves the same however it arrived: it is
   * filed under its name, replaces an earlier import of that name, and stays
   * usable even if it could not be stored.
   */
  const adopt = useCallback(
    async (
      next: ParsedScore,
      pages: TabPagePrimitives[],
      fileName: string,
      stored: StoredSource,
      label: TabSource,
      describe: string,
    ) => {
      // Nothing readable is not worth keeping — it would sit in the library as an
      // empty row. Bars without notes count as nothing readable: a primitives
      // file whose shapes were never named still has a measure grid, and filing
      // that would look like a tab that had lost its notes.
      if (next.measures.length === 0 || next.notes.length === 0) {
        setError(next.warnings[0] ?? `No tablature could be found in ${describe}.`)
        setStatus('error')
        return null
      }
      // Re-importing replaces what is stored under that name rather than adding
      // a second copy of the same tab.
      const all = await listTabs().catch(() => [])
      const existing = all.find((e) => e.fileName === fileName)
      // The same song from a PDF and from a video is two readings of it, worth
      // keeping side by side — so they are numbered rather than one replacing
      // the other. Re-importing the same file keeps the number it already had.
      const title = titleFor(next, fileName)
      const siblings = all.filter(
        (e) => e.fileName !== fileName && e.title === title && e.artist === next.artist,
      )
      const version = existing?.version ?? siblings.length + 1
      const id =
        existing?.id ??
        (typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `tab-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
      const nextEntry = entryFor(
        id,
        next,
        fileName,
        existing?.addedAt ?? Date.now(),
        label,
        version,
      )
      try {
        await saveTab(nextEntry, next, stored)
        setEntries(await listTabs())
        rememberLastOpen(id)
      } catch {
        // Reading worked even if storing did not; keep the tab usable and say so.
        setError('This tab was read but could not be saved to the library.')
      }
      pagesRef.current = pages
      setEntry(nextEntry)
      setScore(next)
      setStatus('idle')
      return next
    },
    [],
  )

  const importFile = useCallback(
    async (file: File) => {
      setStatus('reading')
      setError(null)
      setProgress({ page: 0, total: 0 })
      try {
        // A primitives file is what the video reader writes, so it can be picked
        // straight off disk without being served from somewhere first.
        if (file.type === 'application/json' || /\.json$/i.test(file.name)) {
          const pages = parsePrimitives(await file.text())
          return await adopt(
            parseScore(pages),
            pages,
            file.name,
            { primitives: pages },
            'tab',
            'that primitives file',
          )
        }
        const { score: next, pages } = await importTabPdf(file, {}, (page, total) =>
          setProgress({ page, total }),
        )
        return await adopt(next, pages, file.name, { pdf: file }, 'pdf', 'that PDF')
      } catch (cause) {
        fail(cause, 'Something went wrong while reading that PDF.')
        return null
      } finally {
        setProgress(null)
      }
    },
    [adopt, fail],
  )

  /**
   * Ask whether the extraction service is up.
   *
   * Driven by opening the library rather than by mounting: that is the only place
   * the answer is shown, the service comes up a couple of seconds after the page
   * does, and it can be stopped and started while the app stays open.
   */
  const checkVideoServer = useCallback(async () => {
    const health = await serverHealth()
    setVideoReady(health !== null)
    setVideoNamesShapes(health?.namesShapes === true)
    return health !== null
  }, [])

  /** Take the primitives a finished extraction produced into the library. */
  const adoptVideo = useCallback(
    async (job: VideoJob) => {
      if (!job.pages) return null
      const name = `${job.title || 'video'}.tab`
      const parsed = parseScore(job.pages)
      // What the reader could not name never reaches the parser, so it cannot
      // count it — and a video that named its own shapes says nothing on screen
      // by itself. Both belong beside the parser's own notes on how it read this.
      const warnings = [...parsed.warnings]
      if (job.unreadCount) {
        warnings.push(
          `${job.unreadCount} printed ${job.unreadCount === 1 ? 'number was' : 'numbers were'} ` +
            'not identified and left out rather than guessed at.',
        )
      }
      // A dropped technique mark is not a missing note — the frets are all there
      // and right — so it reads as a correct tab that is quietly missing its
      // hammer-ons, pull-offs and slides. That is worth saying out loud.
      if (job.silentTechniqueCount) {
        warnings.push(
          `${job.silentTechniqueCount} slur ${job.silentTechniqueCount === 1 ? 'or slide mark was' : 'and slide marks were'} ` +
            'found but not identified, so hammer-ons, pull-offs and slides are missing here. ' +
            'Naming those shapes on the next import brings them back.',
        )
      }
      if (job.autoNamedCount) {
        warnings.push(
          'The printed shapes in this font were read automatically. Worth checking a bar ' +
            'against the video: a misread shape is wrong everywhere it appears.',
        )
      }
      return await adopt(
        { ...parsed, warnings },
        job.pages,
        name,
        { primitives: job.pages },
        'video',
        'that video',
      )
    },
    [adopt],
  )

  /**
   * Follow a running extraction until it finishes, fails, or needs shapes named.
   *
   * Polling rather than a socket, because the interesting states are coarse and
   * minutes apart; a stale loop stops as soon as another job is started.
   */
  const follow = useCallback(
    async (id: string) => {
      while (followingRef.current === id) {
        let job: VideoJob
        try {
          job = await readVideoJob(id)
        } catch (cause) {
          fail(cause, 'The extraction service stopped answering.')
          setVideoJob(null)
          return null
        }
        setVideoJob(job)
        if (job.state === 'error') {
          setError(job.error ?? 'That video could not be read.')
          setStatus('error')
          setVideoJob(null)
          return null
        }
        if (job.state === 'naming') {
          // Waiting on a person now, so the drawer stops looking busy.
          setStatus('idle')
          return null
        }
        if (job.state === 'done') {
          setVideoJob(null)
          return await adoptVideo(job)
        }
        await new Promise((resume) => setTimeout(resume, 700))
      }
      return null
    },
    [adoptVideo, fail],
  )

  /** Name the shapes an extraction could not, which builds the score. */
  const nameShapes = useCallback(
    async (labels: Record<string, string>) => {
      const current = videoJob
      if (!current) return null
      setStatus('reading')
      setError(null)
      try {
        const job = await nameVideoShapes(current.id, labels)
        setVideoJob(null)
        if (job.state === 'done') return await adoptVideo(job)
        setError(job.error ?? 'That video could not be built into a tab.')
        setStatus('error')
        return null
      } catch (cause) {
        fail(cause, 'Those shape names could not be used.')
        return null
      }
    },
    [adoptVideo, fail, videoJob],
  )

  /** Walk away from an extraction that is waiting to be told about shapes. */
  const cancelVideo = useCallback(() => {
    const current = videoJob
    followingRef.current = null
    setVideoJob(null)
    setStatus('idle')
    if (current) void discardVideoJob(current.id)
  }, [videoJob])

  /**
   * Import from a link: a video, a PDF, or the primitives the video reader writes.
   *
   * A video goes to the local extraction service, since recognising notation in
   * one needs a video decoder and OpenCV. The other two are read here.
   */
  const importUrl = useCallback(
    async (url: string) => {
      setStatus('reading')
      setError(null)
      if (classifyUrl(url) === 'video') {
        setProgress(null)
        try {
          const id = await startVideoExtraction(url)
          followingRef.current = id
          setVideoJob({
            id,
            state: 'queued',
            stage: 'starting',
            progress: null,
            title: '',
            error: null,
            systems: null,
            staves: null,
            shapeCount: null,
            rememberedCount: null,
            autoNamedCount: null,
            unresolvedCount: null,
            shapes: null,
            pages: null,
            unreadCount: null,
      silentTechniqueCount: null,
          })
          return await follow(id)
        } catch (cause) {
          fail(cause, 'That video could not be read.')
          setVideoJob(null)
          return null
        }
      }
      setProgress({ page: 0, total: 0 })
      try {
        const source = await fetchSource(url)
        if (source.kind === 'pdf' && source.file) {
          const { score: next, pages } = await importTabPdf(source.file, {}, (page, total) =>
            setProgress({ page, total }),
          )
          return await adopt(next, pages, source.fileName, { pdf: source.file }, 'url', 'that PDF')
        }
        const pages = source.pages ?? []
        return await adopt(
          parseScore(pages),
          pages,
          source.fileName,
          { primitives: pages },
          'url',
          'that primitives file',
        )
      } catch (cause) {
        fail(cause, 'That link could not be imported.')
        return null
      } finally {
        setProgress(null)
      }
    },
    [adopt, fail, follow],
  )

  /** Persist a changed score against its library entry. */
  const persist = useCallback((current: LibraryEntry | null, next: ParsedScore) => {
    if (!current) return
    void updateTab(entryFor(current.id, next, current.fileName, current.addedAt), next).catch(
      () => {
        // A failed write only costs the change on the next reload.
      },
    )
  }, [])

  const setBpm = useCallback(
    (bpm: number) => {
      setScore((current) => {
        if (!current) return current
        const next = { ...current, bpm }
        persist(entry, next)
        return next
      })
    },
    [entry, persist],
  )

  const setTuningShift = useCallback(
    (tuningShift: number) => {
      setScore((current) => {
        if (!current) return current
        const next = { ...current, tuningShift }
        persist(entry, next)
        return next
      })
    },
    [entry, persist],
  )

  /**
   * Read the open tab again with a different bar length, using the cached page
   * primitives when they are still around and the stored PDF when they are not.
   */
  const setBeatsPerBar = useCallback(
    async (beatsPerBar: number) => {
      const current = entry
      if (!current) return
      let pages = pagesRef.current
      if (!pages) {
        setStatus('reading')
        try {
          const stored = await readTab(current.id)
          // Primitives were stored already decoded, so they cost nothing to reuse.
          // A PDF has to be read through pdf.js again.
          if (stored?.primitives) {
            pages = stored.primitives
          } else if (stored?.pdf) {
            pages = await readTabPdf(new File([stored.pdf], current.fileName), (page, total) =>
              setProgress({ page, total }),
            )
          } else {
            setError('The source for this tab is missing, so it cannot be re-read.')
            setStatus('error')
            return
          }
          pagesRef.current = pages
        } catch (cause) {
          fail(cause, 'That tab could not be read again.')
          return
        } finally {
          setProgress(null)
        }
      }
      const next = parseScore(pages, { beatsPerBar })
      // Tempo and tuning are playback settings, not things to re-read.
      setScore((live) => {
        const merged = live ? { ...next, bpm: live.bpm, tuningShift: live.tuningShift } : next
        persist(current, merged)
        return merged
      })
      setStatus('idle')
    },
    [entry, fail, persist],
  )

  const remove = useCallback(
    async (id: string) => {
      try {
        await deleteTab(id)
        setEntries(await listTabs())
      } catch {
        setError('That tab could not be removed.')
        setStatus('error')
        return
      }
      if (entry?.id === id) {
        pagesRef.current = null
        setEntry(null)
        setScore(null)
        rememberLastOpen(null)
      }
    },
    [entry],
  )

  /** Put the open tab away without deleting it. */
  const close = useCallback(() => {
    pagesRef.current = null
    setEntry(null)
    setScore(null)
    rememberLastOpen(null)
  }, [])

  const dismissError = useCallback(() => {
    setError(null)
    setStatus('idle')
  }, [])

  // Stop polling a job when the app goes away, so an unmounted hook does not
  // keep calling the service.
  useEffect(
    () => () => {
      followingRef.current = null
    },
    [],
  )

  return {
    entries,
    entry,
    score,
    status,
    error,
    progress,
    videoJob,
    videoReady,
    videoNamesShapes,
    checkVideoServer,
    nameShapes,
    cancelVideo,
    importFile,
    importUrl,
    open,
    remove,
    close,
    setBpm,
    setTuningShift,
    setBeatsPerBar,
    dismissError,
  }
}
