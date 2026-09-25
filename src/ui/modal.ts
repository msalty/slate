/**
 * Which layer owns the Escape key.
 *
 * Thirteen components in this app put a keydown listener on the window so that
 * Escape closes them, and until now none of them could tell that another one
 * was on top. Two things then answered the same keypress: opening the palette
 * over a half-filled New Event dialog and pressing Escape closed *both*, taking
 * the draft with it, and the lightbox closed itself while the same Escape also
 * threw focus mode's panels back up behind it.
 *
 * `NotePicker` already had a note about this — "Escape here should close this
 * rather than whatever is behind it" — and solved its own case with a capture
 * listener. This is that idea with somewhere to keep the answer.
 *
 * Three parts, because two were not enough:
 *
 *  - **A stack**, because listener order is registration order, which is *mount*
 *    order, which has nothing to do with what is on top. The palette renders
 *    before the New Event dialog and opens after it; neither the DOM nor the
 *    listener list can say which came last, so the layers say so themselves.
 *  - **A claim**, because knowing you are on top does not stop the handler that
 *    ran before you. The first to take an Escape owns it and everything else —
 *    including the rule that Escape leaves focus mode — stands down.
 *  - **A z-index**, because the keyboard and the eye were answering to different
 *    authorities. Every scrim in the app is `z-index: 50`, so what paints on top
 *    was decided by document order, which is App's fixed list of dialogs. The
 *    palette opened over a half-filled New Event dialog was the top *layer* and
 *    took the keys, while the dialog painted over it: an invisible prompt that
 *    ran a command and replaced the form underneath it. Every layer now takes
 *    its height from the stack, so the thing with the keyboard is the thing you
 *    can see.
 *
 * And it is where the focus goes back to. Every dialog in this app takes the
 * focus when it opens and none of them ever gave it back: dismissing the
 * palette over a half-written capture left the caret on `<body>`, so the next
 * thing typed was either dropped or read as a keyboard shortcut. A layer
 * remembers what was focused when it opened and hands it back on the way out —
 * but only if nobody else has taken it in the meantime, and only if the thing
 * it remembers is out in the open again rather than buried under the next
 * dialog along.
 *
 * Two of them have a *floor* rather than a plain place in the queue. The
 * quick-add sheet and the context menu sat above the rest of the ladder for
 * reasons of their own — the due-date picker is a menu opened from inside that
 * sheet, and a picker underneath the thing that opened it is a picker nobody
 * can use — and the first attempt at this left them out of the stack entirely
 * to keep that. Which reopened the same hole one rung up: a palette opened over
 * the sheet was logically on top at 51 and painted under it at 70. A floor
 * keeps the old relationship without costing recency, because every layer is
 * still at least one above the one below it.
 */

import { useEffect, useRef } from 'preact/hooks'
import type { RefObject } from 'preact'

/**
 * The floors, each one the number its element already carries in the
 * stylesheet. A layer alone on the stack is drawn exactly where it always was.
 */

/** `.scrim` and `.lightbox`: the ordinary dialog. */
export const Z_DIALOG = 50
/** `.qa-root`: the quick-add sheet, over the toast it replaced. */
export const Z_SHEET = 70
/** `.menu-scrim`: a context menu, over the sheet that can open one. */
export const Z_MENU = 80

type Layer = { id: number; floor: number; root: RefObject<HTMLDivElement> }

let serial = 0
const stack: Layer[] = []

/**
 * Re-height everyone, since a layer closing underneath moves what is above it
 * down a step. Each layer is its own floor or one above the layer below it,
 * whichever is higher — so a menu is never under the sheet it was opened from,
 * and nothing is ever under something older than itself.
 *
 * Reading `.current` here rather than caching the node keeps this honest when a
 * dialog swaps its element without ever leaving the stack.
 */
function restack(): void {
  let z = 0
  for (const layer of stack) {
    z = Math.max(layer.floor, z + 1)
    const el = layer.root.current
    if (el) el.style.zIndex = String(z)
  }
}

/**
 * Is `el` out in the open — either nothing is left on the stack, or it belongs
 * to whatever is now on top?
 *
 * Asked at the moment of handing focus back rather than at the moment of
 * closing, because closing one layer is how another gets opened: a menu item
 * that raises a confirmation closes the menu first, and the button that opened
 * the menu is no place for the caret once that confirmation is up.
 */
function exposed(el: HTMLElement): boolean {
  const top = stack[stack.length - 1]
  if (!top) return true
  const root = top.root.current
  return !!root && root.contains(el)
}

/**
 * Give the focus back to whatever had it before this layer opened.
 *
 * In a microtask, for two reasons. The element this layer was holding the focus
 * in may still be in the document when the cleanup runs, and "has anyone else
 * taken the focus" has no answer until it is gone. And anything that means to
 * claim the focus itself does so from a `requestAnimationFrame`, which is later
 * than this, so a layer that knows where the caret belongs still wins.
 */
function returnFocus(from: HTMLElement | null): void {
  if (!from) return
  queueMicrotask(() => {
    const now = document.activeElement
    if (now && now !== document.body && now !== document.documentElement) return
    if (!from.isConnected || !from.getClientRects().length) return
    if (!exposed(from)) return
    from.focus({ preventScroll: true })
  })
}

export type ModalLayer = {
  /**
   * Whether this layer is on top of the stack.
   *
   * A function rather than a value because it is read inside event handlers
   * that were bound when the layer opened, and by then whatever opens over it
   * has not happened yet.
   */
  isTop: () => boolean
  /**
   * Goes on the layer's outermost fixed-position element, which is then painted
   * in stack order. Every layer needs one: an element left out keeps its
   * stylesheet height and is back to disagreeing with the stack about who is on
   * top, which is the whole of what this is for.
   */
  root: RefObject<HTMLDivElement>
}

/**
 * Take a place on the stack while `active`.
 *
 * `floor` is the height the element has in the stylesheet, for the layers that
 * have a reason to sit above the ordinary run of dialogs. It is a minimum, not
 * a position: something opened later is still drawn above.
 */
export function useModalLayer(active: boolean, floor: number = Z_DIALOG): ModalLayer {
  const mine = useRef<number | undefined>(undefined)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!active) return
    const id = ++serial
    mine.current = id
    /*
     * Before anything of this layer's is focused: the effect runs on the commit
     * that mounts it, and every dialog here reaches for its own field a frame
     * later.
     */
    const came = document.activeElement
    const from = came instanceof HTMLElement && came !== document.body ? came : null
    stack.push({ id, floor, root })
    restack()
    return () => {
      mine.current = undefined
      const at = stack.findIndex((l) => l.id === id)
      if (at >= 0) stack.splice(at, 1)
      /*
       * Give the element back its stylesheet height before re-heighting the
       * rest: it may be on its way out, but a dialog that closes and reopens
       * gets the same node back, and a number left on it from last time would
       * outrank whatever is genuinely above.
       */
      if (root.current) root.current.style.zIndex = ''
      restack()
      returnFocus(from)
    }
  }, [active, floor])
  return {
    isTop: () => {
      const id = mine.current
      /*
       * Failing *open* on purpose. A layer that is somehow not on the stack
       * behaves the way it did before there was one — closing when asked —
       * rather than refusing to close, which is the one outcome worse than
       * closing too much.
       */
      if (id === undefined) return true
      return stack[stack.length - 1]?.id === id
    },
    root,
  }
}

/** True while anything modal is on screen. */
export function modalOpen(): boolean {
  return stack.length > 0
}

/**
 * The first handler to claim an Escape owns it; everyone after it stands down.
 *
 * A `WeakSet` because the key is the event object itself, which lives exactly
 * as long as the dispatch does and is then nobody's business.
 */
const claimed = new WeakSet<KeyboardEvent>()

export function claimEscape(e: KeyboardEvent): boolean {
  if (claimed.has(e)) return false
  claimed.add(e)
  return true
}

export function escapeClaimed(e: KeyboardEvent): boolean {
  return claimed.has(e)
}
