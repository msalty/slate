/**
 * Reading a note, and the tap that turns it back into something you write in.
 *
 * A note opens as a page: no caret anywhere in it, and therefore no keyboard
 * climbing up over the first thing you wanted to look at. Everything else about
 * the note still works — links go somewhere, checkboxes tick, images open, a
 * version arriving from a sync pull still folds in — because reading is not
 * read-only. It is `EditorView.editable`, and nothing else: `false` takes
 * `contenteditable` off the content DOM, which is the only thing a phone
 * consults when deciding whether to raise its keyboard.
 *
 * `EditorState.readOnly` is deliberately NOT set with it. That one refuses
 * changes, and a note being read still has to accept the ones that are not
 * typing: a task ticked off in passing, a merge landing from another device.
 * Recently Deleted is the place that really is read-only, and it sets both.
 */

import { Compartment } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { linkElementAt } from './linkClicks'

/** Holds `EditorView.editable`, so reading and writing swap without a rebuild. */
export const editableCompartment = new Compartment()

/** The compartment's contents, for the initial state and for every swap. */
export function editableFacet(editable: boolean) {
  return EditorView.editable.of(editable)
}

/**
 * Start editing, with the caret where the tap landed: the gesture that decides
 * to write is the same one that decides where, exactly as it would be if the
 * note had been editable all along.
 *
 * Without coordinates — the header's Edit button — the caret goes to the top of
 * what is on screen instead, so asking to write never scrolls the note out from
 * under the person who asked.
 */
export function beginEditing(
  view: EditorView,
  at?: { x: number; y: number },
  keepCaret = false,
): void {
  const box = view.scrollDOM.getBoundingClientRect()
  const coords = at ?? { x: box.left + 8, y: box.top + 8 }
  /*
   * `false` means "the nearest position", not "only if this is on text": a tap
   * in the empty space under the last line is aimed at the end of the note, and
   * a precise lookup there would return nothing at all.
   */
  const pos = keepCaret ? view.state.selection.main.head : view.posAtCoords(coords, false)
  view.dispatch({
    effects: editableCompartment.reconfigure(editableFacet(true)),
    selection: { anchor: Math.min(Math.max(pos, 0), view.state.doc.length) },
    // Live preview reveals syntax only where the user is actually working, and
    // a pointer selection is what counts as having started.
    userEvent: 'select.pointer',
    scrollIntoView: false,
  })
  view.focus()
}

/** Hand the note back as a page: caret gone, and with it the keyboard. */
export function endEditing(view: EditorView): void {
  // Whatever holds focus, not just the content: in a table that is a cell,
  // which is its own editing host and would keep the keyboard up on its own.
  const active = document.activeElement
  if (active instanceof HTMLElement && view.dom.contains(active)) active.blur()
  else view.contentDOM.blur()
  view.dispatch({ effects: editableCompartment.reconfigure(editableFacet(false)) })
}

/** A drag is a scroll or a text selection, not a tap on what it started on. */
const TAP_SLOP = 10

/**
 * And neither is a press held long enough to be a long-press: that is the
 * gesture both phone platforms use to select text, and answering it with a
 * caret would throw away the selection the finger was still making.
 */
const TAP_MS = 600

/**
 * The parts of a note that answer a tap themselves: a link goes somewhere, a
 * checkbox ticks, an image opens full screen, a code block's copy button puts
 * the code on the clipboard. None of them is a request to start writing, and a
 * note you cannot read through without falling into the editor is not a reading
 * mode.
 *
 * Preventing the mouse events is not enough to stay off this list. The tap is
 * watched as a pointerdown/pointerup pair — that is what a phone actually
 * sends, and what arrives before the mouse events it synthesises afterwards —
 * so a control that swallows `mousedown` is still, as far as this is
 * concerned, a tap on the note.
 */
const SELF_HANDLED = '.cm-task-checkbox, .cm-embed, .cm-code-copy'

/** A table is content, not a control — but it places its own caret. */
const TABLE = '.cm-table-wrap'

function closest(target: EventTarget | null, selector: string): boolean {
  return !!(target as HTMLElement | null)?.closest?.(selector)
}

/**
 * Watch for the tap that starts editing.
 *
 * Listening on the editor's own element rather than its content, because the
 * space below the last line is most of a short note on a phone, and a tap there
 * is as much "I want to write in this" as a tap on the text is.
 */
export function installTapToEdit(
  view: EditorView,
  begin: (at: { x: number; y: number }, keepCaret: boolean) => void,
): () => void {
  let down: { x: number; y: number; at: number } | null = null

  const onDown = (e: PointerEvent) => {
    down = e.button === 0 ? { x: e.clientX, y: e.clientY, at: Date.now() } : null
  }
  const onUp = (e: PointerEvent) => {
    const start = down
    down = null
    if (!start || e.button !== 0) return
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > TAP_SLOP) return
    if (Date.now() - start.at > TAP_MS) return
    if (linkElementAt(e.target) || closest(e.target, SELF_HANDLED)) return
    /*
     * A table has already answered this same press by putting the caret on the
     * row that was touched, which is better aimed than a coordinate on a block
     * the caret cannot enter. Keep it.
     */
    begin({ x: e.clientX, y: e.clientY }, closest(e.target, TABLE))
  }

  view.dom.addEventListener('pointerdown', onDown)
  view.dom.addEventListener('pointerup', onUp)
  return () => {
    view.dom.removeEventListener('pointerdown', onDown)
    view.dom.removeEventListener('pointerup', onUp)
  }
}
