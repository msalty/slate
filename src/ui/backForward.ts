/**
 * Where you have just been — the two arrows beside the note's title.
 *
 * A vault is a web of links, and reading one follows the same shape as reading
 * anything else: a wikilink, a backlink, a task in the calendar, and three notes
 * later you want the one you started from. The note list cannot give you that —
 * it is sorted by date, not by where you have been — so this is a browser's
 * back and forward, over the notes this window has opened.
 *
 * It watches `activePath` rather than wrapping `openNote`, and that is the whole
 * reason it is reliable: a dozen places open a note, several of them by
 * assigning the signal directly — the list, a backlink row, the calendar, the
 * palette, a link followed inside the text — and every one of them lands here
 * without having to know this file exists.
 *
 * Nothing here is persisted. A trail belongs to a window and a sitting, the same
 * way a browser's does; a popped-out note keeps its own, being its own window.
 */

import { computed, effect, signal } from '@preact/signals'
import { getEntry, revision } from '../core/vault'
import { activePath, openNote } from './state'

/**
 * Deep enough that "the note I was on ten minutes ago" is still there, shallow
 * enough that the arrays stay small. Nobody navigates backwards fifty notes.
 */
const MAX = 50

const back = signal<readonly string[]>([])
const forward = signal<readonly string[]>([])

/** The note being shown, as far as the trail is concerned. */
let current: string | undefined

/**
 * A jump this file asked for, which must move along the trail rather than
 * pushing onto it. Compared by path rather than held as a flag, so it is
 * correct however the signal write is scheduled.
 */
let jumping: string | undefined

/*
 * Module-level, like the layout watchers: there is one trail per window and it
 * lasts as long as the window does, so there is nothing to install or tear down.
 */
effect(() => {
  const p = activePath.value
  /*
   * Nothing open is not a place. A note being deleted empties the pane, and
   * that must not push the deleted note onto the trail or clear where you were
   * — the whole point of Back, at that moment, is the note before this one.
   */
  if (p === undefined || p === current) return
  if (p === jumping) {
    jumping = undefined
    current = p
    return
  }
  if (current !== undefined) {
    back.value = [...back.value, current].slice(-MAX)
    // Going somewhere new abandons the branch you had gone forward into,
    // exactly as it does in a browser.
    forward.value = []
  }
  current = p
})

/**
 * The first entry from the end of a stack that is still a note.
 *
 * Renaming writes a new path and deleting moves one, so a trail collects paths
 * that have nothing behind them any more. Rather than trying to follow every
 * note's every move, the stale ones are simply skipped over on the way past —
 * which is also what keeps a button from offering a note that is not there.
 */
function liveTop(stack: readonly string[]): string | undefined {
  for (let i = stack.length - 1; i >= 0; i--) if (getEntry(stack[i])) return stack[i]
  return undefined
}

/** Where Back would take you, or undefined when it has nowhere to go. */
export const backTarget = computed(() => {
  revision.value
  return liveTop(back.value)
})

export const forwardTarget = computed(() => {
  revision.value
  return liveTop(forward.value)
})

function step(from: typeof back, to: typeof forward) {
  const stack = [...from.value]
  while (stack.length) {
    const p = stack.pop()!
    if (!getEntry(p)) continue
    from.value = stack
    // The note being left joins the other stack, so the two arrows are each
    // other's undo. A note that has since gone is not worth going back to.
    if (current !== undefined && getEntry(current)) to.value = [...to.value, current].slice(-MAX)
    jumping = p
    openNote(p)
    return
  }
  // Everything left in it has been renamed or deleted.
  from.value = []
}

export function goBack(): void {
  step(back, forward)
}

export function goForward(): void {
  step(forward, back)
}
