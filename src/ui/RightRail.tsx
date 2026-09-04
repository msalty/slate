/**
 * Calendar and tasks.
 *
 * The three panels here are exported individually because they serve double
 * duty: stacked in the right rail on a wide screen, and as full-screen tabs on
 * a phone. Same components, same behaviour, no second implementation to drift.
 */

import { getEntry, notesByDay, notesOnDay, setDue, tasks, toggleTask } from '../core/vault'
import type { TaskItem } from '../core/types'
import { Fragment } from 'preact'
import { groupTasks } from '../core/taskgroups'
import { settings, update } from '../core/settings'
import { openMenu } from './Menu'
import { dailyNoteFor } from '../core/daily'
import { monthGrid, startOfDay, ymd } from '../core/util'
import { calendarMonth, openDailyNote, openNote, scope, selectedDay } from './state'
import { DueChip } from './DueChip'
import {
  IconCalendar,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconDots,
  IconPlus,
} from './Icons'

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function CalendarPanel({ big = false }: { big?: boolean }) {
  const anchor = calendarMonth.value
  const anchorDate = new Date(anchor)
  const byDay = notesByDay.value
  const today = startOfDay(Date.now())
  const days = monthGrid(anchor)

  const shift = (delta: number) => {
    const d = new Date(anchor)
    d.setDate(1)
    d.setMonth(d.getMonth() + delta)
    calendarMonth.value = startOfDay(d)
  }

  return (
    <div class={big ? 'cal cal-big' : 'cal'}>
      <div class="cal-head">
        <div class="cal-title">
          {anchorDate.toLocaleDateString(undefined, { month: 'short' })}{' '}
          <em>{anchorDate.getFullYear()}</em>
        </div>
        <button class="icon-btn" onClick={() => shift(-1)} aria-label="Previous month">
          <IconChevronLeft size={17} />
        </button>
        <button
          class="icon-btn cal-today"
          onClick={() => {
            calendarMonth.value = today
            selectedDay.value = today
            scope.value = { kind: 'day', date: today }
          }}
        >
          TODAY
        </button>
        <button class="icon-btn" onClick={() => shift(1)} aria-label="Next month">
          <IconChevronRight size={17} />
        </button>
      </div>

      <div class="cal-grid" role="grid">
        {DOW.map((d) => (
          <div key={d} class="cal-dow" role="columnheader">
            {d.slice(0, big ? 3 : 3)}
          </div>
        ))}
        {days.map((day) => {
          const count = byDay.get(day)?.length ?? 0
          const outside = new Date(day).getMonth() !== anchorDate.getMonth()
          const isSelected = scope.value.kind === 'day' && startOfDay(scope.value.date) === day
          return (
            <button
              key={day}
              class="cal-day"
              role="gridcell"
              data-outside={outside ? '1' : '0'}
              data-today={day === today ? '1' : '0'}
              aria-pressed={isSelected}
              aria-label={`${new Date(day).toDateString()}, ${count} notes`}
              onClick={() => {
                selectedDay.value = day
                // Tapping the selected day again clears the filter.
                scope.value = isSelected ? { kind: 'all' } : { kind: 'day', date: day }
                if (outside) calendarMonth.value = day
              }}
            >
              <span class="cal-num">{new Date(day).getDate()}</span>
              <span class="cal-dots">
                {Array.from({ length: Math.min(count, 5) }, (_, i) => (
                  <span key={i} class="cal-dot" />
                ))}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function DayNotesPanel() {
  const day = scope.value.kind === 'day' ? startOfDay(scope.value.date) : selectedDay.value
  const list = notesOnDay(day)
  /*
   * The offer is only made when the day hasn't got one. Once it has, the note
   * is already sitting in the list above, and a second way in from the same
   * panel would either open it twice or, worse, make a "2" copy.
   */
  const hasDaily = dailyNoteFor(day) !== undefined
  return (
    <div class="rail-section">
      <h3>
        <IconCalendar size={12} />
        {new Date(day).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}
        <span class="spacer" />
        {list.length > 0 && <span>{list.length}</span>}
      </h3>
      {list.length === 0 ? (
        <p class="rail-empty">No notes on this day.</p>
      ) : (
        list.map((n) => (
          <button key={n.path} class="day-note-row" onClick={() => openNote(n.path)}>
            {n.title}
          </button>
        ))
      )}
      {!hasDaily && (
        <button
          class="day-create-row"
          onClick={() => void openDailyNote(day)}
          title={`Create ${ymd(day)}.md in the Daily folder`}
        >
          <IconPlus size={12} />
          Create daily note
        </button>
      )}
    </div>
  )
}

/**
 * The task list, in the rail, as a phone tab, and as the body of a Tag Folder
 * that gathers tasks.
 *
 * `items` is what makes the third one possible: given a list it shows that
 * list and nothing else — a folder's rule has already decided what belongs,
 * including whether finished ones do, so it must not be filtered again here.
 */
export function TasksPanel({
  showDone = false,
  items,
  title = 'Tasks',
  empty,
}: {
  showDone?: boolean
  items?: TaskItem[]
  title?: string
  empty?: preact.ComponentChildren
}) {
  const all = items ?? tasks.value
  const open = all.filter((t) => !t.done)
  const done = all.filter((t) => t.done)
  const shown = items ? all : showDone ? [...open, ...done] : open

  const by = settings.value.taskGroupBy
  const groups = groupTasks(shown, by)

  /**
   * How the list is arranged, chosen once for every list in the app.
   *
   * Grouping by *tag* is deliberately not on offer: a task carries the tags on
   * its own line and the ones its note carries, so a job that is both `#home`
   * and `#urgent` has no single group — see core/taskgroups.ts.
   */
  const groupMenu = (e: { clientX: number; clientY: number }) =>
    openMenu(
      e,
      ([
        ['none', 'No grouping'],
        ['due', 'By due date'],
        ['note', 'By note'],
      ] as const).map(([id, label]) => ({
        label,
        checked: by === id,
        onSelect: () => update({ taskGroupBy: id }),
      })),
      'Arrange tasks',
    )

  return (
    <div class="rail-section">
      <h3>
        <IconCheck size={12} />
        {title}
        <span class="spacer" />
        <span>
          {open.length} open{done.length ? ` · ${done.length} done` : ''}
        </span>
        {all.length > 1 && (
          <button
            class="rail-group-btn"
            title="Arrange tasks"
            aria-label="Arrange tasks"
            aria-haspopup="menu"
            onClick={groupMenu}
          >
            <IconDots size={14} />
          </button>
        )}
      </h3>

      {all.length === 0 ? (
        <p class="rail-empty">
          {empty ?? (
            <>
              Type <code>- [ ]</code> in any note to add a task. Each one gets a date button here
              and in the note.
            </>
          )}
        </p>
      ) : shown.length === 0 ? (
        <p class="rail-empty">All clear.</p>
      ) : (
        groups.map((g) => (
          <Fragment key={g.key}>
            {g.label && <div class="task-group">{g.label}</div>}
            {g.items.slice(0, 200).map((t) => (
          <div key={t.id} class="task-row" data-done={t.done ? '1' : '0'}>
            <input
              type="checkbox"
              class="task-check"
              checked={t.done}
              aria-label={t.text}
              onChange={() => void toggleTask(t.path, t.line)}
            />
            <span
              class="task-text"
              role="button"
              tabIndex={0}
              onClick={() => openNote(t.path)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') openNote(t.path)
              }}
            >
              {t.text || <em class="dim">Untitled task</em>}
              {by !== 'note' && (
                <span class="task-meta">
                  <span>{getEntry(t.path)?.title ?? t.noteTitle}</span>
                </span>
              )}
            </span>
            <DueChip
              due={t.due}
              label={t.text || 'this task'}
              onPick={(date) => void setDue(t.path, t.line, date)}
            />
          </div>
            ))}
          </Fragment>
        ))
      )}
    </div>
  )
}

/** The wide-screen right column. */
export function RightRail() {
  return (
    <div class="pane rail">
      <div class="rail-scroll">
        <CalendarPanel />
        <DayNotesPanel />
        <TasksPanel />
      </div>
    </div>
  )
}
