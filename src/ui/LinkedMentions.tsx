/**
 * What links here, at the end of the note.
 *
 * This used to be a strip along the bottom of the editor pane with a scrollbar
 * of its own, which meant every note — including the great majority nothing
 * points at — was written in a shorter window than the one on screen. It is
 * rendered into the slot the editor hangs past the last line instead (see
 * editor/footer.ts): out of the way until somebody reads to the end of the
 * note, and then simply there, under the text, in the note's own scroll.
 *
 * Quiet by design. A hairline, a muted heading and the count — no toolbar, no
 * sorting, no search. It is a footnote about the note, not a second pane.
 */

import { signal } from '@preact/signals'
import type { NoteIndexEntry } from '../core/types'
import { backlinkMap, getEntry } from '../core/vault'
import { openNote } from './state'
import { IconChevron } from './Icons'

/**
 * Open or folded, remembered for this tab and this tab only.
 *
 * Not an app setting: which way somebody left a disclosure is about the window
 * in front of them rather than about the vault, and syncing it would have one
 * device fold the list away on another mid-sentence. Session storage is per-tab
 * and goes when the tab does, which is the lifetime being remembered — a reload
 * in the middle of reading comes back the way it was left.
 *
 * Open to begin with: the list costs no height now that it is in the flow, and
 * arriving at the end of a note to find the mentions already there is what the
 * old strip did well.
 */
const KEY = 'slate:mentions-open'

function remembered(): boolean {
  try {
    return sessionStorage.getItem(KEY) !== '0'
  } catch {
    /* Private mode, or storage refused. The default is a fine answer. */
    return true
  }
}

const open = signal(remembered())

function setOpen(want: boolean) {
  open.value = want
  try {
    sessionStorage.setItem(KEY, want ? '1' : '0')
  } catch {
    /* Only the memory of it is lost. */
  }
}

export function LinkedMentions({ path }: { path: string }) {
  /*
   * Entries, not paths: a backlink from a note that has since been deleted is
   * a row with nothing to draw, and it must not be counted in the header
   * either — "3" over two rows is the kind of thing people notice.
   */
  const mentions = (backlinkMap.value.get(path) ?? [])
    .map((p) => getEntry(p))
    .filter((e): e is NoteIndexEntry => !!e)
  if (!mentions.length) return null

  const shown = open.value
  return (
    <div class="mentions">
      {/*
       * The count is inside the button rather than beside it, so what a screen
       * reader announces is the whole label — "Linked mentions 3, collapsed" —
       * and so the number is part of the target a thumb is aiming at.
       */}
      <button class="mentions-head" aria-expanded={shown} onClick={() => setOpen(!shown)}>
        <span class="disclose" data-open={shown}>
          <IconChevron size={11} />
        </span>
        {/*
         * The space between the two is a real text node, not the flex gap: a
         * gap is layout, and the name a screen reader reads out is the text.
         */}
        <span class="mentions-title">Linked mentions</span>{' '}
        <span class="mentions-count">{mentions.length}</span>
      </button>
      {shown && (
        <div class="mentions-list">
          {mentions.map((e) => (
            // `openNote`, not a bare assignment to the active path: this is an
            // ordinary navigation, and it has to move the phone to the editor
            // and leave a trail for Back exactly like every other one.
            <button key={e.path} class="mention-row" onClick={() => openNote(e.path)}>
              <span class="mention-title">{e.title}</span>
              {!!e.excerpt && <span class="mention-excerpt">{e.excerpt}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
