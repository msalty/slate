/** Editor-scoped context: which note is open, so embeds resolve relatively. */

import { signal } from '@preact/signals'
import { Facet } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

export interface NoteContext {
  path: string
}

export const noteContext = Facet.define<NoteContext, NoteContext>({
  combine: (v) => v[0] ?? { path: '' },
})

/**
 * The editor currently on screen.
 *
 * There is only ever one — the editor pane owns it and rebuilds it when the
 * open note changes — and several things outside the editor need to act on it:
 * the format bar, the link dialog, the table controls. Publishing it here keeps
 * those from each having to be handed a getter, and keeps the editor from
 * having to import any UI.
 */
export const activeEditor = signal<EditorView | null>(null)

/** Ask the shell to open a note by wikilink target. */
export function requestOpenLink(target: string, exists: boolean) {
  dispatchEvent(new CustomEvent('slate:open-link', { detail: { target, exists } }))
}

/** Ask the shell to open the lightbox for a vault file. */
export function requestLightbox(path: string) {
  dispatchEvent(new CustomEvent('slate:lightbox', { detail: { path } }))
}

/**
 * A click on an external link. The shell decides what that means: opening it
 * outright with a pointer, or offering open/edit/copy on a touch screen, where
 * there is no second way to reach the link's own text.
 */
export function requestUri(
  url: string,
  at: { x: number; y: number; pos: number; via: 'click' | 'menu' },
) {
  dispatchEvent(new CustomEvent('slate:uri', { detail: { url, ...at } }))
}

/**
 * Ask the shell to open the note's properties form.
 *
 * Clicking a `$(property)` in the body is the second way in to the same form
 * the note's date opens — and the more obvious one, since it is asked for
 * while looking at the value that is wrong or missing.
 */
export function requestProperties() {
  dispatchEvent(new CustomEvent('slate:properties'))
}

/** Ask the shell to open the add/edit-link dialog for the caret's position. */
export function requestLinkDialog() {
  dispatchEvent(new CustomEvent('slate:link-dialog'))
}

/**
 * Ask the shell to open the due-date picker for a task line.
 *
 * The picker is a Preact component and this file is imported by the editor,
 * which never imports UI — so the chip widget asks for one the same way an
 * image asks for the lightbox. `line` is a document position on the task,
 * resolved to a line when the answer comes back, so an edit elsewhere in the
 * note while the picker is open can't land the date on the wrong task.
 */
export function requestDueMenu(at: { x: number; y: number }, pos: number, current?: number) {
  dispatchEvent(new CustomEvent('slate:due', { detail: { ...at, pos, current } }))
}

/**
 * Ask the shell for the menu belonging to a table's row or column.
 *
 * Asked for by the "⋯" handle beside a selected band, which is inside the
 * editor and therefore cannot open a menu itself — the menu is a Preact
 * component, and nothing here imports UI. The band the menu acts on is
 * published in `table.ts`, so only its shape travels with the event.
 */
export function requestTableBandMenu(
  at: { x: number; y: number },
  kind: 'row' | 'col',
  index: number,
) {
  dispatchEvent(new CustomEvent('slate:table-band', { detail: { ...at, kind, index } }))
}
