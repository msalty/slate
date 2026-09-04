/** Arranging a task list into groups. */

import { describe, expect, it } from 'vitest'
import { dueByToday, groupTasks, tasksDueOn } from './taskgroups'
import { startOfDay } from './util'
import type { TaskItem } from './types'

const TODAY = startOfDay(Date.now())
const DAY = 86_400_000

let n = 0
const task = (over: Partial<TaskItem> = {}): TaskItem => ({
  id: `t${++n}`,
  path: 'Home/Kitchen.md',
  noteTitle: 'Kitchen',
  folder: 'Home',
  line: n,
  text: `Task ${n}`,
  done: false,
  tags: [],
  ownTags: [],
  ...over,
})

const shape = (items: TaskItem[], by: 'none' | 'due' | 'note') =>
  groupTasks(items, by, TODAY).map((g) => [g.label, g.items.length])

describe('not grouping', () => {
  it('hands the list back in one unlabelled group', () => {
    const items = [task(), task()]
    const out = groupTasks(items, 'none', TODAY)
    expect(out).toHaveLength(1)
    expect(out[0].label).toBe('')
    expect(out[0].items).toBe(items)
  })

  it('survives an empty list', () => {
    expect(groupTasks([], 'due', TODAY)).toEqual([{ key: '', label: '', items: [] }])
  })
})

describe('by due date', () => {
  const spread = [
    task({ due: TODAY - 3 * DAY }),
    task({ due: TODAY }),
    task({ due: TODAY + 2 * DAY }),
    task({ due: TODAY + 30 * DAY }),
    task({}),
  ]

  it('bands them the way they are worth reading, not alphabetically', () => {
    expect(shape(spread, 'due')).toEqual([
      ['Overdue', 1],
      ['Today', 1],
      ['This week', 1],
      ['Later', 1],
      ['No date', 1],
    ])
  })

  it('leaves out a band with nothing in it', () => {
    expect(shape([task({ due: TODAY })], 'due')).toEqual([['Today', 1]])
  })

  /*
   * A job that was due last Tuesday and is crossed off is not overdue, it is
   * over. Bucketing purely on the date would file it under Overdue for ever.
   */
  it('files a finished task under Done whatever its date says', () => {
    expect(shape([task({ due: TODAY - 5 * DAY, done: true })], 'due')).toEqual([['Done', 1]])
  })

  it('puts Done last, after everything still to do', () => {
    const out = shape([task({ done: true }), task({ due: TODAY })], 'due')
    expect(out).toEqual([
      ['Today', 1],
      ['Done', 1],
    ])
  })

  it('treats the seventh day out as later, not this week', () => {
    expect(shape([task({ due: TODAY + 7 * DAY })], 'due')).toEqual([['Later', 1]])
    expect(shape([task({ due: TODAY + 6 * DAY })], 'due')).toEqual([['This week', 1]])
  })
})

describe('by note', () => {
  /*
   * The list arrives sorted by what is most pressing. Sorting the groups by
   * name would throw that away, so they keep the order their notes first
   * appear in.
   */
  it('keeps the order the notes first appear in', () => {
    const items = [
      task({ path: 'Garden.md', noteTitle: 'Garden' }),
      task({ path: 'Home/Kitchen.md', noteTitle: 'Kitchen' }),
      task({ path: 'Garden.md', noteTitle: 'Garden' }),
    ]
    expect(shape(items, 'note')).toEqual([
      ['Garden', 2],
      ['Kitchen', 1],
    ])
  })

  it('groups by the note itself, not by two notes sharing a title', () => {
    const items = [
      task({ path: 'Home/Notes.md', noteTitle: 'Notes' }),
      task({ path: 'Work/Notes.md', noteTitle: 'Notes' }),
    ]
    expect(groupTasks(items, 'note', TODAY).map((g) => g.key)).toEqual([
      'Home/Notes.md',
      'Work/Notes.md',
    ])
  })
})

describe('whatever the grouping', () => {
  it('never loses or duplicates a task', () => {
    const items = [
      task({ due: TODAY - DAY }),
      task({ due: TODAY, path: 'Garden.md', noteTitle: 'Garden' }),
      task({ done: true }),
      task({}),
    ]
    for (const by of ['none', 'due', 'note'] as const) {
      const flat = groupTasks(items, by, TODAY).flatMap((g) => g.items)
      expect(flat).toHaveLength(items.length)
      expect(new Set(flat.map((t) => t.id)).size).toBe(items.length)
    }
  })
})

/**
 * What the rail beside the calendar shows. The narrowing is the feature: a
 * list of everything was already one column to the left, and only the dated
 * part of it has anything to do with the date the calendar is on.
 */
describe('due by today', () => {
  const late = task({ due: TODAY - 3 * DAY })
  const now = task({ due: TODAY })
  const soon = task({ due: TODAY + DAY })
  const undated = task({})
  const finished = task({ due: TODAY - DAY, done: true })
  const list = [late, now, soon, undated, finished]

  it('takes what is late and what is due today', () => {
    expect(dueByToday(list, TODAY)).toEqual([late, now])
  })

  it('leaves out a task due later — it is not today’s problem', () => {
    expect(dueByToday(list, TODAY)).not.toContain(soon)
  })

  it('leaves out an undated task, however urgent it reads', () => {
    expect(dueByToday(list, TODAY)).not.toContain(undated)
  })

  it('leaves out one that is crossed off: it is over, not overdue', () => {
    expect(dueByToday(list, TODAY)).not.toContain(finished)
  })

  it('groups into no more than Overdue and Today', () => {
    expect(shape(dueByToday(list, TODAY), 'due')).toEqual([
      ['Overdue', 1],
      ['Today', 1],
    ])
  })
})

/**
 * What one day asks of you. The calendar read the other way round: click a day
 * and see what is due on it, rather than only what was filed on it.
 */
describe('tasks due on a day', () => {
  const day = TODAY + 3 * DAY
  const onIt = task({ due: day })
  const alsoOnIt = task({ due: day })
  const finishedOnIt = task({ due: day, done: true })
  const dayBefore = task({ due: day - DAY })
  const undated = task({})
  const list = [onIt, alsoOnIt, finishedOnIt, dayBefore, undated]

  it('takes the ones due that day and no other', () => {
    expect(tasksDueOn(list, day)).toEqual([onIt, alsoOnIt])
  })

  it('leaves out the day before, however close', () => {
    expect(tasksDueOn(list, day)).not.toContain(dayBefore)
  })

  it('leaves out a finished one by default, like every other list', () => {
    expect(tasksDueOn(list, day)).not.toContain(finishedOnIt)
  })

  it('and includes it when the switch says to, so one setting means one thing', () => {
    expect(tasksDueOn(list, day, true)).toEqual([onIt, alsoOnIt, finishedOnIt])
  })

  it('says nothing about a day with nothing due', () => {
    expect(tasksDueOn(list, TODAY + 99 * DAY)).toEqual([])
  })
})
