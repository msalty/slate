/**
 * Dragging a note onto a folder.
 *
 * The pointer half of *Move to…*. Long-press → **Move to…** is still the whole
 * of the feature on touch — a drag with a finger is a scroll, and no amount of
 * cleverness makes a list that scrolls also a list you can pick things up from
 * — so this adds a second way to do the same thing, on the one input device
 * where dragging is natural, and changes nothing about the first.
 *
 * Two details are worth spelling out:
 *
 * **The dragged path is kept here, not read from the drop target.** A browser
 * hides `dataTransfer`'s contents during `dragover` (only the *types* are
 * readable), so a folder row deciding whether to light up has no way to ask
 * what is being dragged. The signal answers that, and the payload still goes on
 * the drag itself so a drop is never acted on from stale state.
 *
 * **A folder never accepts a note it already holds.** Nothing happens, so the
 * row says nothing will happen.
 */

import { signal } from '@preact/signals'
import { moveNoteToFolder } from '../core/folders'
import { dirname } from '../core/util'
import { activePath, notify } from './state'

/** Our own type, so a file dragged in from the desktop is never mistaken for one. */
const MIME = 'application/x-slate-note'

/** The note being dragged, or null. Read by every drop target while it hovers. */
export const draggingNote = signal<string | null>(null)

/** Props for a note row: makes it a drag source. */
export function noteDragProps(path: string) {
  return {
    draggable: true,
    onDragStart: (e: DragEvent) => {
      draggingNote.value = path
      const dt = e.dataTransfer
      if (!dt) return
      dt.effectAllowed = 'move'
      dt.setData(MIME, path)
      // A plain-text flavour as well, so dragging a note into another app
      // drops something legible rather than nothing at all.
      dt.setData('text/plain', path)
    },
    onDragEnd: () => {
      draggingNote.value = null
    },
  }
}

/** True when the note in flight would actually move by landing here. */
export function acceptsDrop(folder: string): boolean {
  const path = draggingNote.value
  return !!path && dirname(path) !== folder
}

/**
 * Props for a folder row: makes it a drop target.
 *
 * `data-drop` is the highlight, set straight on the element rather than through
 * state: `dragenter`/`dragleave` fire for every child element the pointer
 * crosses, and re-rendering the sidebar on each of them would be both slower
 * and — because the events arrive out of order — wrong.
 */
export function folderDropProps(folder: string, onDropped?: (dest: string) => void) {
  const lit = (el: EventTarget | null, on: boolean) => {
    if (el instanceof HTMLElement) {
      if (on) el.dataset.drop = '1'
      else delete el.dataset.drop
    }
  }

  return {
    onDragOver: (e: DragEvent) => {
      if (!acceptsDrop(folder)) return
      // Preventing the default is what makes an element a drop target at all.
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      lit(e.currentTarget, true)
    },
    onDragEnter: (e: DragEvent) => {
      if (acceptsDrop(folder)) lit(e.currentTarget, true)
    },
    onDragLeave: (e: DragEvent) => lit(e.currentTarget, false),
    onDrop: async (e: DragEvent) => {
      lit(e.currentTarget, false)
      const path = e.dataTransfer?.getData(MIME) || draggingNote.value
      draggingNote.value = null
      if (!path || dirname(path) === folder) return
      e.preventDefault()
      const dest = await moveNoteToFolder(path, folder)
      if (dest === path) return
      // The note that moved is the one you are looking at, often enough that
      // following it is worth doing unconditionally: the alternative is the
      // editor holding a path that no longer exists.
      if (activePath.value === path) activePath.value = dest
      notify(`Moved to ${folder || 'the vault root'}`)
      onDropped?.(dest)
    },
  }
}
