/**
 * Putting a task list into groups.
 *
 * Two groupings, and the one that was asked for is not among them — on purpose.
 *
 * A task carries the tags on its own line *and* the ones its note carries, so
 * "group by tag" has no single answer: a job that is both `#home` and
 * `#urgent` belongs in two groups, which means a list with the same task in it
 * twice, a tick that has to update both, and counts that no longer sum.
 * Inheritance is what makes task tags worth having and it is exactly what makes
 * grouping by them ambiguous.
 *
 * Due date and note are unambiguous — one date and one note per task — and are
 * the two that actually earn their place:
 *
 *  - **By due** is what "outstanding, overdue" is reaching for, and is how
 *    every task application worth using arranges a list.
 *  - **By note** pays off *because* of inheritance. Tagging a note `#home`
 *    gathers jobs from every note about home, and without grouping they
 *    interleave with the note's name repeated down the side of every row.
 */

import type { TaskItem } from './types'
import { startOfDay } from './util'

export type TaskGroupBy = 'none' | 'due' | 'note'

export interface TaskGroup {
  key: string
  /** Empty when the list is not grouped, so the caller draws no heading. */
  label: string
  items: TaskItem[]
}

const WEEK = 7 * 86_400_000

/**
 * Which band a task falls in. A finished one is "done" whatever its date says:
 * a job that was due last Tuesday and is crossed off is not overdue, it is
 * over.
 */
function dueBucket(t: TaskItem, today: number): string {
  if (t.done) return 'done'
  if (t.due === undefined) return 'none'
  if (t.due < today) return 'overdue'
  if (t.due === today) return 'today'
  if (t.due < today + WEEK) return 'week'
  return 'later'
}

/** Bands in the order they are worth reading, not alphabetically. */
const DUE_BANDS: Array<[string, string]> = [
  ['overdue', 'Overdue'],
  ['today', 'Today'],
  ['week', 'This week'],
  ['later', 'Later'],
  ['none', 'No date'],
  ['done', 'Done'],
]

export function groupTasks(
  items: TaskItem[],
  by: TaskGroupBy,
  today = startOfDay(Date.now()),
): TaskGroup[] {
  if (by === 'none' || !items.length) return [{ key: '', label: '', items }]

  if (by === 'due') {
    const bands = new Map<string, TaskItem[]>()
    for (const t of items) {
      const k = dueBucket(t, today)
      const arr = bands.get(k)
      if (arr) arr.push(t)
      else bands.set(k, [t])
    }
    // Fixed order, and only the bands that have something in them.
    return DUE_BANDS.filter(([k]) => bands.has(k)).map(([key, label]) => ({
      key,
      label,
      items: bands.get(key)!,
    }))
  }

  /*
   * By note, in the order the notes first appear rather than alphabetically:
   * the list arrives already sorted by what is most pressing, and sorting the
   * groups by name would throw that away.
   */
  const byNote = new Map<string, TaskGroup>()
  for (const t of items) {
    const group = byNote.get(t.path)
    if (group) group.items.push(t)
    else byNote.set(t.path, { key: t.path, label: t.noteTitle, items: [t] })
  }
  return [...byNote.values()]
}
