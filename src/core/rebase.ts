/**
 * Folding an externally-arrived version of a note into the buffer someone is
 * currently typing in.
 *
 * The vault can change under an open editor at any moment: a sync pull, a
 * restore from version history, a checkbox toggled from the note list. The
 * editor holds its own copy of the text in a CodeMirror document, and that copy
 * is what the next keystroke saves. So an editor that ignores a change made
 * beneath it does not merely show something stale — it writes the stale text
 * back over the new one, which on two machines editing the same note is an
 * endless mutual overwrite.
 *
 * The rule here is the same one the sync engine follows: never drop content.
 * Where the buffer has no unsaved edits the incoming text simply wins; where it
 * does, the two are merged against the last text buffer and vault agreed on.
 */

import { merge3 } from './merge'

export interface RebaseResult {
  /** What the buffer should hold after folding the incoming text in. */
  text: string
  /** True when the buffer needs updating — i.e. `text` differs from `buffer`. */
  changed: boolean
  /** True when unsaved edits overlapped the incoming ones and markers were added. */
  conflicted: boolean
}

/**
 * Reconcile a live buffer with a new version of the same note.
 *
 * `base` is the text the buffer and the vault last agreed on, `buffer` is what
 * the editor holds right now (possibly with edits too recent to have been
 * saved), and `incoming` is what the vault now holds.
 */
export function rebaseBuffer(base: string, buffer: string, incoming: string): RebaseResult {
  if (buffer === incoming) return { text: buffer, changed: false, conflicted: false }
  // Nothing actually arrived from outside; the buffer is simply ahead.
  if (incoming === base) return { text: buffer, changed: false, conflicted: false }
  // No unsaved edits, so there is nothing to merge: take the new text whole.
  if (buffer === base) return { text: incoming, changed: true, conflicted: false }

  // Unsaved keystrokes and an incoming change at the same time. Merge them, and
  // where they touched the same lines leave markers rather than choose: the
  // note is open in front of the user, who is the best-placed thing in the
  // system to resolve it, and both texts are still there to resolve from.
  const m = merge3(base, buffer, incoming, {
    markers: true,
    labelMine: 'your unsaved edit',
    labelTheirs: 'synced from another device',
  })
  return { text: m.merged, changed: m.merged !== buffer, conflicted: m.conflict }
}

/**
 * The smallest single-range replacement turning `a` into `b`.
 *
 * Applying the narrowest possible change is what keeps the caret, the
 * selection, the scroll position and the undo history intact when text arrives
 * from elsewhere: an edit far from the caret does not move it at all.
 */
export function minimalEdit(
  a: string,
  b: string,
): { from: number; to: number; insert: string } | undefined {
  if (a === b) return undefined

  const min = Math.min(a.length, b.length)
  let pre = 0
  while (pre < min && a.charCodeAt(pre) === b.charCodeAt(pre)) pre++
  // Never split a surrogate pair: half of an astral character is not text.
  if (pre > 0 && isHigh(a.charCodeAt(pre - 1))) pre--

  let suf = 0
  while (suf < min - pre && a.charCodeAt(a.length - 1 - suf) === b.charCodeAt(b.length - 1 - suf))
    suf++
  if (suf > 0 && isLow(a.charCodeAt(a.length - suf))) suf--

  return { from: pre, to: a.length - suf, insert: b.slice(pre, b.length - suf) }
}

function isHigh(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff
}

function isLow(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff
}
