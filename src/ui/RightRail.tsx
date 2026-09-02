/**
 * Calendar and tasks.
 *
 * The three panels here are exported individually because they serve double
 * duty: stacked in the right rail on a wide screen, and as full-screen tabs on
 * a phone. Same components, same behaviour, no second implementation to drift.
 */

import { getEntry, notesByDay, notesOnDay, tasks, toggleTask } from '../core/vault'
import { dailyNoteFor } from '../core/daily'
import { startOfDay, ymd } from '../core/util'
import { calendarMonth, openDailyNote, openNote, scope, selectedDay } from './state'
import { IconCalendar, IconCheck, IconChevronLeft, IconChevronRight, IconPlus } from './Icons'

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function monthGrid(anchor: number): number[] {
  const d = new Date(anchor)
  const first = new Date(d.getFullYear(), d.getMonth(), 1)
  const start = new Date(first)
  start.setDate(1 - first.getDay())
  const days: number[] = []
  for (let i = 0; i < 42; i++) {
    const day = new Date(start)
    day.setDate(start.getDate() + i)
    days.push(startOfDay(day))
  }
  // Trim a trailing all-next-month week so short months don't show six rows.
  return days.slice(0, days[35] && new Date(days[35]).getMonth() !== d.getMonth() ? 35 : 42)
}

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

export function TasksPanel({ showDone = false }: { showDone?: boolean }) {
  const all = tasks.value
  const open = all.filter((t) => !t.done)
  const done = all.filter((t) => t.done)
  const today = startOfDay(Date.now())
  const soon = today + 2 * 86_400_000
  const shown = showDone ? [...open, ...done] : open

  return (
    <div class="rail-section">
      <h3>
        <IconCheck size={12} />
        Tasks
        <span class="spacer" />
        <span>
          {open.length} open{done.length ? ` · ${done.length} done` : ''}
        </span>
      </h3>

      {all.length === 0 ? (
        <p class="rail-empty">
          Type <code>- [ ]</code> in any note to add a task. Add <code>📅 {ymd(today)}</code> to give
          it a due date.
        </p>
      ) : shown.length === 0 ? (
        <p class="rail-empty">All clear.</p>
      ) : (
        shown.slice(0, 200).map((t) => (
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
              <span class="task-meta">
                <span>{getEntry(t.path)?.title ?? t.noteTitle}</span>
                {t.due !== undefined && (
                  <span
                    class={
                      t.due < today ? 'task-due-over' : t.due <= soon ? 'task-due-soon' : undefined
                    }
                  >
                    {t.due < today ? 'Overdue · ' : ''}
                    {new Date(t.due).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                )}
              </span>
            </span>
          </div>
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
