/**
 * Writing a due date into the buffer.
 *
 * The vault has `setDue` for the same job, and this is deliberately not it: an
 * open note is edited through its editor, so the change joins the undo history
 * and the normal save cycle instead of racing a whole-file write against
 * whatever is being typed.
 *
 * Every edit here is the smallest one that does the job — the marker's own
 * span, or an append at the end of the line — rather than a rewrite of the
 * line. Replacing a line the caret is sitting in would map the caret to the
 * start of it, which is a strange thing to have happen because you set a date.
 */

import type { EditorView } from '@codemirror/view'
import type { ChangeSpec, EditorState } from '@codemirror/state'
import { findDue, isTaskLine } from '../core/markdown'
import { ymd } from '../core/util'
import { activeEditor, requestDueMenu } from './context'

/** The date on the task line containing `pos`, if it has one. */
export function dueAt(state: EditorState, pos: number): number | undefined {
  const line = state.doc.lineAt(pos)
  return isTaskLine(line.text) ? findDue(line.text)?.date : undefined
}

/**
 * Set (or clear) the due date on the task line containing `pos`.
 *
 * `pos` rather than "the caret" because the picker is a menu: it can be open
 * for a while, and the caret can be somewhere else entirely by the time a date
 * comes back. The position maps through any edits made in between, so the date
 * still lands on the task it was opened for.
 */
export function applyDue(
  pos: number,
  date: number | undefined,
  view: EditorView | null = activeEditor.value,
): boolean {
  if (!view) return false
  const line = view.state.doc.lineAt(pos)
  if (!isTaskLine(line.text)) return false
  const existing = findDue(line.text)
  const marker = date === undefined ? '' : `📅 ${ymd(date)}`

  let changes: ChangeSpec
  if (existing) {
    if (date === undefined) {
      // Take the space in front of the marker with it, or removing a date
      // leaves a trailing one behind.
      const before = /[ \t]*$/.exec(line.text.slice(0, existing.from))![0].length
      changes = { from: line.from + existing.from - before, to: line.from + existing.to }
    } else {
      changes = { from: line.from + existing.from, to: line.from + existing.to, insert: marker }
    }
  } else {
    if (date === undefined) return false
    const pad = /[ \t]$/.test(line.text) ? '' : ' '
    changes = { from: line.to, insert: `${pad}${marker}` }
  }

  view.dispatch({ changes, userEvent: 'input.due' })
  return true
}

/**
 * The ⌘⇧D command: offer a date for the task the caret is on.
 *
 * Returns false on any other line so the key falls through rather than being
 * silently swallowed on a line where it means nothing.
 */
export function setDueAtCaret(view: EditorView): boolean {
  const pos = view.state.selection.main.head
  const line = view.state.doc.lineAt(pos)
  if (!isTaskLine(line.text)) return false
  const coords = view.coordsAtPos(pos)
  const at = coords
    ? { x: coords.left, y: coords.bottom + 4 }
    : (() => {
        const r = view.dom.getBoundingClientRect()
        return { x: r.left + 24, y: r.top + 24 }
      })()
  requestDueMenu(at, pos, dueAt(view.state, pos))
  return true
}
