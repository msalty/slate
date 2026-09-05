/**
 * Back and forward, at the left of the editor's header.
 *
 * Two arrows, disabled when there is nowhere to go, each naming where it would
 * take you — the tooltip is the point of them: "back" is only useful if you can
 * tell what you are going back to without pressing it first.
 *
 * Not rendered on a phone. The compact header already has a back arrow in that
 * position and it means something else — it closes the note and returns to the
 * list — and two backs side by side, one of them a different kind of back, is
 * worse than not having the second one.
 */

import { getEntry } from '../core/vault'
import { backTarget, forwardTarget, goBack, goForward } from './backForward'
import { IconChevronLeft, IconChevronRight } from './Icons'

function titleOf(path: string): string {
  return getEntry(path)?.title ?? ''
}

export function NoteNav() {
  const back = backTarget.value
  const forward = forwardTarget.value
  return (
    <div class="editor-nav">
      <button
        class="icon-btn"
        aria-label="Back"
        title={back ? `Back to “${titleOf(back)}”` : 'Back'}
        disabled={!back}
        onClick={goBack}
      >
        <IconChevronLeft size={18} />
      </button>
      <button
        class="icon-btn"
        aria-label="Forward"
        title={forward ? `Forward to “${titleOf(forward)}”` : 'Forward'}
        disabled={!forward}
        onClick={goForward}
      >
        <IconChevronRight size={18} />
      </button>
    </div>
  )
}
