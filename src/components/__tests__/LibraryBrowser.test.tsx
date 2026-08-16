// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { LibraryBrowser } from '../LibraryBrowser'
import type { LibraryEntry } from '../../tabpdf/library'

function open(overrides: Partial<Parameters<typeof LibraryBrowser>[0]> = {}) {
  const onImportUrl = vi.fn()
  const onImport = vi.fn()
  const onRename = vi.fn()
  render(
    <LibraryBrowser
      entries={[]}
      openId={null}
      status="idle"
      error={null}
      progress={null}
      onImport={onImport}
      onImportUrl={onImportUrl}
      onOpen={vi.fn()}
      onRename={onRename}
      onRemove={vi.fn()}
      onDismissError={vi.fn()}
      {...overrides}
    />,
  )
  fireEvent.click(screen.getByLabelText('Tab library'))
  return { onImportUrl, onImport, onRename }
}

afterEach(cleanup)

const song = (over: Partial<LibraryEntry> = {}): LibraryEntry => ({
  id: 'a',
  title: 'Bold As Love',
  artist: 'Jimi Hendrix',
  bars: 19,
  noteCount: 129,
  pageCount: 4,
  fileName: 'a.pdf',
  addedAt: 1,
  source: 'pdf',
  version: 1,
  ...over,
})

describe('importing a tab from a link', () => {
  it('hands over the pasted link, without the whitespace that comes with a paste', () => {
    const { onImportUrl } = open()
    const field = screen.getByLabelText('Import a tab from a link')
    fireEvent.change(field, { target: { value: '  https://example.com/tab.pdf  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    expect(onImportUrl).toHaveBeenCalledWith('https://example.com/tab.pdf')
  })

  it('clears the field afterwards so a second link can be pasted straight in', () => {
    open()
    const field = screen.getByLabelText('Import a tab from a link')
    fireEvent.change(field, { target: { value: 'https://example.com/p.json' } })
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    expect((field as HTMLInputElement).value).toBe('')
  })

  it('will not submit an empty field', () => {
    const { onImportUrl } = open()
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled()

    const field = screen.getByLabelText('Import a tab from a link')
    fireEvent.change(field, { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    expect(onImportUrl).not.toHaveBeenCalled()
  })

  it('does not accept another link while one is being read', () => {
    const { onImportUrl } = open({ status: 'reading' })
    const field = screen.getByLabelText('Import a tab from a link')
    expect(field).toBeDisabled()

    fireEvent.change(field, { target: { value: 'https://example.com/tab.pdf' } })
    fireEvent.submit(field)
    expect(onImportUrl).not.toHaveBeenCalled()
  })

  /**
   * Worth saying before someone pastes a video link and waits, because a video
   * takes minutes and asks for shapes to be named partway through — neither of
   * which the field itself suggests.
   */
  it('says a video link is read by the extraction service', () => {
    open()
    expect(screen.getByText(/extraction service/i)).toBeInTheDocument()
    expect(screen.getByText(/name once per font/i)).toBeInTheDocument()
  })

  it('shows what the extraction service is doing while a video is read', () => {
    open({ status: 'reading', videoStage: 'reading system 7', videoProgress: null })
    expect(screen.getByRole('status')).toHaveTextContent('reading system 7')
  })

  it('shows download progress as a percentage', () => {
    open({ status: 'reading', videoStage: 'fetching the video', videoProgress: 0.42 })
    expect(screen.getByRole('status')).toHaveTextContent('42%')
  })

  /**
   * Promising that a video link works when the service is not running would send
   * someone off to wait for something that is never going to happen.
   */
  it('says so when the extraction service is not running', () => {
    open({ videoReady: false })
    expect(screen.getByText(/not running/i)).toBeInTheDocument()
    expect(screen.getByText(/npm run dev/i)).toBeInTheDocument()
  })

  /**
   * The two ways an import goes are a tab straight away and a screenful of
   * shapes to name, and which one it will be is knowable before starting.
   */
  it('says the shapes will be named for you when a model is configured', () => {
    open({ videoReady: true, videoNamesShapes: true })
    expect(screen.getByText(/reads the printed shapes itself/i)).toBeInTheDocument()
  })

  it('says the shapes are yours to name when no model is configured', () => {
    open({ videoReady: true })
    expect(screen.getByText(/shapes to name once per font/i)).toBeInTheDocument()
  })

  it('re-checks the service each time the library is opened', () => {
    const onCheckVideoServer = vi.fn()
    render(
      <LibraryBrowser
        entries={[]}
        openId={null}
        status="idle"
        error={null}
        progress={null}
        onCheckVideoServer={onCheckVideoServer}
        onImport={vi.fn()}
        onImportUrl={vi.fn()}
        onOpen={vi.fn()}
        onRename={vi.fn()}
        onRemove={vi.fn()}
        onDismissError={vi.fn()}
      />,
    )
    expect(onCheckVideoServer).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('Tab library'))
    expect(onCheckVideoServer).toHaveBeenCalled()
  })

  it('still offers the file picker', () => {
    open()
    expect(screen.getByRole('button', { name: /Add a PDF/ })).toBeInTheDocument()
  })
})

describe('telling two readings of one song apart', () => {
  it('labels each row with where it came from', () => {
    open({
      entries: [
        song({ id: 'a', source: 'pdf' }),
        song({ id: 'b', source: 'url', fileName: 'b.json', version: 2 }),
      ],
    })
    expect(screen.getByText('pdf')).toBeInTheDocument()
    expect(screen.getByText('url')).toBeInTheDocument()
  })

  it('numbers the later reading rather than hiding it', () => {
    open({
      entries: [
        song({ id: 'a', version: 1 }),
        song({ id: 'b', fileName: 'b.json', source: 'tab', version: 2 }),
      ],
    })
    // Both readings are listed, and only the later one is numbered.
    expect(screen.getAllByText(/Bold As Love/)).toHaveLength(2)
    expect(screen.getByText(/version 2/)).toBeInTheDocument()
    expect(screen.queryByText(/version 1/)).not.toBeInTheDocument()
  })
})

/**
 * A tab is filed under whatever its source called it — a video's own title, or
 * a file name — which is often not the name of the song. Correcting that should
 * not mean importing it again.
 */
describe('renaming a song', () => {
  function startRename(overrides: Partial<Parameters<typeof LibraryBrowser>[0]> = {}) {
    const handles = open({ entries: [song()], ...overrides })
    fireEvent.click(screen.getByLabelText('Rename Bold As Love'))
    return { ...handles, field: screen.getByLabelText('New name for Bold As Love') }
  }

  it('hands over the typed name, without the whitespace around it', () => {
    const { onRename, field } = startRename()
    fireEvent.change(field, { target: { value: '  Bold as Love  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(onRename).toHaveBeenCalledWith('a', 'Bold as Love')
  })

  it('starts from the name the song already has, so a small fix is a small edit', () => {
    const { field } = startRename()
    expect((field as HTMLInputElement).value).toBe('Bold As Love')
  })

  it('will not save an empty name', () => {
    const { onRename, field } = startRename()
    fireEvent.change(field, { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.submit(field)

    expect(onRename).not.toHaveBeenCalled()
  })

  it('leaves the name alone when the edit is abandoned', () => {
    const { onRename, field } = startRename()
    fireEvent.change(field, { target: { value: 'Something else' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onRename).not.toHaveBeenCalled()
    expect(screen.getByText(/Bold As Love/)).toBeInTheDocument()
  })

  /**
   * Escape is the reflex for backing out of a field, and it would otherwise
   * close the whole library — losing the place as well as the edit.
   */
  it('abandons the edit on Escape without closing the library', () => {
    const { onRename } = startRename()
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onRename).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('New name for Bold As Love')).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Tab library' })).toBeInTheDocument()
  })

  /** Opening the tab while typing its name would throw the edit away. */
  it('does not offer to open the row while its name is being edited', () => {
    startRename()
    expect(screen.queryByText(/19 bars/)).not.toBeInTheDocument()
  })
})
