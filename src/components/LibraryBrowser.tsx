import { useCallback, useEffect, useRef, useState } from 'react'
import { Portal } from './Portal'
import type { LibraryEntry } from '../tabpdf/library'
import type { LibraryStatus } from '../hooks/useScoreLibrary'
import styles from './LibraryBrowser.module.css'

interface Props {
  entries: readonly LibraryEntry[]
  openId: string | null
  status: LibraryStatus
  error: string | null
  progress: { page: number; total: number } | null
  /** What the extraction service is doing, when a video is being read. */
  videoStage?: string | null
  /** 0..1 while a video is downloading. */
  videoProgress?: number | null
  /** Whether videos can be read at all; null before it has been checked. */
  videoReady?: boolean | null
  /** Whether a vision model names the printed shapes, so nothing is asked. */
  videoNamesShapes?: boolean
  /** Re-check the service, since it can start and stop under the app. */
  onCheckVideoServer?: () => void
  onImport: (file: File) => void
  onImportUrl: (url: string) => void
  onOpen: (id: string) => void
  onRename: (id: string, title: string) => void
  onRemove: (id: string) => void
  onDismissError: () => void
}

/**
 * A PDF, or the primitives file the video reader writes — which is picked off
 * disk rather than served, since that is where it lands.
 */
function isImportable(file: File): boolean {
  return (
    file.type === 'application/pdf' ||
    /\.pdf$/i.test(file.name) ||
    file.type === 'application/json' ||
    /\.json$/i.test(file.name)
  )
}

/** Short word for where a tab came from, shown against its row. */
const SOURCE_LABEL: Record<LibraryEntry['source'], string> = {
  pdf: 'pdf',
  url: 'url',
  tab: 'tab',
  video: 'video',
}

function describe(entry: LibraryEntry): string {
  const parts = [`${entry.bars} bars`, `${entry.pageCount} ${entry.pageCount === 1 ? 'page' : 'pages'}`]
  // Only worth saying once there is more than one reading of the song.
  if (entry.version > 1) parts.push(`version ${entry.version}`)
  return parts.join(' · ')
}

/**
 * The library of imported tab PDFs: a list to pick from and a way to add more.
 * Dropping a file anywhere on the page imports it too, since that is what people
 * try first, so the drag listeners sit on the window rather than the drawer.
 */
export function LibraryBrowser({
  entries,
  openId,
  status,
  error,
  progress,
  videoStage = null,
  videoProgress = null,
  videoReady = null,
  videoNamesShapes = false,
  onCheckVideoServer,
  onImport,
  onImportUrl,
  onOpen,
  onRename,
  onRemove,
  onDismissError,
}: Props) {
  const [open, setOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  /** The row being renamed, and the name being typed into it. */
  const [renameId, setRenameId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [url, setUrl] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  /** Nested dragenter/dragleave pairs fire constantly; count them instead. */
  const depth = useRef(0)

  const accept = useCallback(
    (list: FileList | null) => {
      const file = list && list.length > 0 ? list[0] : null
      if (file && isImportable(file)) onImport(file)
    },
    [onImport],
  )

  const close = useCallback(() => {
    setOpen(false)
    setConfirmId(null)
    setRenameId(null)
    triggerRef.current?.focus()
  }, [])

  const startRename = useCallback((item: LibraryEntry) => {
    setConfirmId(null)
    setRenameId(item.id)
    setDraft(item.title)
  }, [])

  const commitRename = useCallback(() => {
    const name = draft.trim()
    if (renameId && name.length > 0) onRename(renameId, name)
    setRenameId(null)
  }, [draft, onRename, renameId])

  useEffect(() => {
    const hasFile = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
    const onEnter = (e: DragEvent) => {
      if (!hasFile(e)) return
      depth.current += 1
      setDragging(true)
    }
    const onLeave = (e: DragEvent) => {
      if (!hasFile(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setDragging(false)
    }
    const onOver = (e: DragEvent) => {
      // Without this the browser navigates to the file instead of dropping it.
      if (hasFile(e)) e.preventDefault()
    }
    const onDrop = (e: DragEvent) => {
      if (!hasFile(e)) return
      e.preventDefault()
      depth.current = 0
      setDragging(false)
      accept(e.dataTransfer?.files ?? null)
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [accept])

  // The service can be started or stopped while the app stays open, so its
  // availability is worth re-checking each time the drawer is opened.
  useEffect(() => {
    if (open) onCheckVideoServer?.()
  }, [open, onCheckVideoServer])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      // While a name is being typed, Escape belongs to the field: it abandons
      // the edit rather than the whole library.
      if (renameId) setRenameId(null)
      else close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close, renameId])

  const reading = status === 'reading'

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Tab library"
      >
        <span className={styles.triggerIcon} aria-hidden="true">
          {reading ? '◌' : '❑'}
        </span>
        <span className={styles.triggerLabel}>
          {reading && progress && progress.total > 0
            ? `${progress.page}/${progress.total}`
            : 'library'}
        </span>
        {entries.length > 0 && !reading && (
          <span className={styles.triggerCount}>{entries.length}</span>
        )}
      </button>

      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf,application/json,.json"
        className={styles.input}
        onChange={(e) => {
          accept(e.target.files)
          // Allow re-picking the same file straight after a failure.
          e.target.value = ''
        }}
      />

      {open && (
        <Portal>
          <div className={styles.scrim} onClick={close} aria-hidden="true" />
          <div className={styles.drawer} role="dialog" aria-modal="true" aria-label="Tab library">
            <header className={styles.head}>
              <div className={styles.headText}>
                <span className={styles.headTitle}>Library</span>
                <span className={styles.headSub}>
                  {entries.length === 0
                    ? 'No tabs yet'
                    : `${entries.length} ${entries.length === 1 ? 'tab' : 'tabs'} · kept on this device`}
                </span>
              </div>
              <button
                type="button"
                className={styles.addButton}
                onClick={() => inputRef.current?.click()}
                disabled={reading}
              >
                {reading ? 'Reading…' : '＋ Add a PDF'}
              </button>
            </header>

            <form
              className={styles.urlForm}
              onSubmit={(e) => {
                e.preventDefault()
                const link = url.trim()
                if (link.length === 0 || reading) return
                onImportUrl(link)
                setUrl('')
              }}
            >
              <input
                className={styles.urlInput}
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="…or paste a link to a video or a PDF"
                aria-label="Import a tab from a link"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={reading}
              />
              <button
                type="submit"
                className={styles.urlButton}
                disabled={reading || url.trim().length === 0}
              >
                Import
              </button>
            </form>
            {reading && videoStage ? (
              <p className={styles.urlHint} role="status">
                {videoStage}
                {videoProgress !== null ? ` · ${Math.round(videoProgress * 100)}%` : ''}
              </p>
            ) : videoReady === false ? (
              <p className={styles.urlHint}>
                A PDF link works. Video links need the extraction service, which is not running —
                start it with npm run dev.
              </p>
            ) : videoNamesShapes ? (
              <p className={styles.urlHint}>
                A video link is read by the local extraction service, which reads the printed shapes
                itself. Anything it is unsure of it leaves out and tells you about.
              </p>
            ) : (
              <p className={styles.urlHint}>
                A video link is read by the local extraction service, which shows you the printed
                shapes to name once per font.
              </p>
            )}

            {entries.length === 0 ? (
              <div className={styles.empty}>
                <span className={styles.emptyIcon} aria-hidden="true">
                  ⤓
                </span>
                <p className={styles.emptyText}>
                  Add a tab PDF, or drop one anywhere on the page. It stays on this device and
                  opens instantly next time.
                </p>
              </div>
            ) : (
              <div className={styles.list}>
                {entries.map((item) => {
                  const editing = renameId === item.id
                  const confirming = confirmId === item.id
                  return (
                    <div
                      key={item.id}
                      className={`${styles.row} ${item.id === openId ? styles.rowOn : ''}`}
                    >
                      {editing ? (
                        <form
                          className={styles.renameForm}
                          onSubmit={(e) => {
                            e.preventDefault()
                            commitRename()
                          }}
                        >
                          <input
                            className={styles.renameInput}
                            type="text"
                            autoFocus
                            autoComplete="off"
                            aria-label={`New name for ${item.title}`}
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                          />
                          <button
                            type="submit"
                            className={styles.renameSave}
                            disabled={draft.trim().length === 0}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            className={styles.renameCancel}
                            onClick={() => setRenameId(null)}
                          >
                            Cancel
                          </button>
                        </form>
                      ) : (
                        <>
                          <button
                            type="button"
                            className={styles.rowOpen}
                            onClick={() => {
                              onOpen(item.id)
                              close()
                            }}
                          >
                            <span className={styles.rowTitle}>
                              {item.title}
                              {item.artist && (
                                <>
                                  {' '}
                                  <span className={styles.rowDash}>—</span>{' '}
                                  <span className={styles.rowArtist}>{item.artist}</span>
                                </>
                              )}
                            </span>
                            <span className={styles.rowMeta}>
                              <span className={styles.rowSource}>{SOURCE_LABEL[item.source]}</span>
                              {describe(item)}
                            </span>
                          </button>
                          {!confirming && (
                            <button
                              type="button"
                              className={styles.rename}
                              onClick={() => startRename(item)}
                              aria-label={`Rename ${item.title}`}
                            >
                              ✎
                            </button>
                          )}
                        </>
                      )}
                      {editing ? null : confirming ? (
                        <span className={styles.confirm}>
                          <button
                            type="button"
                            className={styles.confirmYes}
                            onClick={() => {
                              onRemove(item.id)
                              setConfirmId(null)
                            }}
                          >
                            Remove
                          </button>
                          <button
                            type="button"
                            className={styles.confirmNo}
                            onClick={() => setConfirmId(null)}
                          >
                            Keep
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className={styles.remove}
                          onClick={() => setConfirmId(item.id)}
                          aria-label={`Remove ${item.title}`}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </Portal>
      )}

      {dragging && (
        <Portal>
          <div className={styles.dropZone} aria-hidden="true">
            <div className={styles.dropCard}>
              <span className={styles.dropIcon}>⤓</span>
              <span>Drop a tab PDF or primitives file to add it</span>
            </div>
          </div>
        </Portal>
      )}

      {error && (
        <Portal>
          <div className={styles.toast} role="alert">
            <span>{error}</span>
            <button type="button" onClick={onDismissError} aria-label="Dismiss">
              ✕
            </button>
          </div>
        </Portal>
      )}
    </>
  )
}
