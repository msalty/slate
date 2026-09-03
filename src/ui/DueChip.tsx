/**
 * The due date on a task row, as a control rather than a caption.
 *
 * A task line has two things you can act on and they sit at either end: the
 * checkbox that says whether it's done, and this, which says when it's for.
 * Both mutate the markdown they came from. Filled when the task has a date,
 * a ghost outline when it hasn't — the slot is kept either way so a column of
 * tasks lines up and the dates in it can be read down the edge.
 *
 * The editor draws the same chip as a CodeMirror widget in `widgets.ts`. The
 * two can't share markup — one is Preact, the other builds DOM by hand — so
 * they share the class names and the label instead, exactly as the checkbox
 * already does.
 */

import { dueLabel, dueTone, startOfDay } from '../core/util'
import { openDueMenu, anchorOf } from './DueMenu'
import { IconCalendar } from './Icons'

interface Props {
  due: number | undefined
  onPick: (date: number | undefined) => void
  /** Names the task, so the button reads as more than "Due date" in a list. */
  label: string
}

export function DueChip({ due, onPick, label }: Props) {
  const today = startOfDay(Date.now())
  return (
    <button
      class="due-chip"
      data-set={due === undefined ? '0' : '1'}
      data-tone={due === undefined ? undefined : dueTone(due, today)}
      title={due === undefined ? 'Set a due date' : `Due ${dueLabel(due, today)}`}
      aria-label={
        due === undefined ? `Set a due date for ${label}` : `Due ${dueLabel(due, today)}: ${label}`
      }
      onClick={(e) => {
        // The row behind this opens the note; the chip is its own target.
        e.stopPropagation()
        openDueMenu(anchorOf(e.currentTarget as Element), due, onPick)
      }}
    >
      {due === undefined ? <IconCalendar size={13} /> : dueLabel(due, today)}
    </button>
  )
}
