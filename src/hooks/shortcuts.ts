/**
 * Who a keystroke belongs to, for the app-wide shortcuts.
 *
 * The shortcuts listen on the window, so every keystroke anywhere on the page
 * reaches them — including ones a field or a button has already claimed.
 */

/** Elements that take every key given to them. */
const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/** Keys the browser already uses to activate whatever has focus. */
const ACTIVATION_KEYS = new Set([' ', 'Enter'])

/**
 * Whether whatever has focus has already claimed this keystroke.
 *
 * A field claims everything. A button or a link claims only Space and Enter, the
 * keys that press it — which matters for the transport: the browser is about to
 * click the focused button anyway, so acting on the same press would start and
 * stop the audio in one go.
 */
export function keystrokeIsTaken(key: string, target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (TYPING_TAGS.has(target.tagName) || target.isContentEditable) return true
  if (!ACTIVATION_KEYS.has(key)) return false
  return target.closest('a, button, summary, [role="button"]') !== null
}

/**
 * Whether a modal overlay is up — the library, the tuner, a sheet of shapes.
 *
 * Playing a scale from behind one is the app answering a key the overlay was
 * meant to have.
 */
export function overlayIsOpen(doc: Document): boolean {
  return doc.querySelector('[role="dialog"][aria-modal="true"]') !== null
}
