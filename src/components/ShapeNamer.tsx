import { useMemo, useState } from 'react'
import { Portal } from './Portal'
import type { VideoJob } from '../tabpdf/videoServer'
import styles from './ShapeNamer.module.css'

interface Props {
  job: VideoJob
  busy: boolean
  onSubmit: (labels: Record<string, string>) => void
  onCancel: () => void
}

/**
 * What may be typed against a shape: a fret number, a muted note, a ghost
 * note's brackets — or a technique the engraver fused into one mark. Video
 * fonts print a hammer-on as a small digit against a full one (`4h6`), a slide
 * as a dash beside its number (`12-`, `-12`, or a lone `-`), a pull-off as
 * an arc over the pair (`4p2`; a lone arc is `~`, an arc fused to its digit is
 * `4~` or `~4`), and a bend as an up arrow beside its number (`12b`, or a lone
 * `b` for the arrow by itself). Every prefix of a valid name must also pass,
 * because this is tested on each keystroke.
 *
 * A slide may also be written `/` or `\`, which is what the tab itself prints
 * for one and so what people reach for. It means exactly what a dash means: the
 * direction is read from the frets, never from the name. Refusing the keystroke
 * silently, which is what happened before, looks like a broken text box.
 */
const ALLOWED = /^(\d{1,2}([hp]\d{0,2}|-{1,2}|[/\\]|~|b)?|(-{1,2}|[/\\])\d{0,2}|~\d{0,2}|[xX()b])?$/

/**
 * Naming the shapes found in a video.
 *
 * This opens when something is left to name: either no vision model is
 * configured for the reader, or one was and it would not commit to these shapes.
 * A name it did read is filled in but marked as a suggestion, because it has not
 * been checked by anyone and a wrong name becomes a wrong note everywhere that
 * shape occurs — an empty box is the better answer whenever a shape is not
 * clearly a number, since an empty one is counted and reported.
 *
 * Shapes are listed commonest first and the running total says how much of the
 * notation is covered, because the tail is long — mostly slur and beam fragments —
 * and there is a point where naming more stops mattering.
 */
export function ShapeNamer({ job, busy, onSubmit, onCancel }: Props) {
  const shapes = useMemo(() => job.shapes ?? [], [job.shapes])
  const [typed, setTyped] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (job.shapes ?? [])
        .filter((shape) => shape.label !== null)
        .map((shape) => [String(shape.index), shape.label as string]),
    ),
  )

  const total = useMemo(() => shapes.reduce((sum, shape) => sum + shape.count, 0), [shapes])
  const covered = useMemo(
    () =>
      shapes
        .filter((shape) => (typed[String(shape.index)] ?? '').length > 0)
        .reduce((sum, shape) => sum + shape.count, 0),
    [shapes, typed],
  )
  const named = Object.values(typed).filter((value) => value.length > 0).length

  return (
    <Portal>
      <div className={styles.scrim} aria-hidden="true" />
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label="Name the shapes found in the video"
      >
        <header className={styles.head}>
          <div className={styles.headText}>
            <span className={styles.headTitle}>{job.title || 'Video'}</span>
            <span className={styles.headSub}>
              {job.systems ?? 0} systems · {shapes.length} distinct shapes
              {job.rememberedCount ? ` · ${job.rememberedCount} already known` : ''}
              {job.autoNamedCount ? ` · ${job.autoNamedCount} read automatically` : ''}
            </span>
          </div>
          <button type="button" className={styles.cancel} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </header>

        <p className={styles.explain}>
          Type what each shape says. Techniques have names too: a small digit fused to a full one
          is a hammer-on (<code>4h6</code>), an arc over a pair is a pull-off (<code>4p2</code>, a
          lone arc is <code>~</code>), a dash beside a number is a slide (<code>12-</code>, a lone
          dash is <code>-</code> or <code>/</code>), an up arrow is a bend (<code>12b</code>, a lone
          arrow is <code>b</code>), and <code>x</code> is a muted note. Slur arcs and slide dashes
          look alike once shrunk to the same box, so one shape often holds both — naming it{' '}
          <code>~</code> or <code>-</code> covers them either way, because each mark's own curve
          decides which it is. Leave anything else empty —
          an empty box is counted while a wrong name becomes a wrong note everywhere that shape
          appears. Names are remembered, so the next video in this font needs none of this.
          {job.autoNamedCount ? (
            <>
              {' '}
              Boxes with a dashed edge were read automatically and nobody has checked them; correct
              any that look wrong, and your answer is the one that gets remembered.
            </>
          ) : null}
        </p>

        <div className={styles.meter}>
          <div className={styles.meterBar}>
            <div
              className={styles.meterFill}
              style={{ width: `${total > 0 ? (covered / total) * 100 : 0}%` }}
            />
          </div>
          <span className={styles.meterText}>
            {named} named · {total > 0 ? Math.round((covered / total) * 100) : 0}% of the notation
          </span>
        </div>

        <div className={styles.grid}>
          {shapes.map((shape) => {
            const key = String(shape.index)
            const value = typed[key] ?? ''
            return (
              <label
                key={key}
                className={`${styles.cell} ${shape.remembered ? styles.cellKnown : ''} ${
                  shape.suggested ? styles.cellSuggested : ''
                }`}
                title={shape.suggested ? 'Read automatically — check this one' : undefined}
              >
                {shape.png ? (
                  <img
                    className={styles.shape}
                    src={`data:image/png;base64,${shape.png}`}
                    alt={`Shape ${shape.index}, appearing ${shape.count} times`}
                  />
                ) : (
                  <span className={styles.shapeMissing} aria-hidden="true">
                    ?
                  </span>
                )}
                <input
                  className={styles.entry}
                  type="text"
                  inputMode="text"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={5}
                  value={value}
                  disabled={busy}
                  aria-label={`Name for shape ${shape.index}, which appears ${shape.count} times`}
                  onChange={(e) => {
                    const next = e.target.value
                    if (!ALLOWED.test(next)) return
                    setTyped((current) => ({ ...current, [key]: next.toLowerCase() }))
                  }}
                />
                <span className={styles.count}>×{shape.count}</span>
              </label>
            )
          })}
        </div>

        <footer className={styles.foot}>
          <span className={styles.footNote}>
            {named === 0
              ? 'Name at least the commonest shapes to get a tab.'
              : 'Anything left empty is reported as unread, not guessed.'}
          </span>
          <button
            type="button"
            className={styles.build}
            disabled={busy || named === 0}
            onClick={() => onSubmit(typed)}
          >
            {busy ? 'Building…' : 'Build the tab'}
          </button>
        </footer>
      </div>
    </Portal>
  )
}
