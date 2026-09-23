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
 * Two halves, because one is not enough:
 *
 *  - **A stack**, because listener order is registration order, which is *mount*
 *    order, which has nothing to do with what is on top. The palette renders
 *    before the New Event dialog and opens after it; neither the DOM nor the
 *    listener list can say which came last, so the layers say so themselves.
 *  - **A claim**, because knowing you are on top does not stop the handler that
 *    ran before you. The first to take an Escape owns it and everything else —
 *    including the rule that Escape leaves focus mode — stands down.
 */

import { useEffect, useRef } from 'preact/hooks'

let serial = 0
const stack: number[] = []

/**
 * Take a place on the stack while `active`, and say whether this layer is on
 * top of it.
 *
 * The answer is a function rather than a value because it is read inside event
 * handlers that were bound when the layer opened, and by then whatever opens
 * over it has not happened yet.
 */
export function useModalLayer(active: boolean): () => boolean {
  const mine = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!active) return
    const id = ++serial
    mine.current = id
    stack.push(id)
    return () => {
      mine.current = undefined
      const at = stack.indexOf(id)
      if (at >= 0) stack.splice(at, 1)
    }
  }, [active])
  return () => {
    const id = mine.current
    /*
     * Failing *open* on purpose. A layer that is somehow not on the stack
     * behaves the way it did before there was one — closing when asked — rather
     * than refusing to close, which is the one outcome worse than closing too
     * much.
     */
    if (id === undefined) return true
    return stack[stack.length - 1] === id
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
