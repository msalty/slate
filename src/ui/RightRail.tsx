/**
 * Calendar and tasks.
 *
 * The three panels here are exported individually because they serve double
 * duty: stacked in the right rail on a wide screen, and as full-screen tabs on
 * a phone. Same components, same behaviour, no second implementation to drift.
 */

import {
  eventsByDay,
  getEntry,
  notesByDay,
  notesOnDay,
  openTasksByDueDay,
  setDue,
  tasks,
  toggleTask,
} from '../core/vault'
import {
  eventIsPast,
  eventTimeLabel,
  eventTitle,
  eventZoneLabel,
  eventZoneProblem,
} from '../core/agenda'
import type { TaskItem } from '../core/types'
import { Fragment } from 'preact'
import { dueBeyond, groupTasks, tasksDueOn } from '../core/taskgroups'
import { settings, update } from '../core/settings'
import { openMenu } from './Menu'
import { DAILY_FOLDER, dailyNoteFor } from '../core/daily'
import { monthGrid, searchTerms, startOfDay, ymd } from '../core/util'
import { parseSearch } from '../core/searchquery'
import { openConfirm } from './ConfirmDialog'
import {
  calendarDayIntent,
  calendarMonth,
  dayNotesDuplicated,
  matchingTasks,
  notify,
  openDailyNote,
  openNote,
  scope,
  selectedDay,
  setScope,
} from './state'
import { DueChip } from './DueChip'
import { openQuickAdd } from './QuickAdd'
import { openNewEvent } from './newEvent'
import { Highlight } from './Highlight'
import {
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconClock,
  IconDots,
  IconNotes,
  IconPlus,
} from './Icons'

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * Ask before writing a file nobody named.
 *
 * Only the calendar's own click reaches here, and only in the mode where a
 * click means "open this day's note". Every other way into a daily note — the
 * row at the top of a day's list, the one under the day in the rail, the
 * palette — says *Create* on the control itself, so the question has already
 * been asked and answered by pressing it.
 *
 * The path is named in full because `Daily/` is almost never the folder you
 * were looking at when you asked, and a file that appears somewhere you cannot
 * see is a file you think you have lost.
 */
function offerDailyNote(day: number) {
  const when = new Date(day).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
  openConfirm({
    title: 'Start a note for this day?',
    body: (
      <>
        Nothing is written for {when} yet. Creating one makes{' '}
        <code>
          {DAILY_FOLDER}/{ymd(day)}.md
        </code>{' '}
        and opens it ready to type in.
      </>
    ),
    confirm: 'Create note',
    onConfirm: () => void openDailyNote(day),
  })
}

export function CalendarPanel({ big = false }: { big?: boolean }) {
  const anchor = calendarMonth.value
  const anchorDate = new Date(anchor)
  const byDay = notesByDay.value
  const dueByDay = openTasksByDueDay.value
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
            setScope({ kind: 'day', date: today })
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
          const owed = dueByDay.get(day) ?? 0
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
              aria-label={
                owed
                  ? `${new Date(day).toDateString()}, ${count} notes, ${owed} due`
                  : `${new Date(day).toDateString()}, ${count} notes`
              }
              onClick={() => {
                selectedDay.value = day
                if (outside) calendarMonth.value = day
                const intent = calendarDayIntent(settings.value.calendarDayOpens, {
                  hasDaily: dailyNoteFor(day) !== undefined,
                  isSelected,
                })
                /*
                 * The day is selected in every mode — the panel below is the
                 * calendar read the other way round and has to follow it. Only
                 * the filtering mode lets a second click take that back off:
                 * where a click means "open this day's note", a second one
                 * means it again.
                 */
                setScope(intent === 'clear' ? { kind: 'all' } : { kind: 'day', date: day })
                if (intent === 'open') void openDailyNote(day)
                if (intent === 'offer') offerDailyNote(day)
              }}
            >
              {/*
                * A day that owes you work says so in a channel of its own: the
                * dots below mean notes filed here, and overloading them would
                * make a dot mean two things. Red once the day has passed —
                * the same red the date chip turns when it is late.
                */}
              {owed > 0 && (
                <span class="cal-due" data-late={day < today ? '1' : '0'} aria-hidden="true" />
              )}
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

/**
 * The selected day, as a list of what is on it.
 *
 * Deliberately not a grid. A time grid needs vertical space the rail has not
 * got, and it spends most of that space drawing the hours nothing happens in;
 * this is a surface for reading a day rather than for scheduling one, so it
 * lists what is there and says when.
 *
 * All-day rows come first without a time against them — they are true of the
 * whole day, and a column of "all day" repeated down the top of the panel is
 * furniture. A row that has already finished is dimmed rather than dropped:
 * what you did this morning is part of what the day was.
 */
/** The day every panel under the calendar is about. */
function railDay(): number {
  return scope.value.kind === 'day' ? startOfDay(scope.value.date) : selectedDay.value
}

/**
 * The selected day, named once, over everything that is about it.
 *
 * It used to be the heading of the notes panel, which made the date look like a
 * property of that one list rather than the subject of the whole column — three
 * sections of equal weight, one of them wearing the day's name. Lifting it out
 * gives the rail two tiers instead of four peers: this day, and then the three
 * things there are to say about it.
 *
 * Plain case and a size up from the section headings, because it is the only
 * line here that is a *name* rather than a label. "Today" replaces the weekday
 * when it is today: the one fact worth more than which day of the week it is.
 */
export function RailDayHead({ big = false }: { big?: boolean } = {}) {
  const day = railDay()
  const isToday = day === startOfDay(Date.now())
  const d = new Date(day)
  return (
    <div class={big ? 'rail-day-head rail-day-head-big' : 'rail-day-head'}>
      <strong>{d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}</strong>
      <span>{isToday ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'long' })}</span>
    </div>
  )
}

export function AgendaPanel({ big = false }: { big?: boolean } = {}) {
  const day = railDay()
  const events = eventsByDay.value.get(day) ?? []
  // Read once per render rather than per row, so a list cannot disagree with
  // itself about what time it is.
  const now = Date.now()
  return (
    <div class={big ? 'rail-section agenda agenda-big' : 'rail-section agenda'}>
      <h3>
        <IconClock size={12} />
        Agenda
        <span class="spacer" />
        {events.length > 0 && <span>{events.length}</span>}
        <button
          class="rail-group-btn"
          onClick={() => openNewEvent(day)}
          aria-label="New event"
          title="New event on this day"
        >
          <IconPlus size={14} />
        </button>
      </h3>
      {events.length === 0 ? (
        <p class="rail-empty">Nothing scheduled.</p>
      ) : (
        events.map((e) => {
          const ev = e.event!
          const zone = eventZoneLabel(ev, day)
          // A `tz:` nothing can read is shown rather than swallowed: the row
          // would otherwise look like any other and be silently hours out.
          const broken = eventZoneProblem(ev)
          return (
            <button
              key={e.path}
              class="agenda-row"
              data-past={eventIsPast(ev, now) ? '1' : '0'}
              onClick={() => openNote(e.path)}
            >
              <span class="agenda-when">{eventTimeLabel(ev, day)}</span>
              <span class="agenda-what">{eventTitle(e.title)}</span>
              {broken ? (
                <em class="agenda-zone" data-invalid="1" title={`${broken} is not a time zone this browser knows, so it is being ignored`}>
                  {broken}?
                </em>
              ) : (
                zone && <em class="agenda-zone">{zone}</em>
              )}
            </button>
          )
        })
      )}
    </div>
  )
}

export function DayNotesPanel({ omitScoped = false }: { omitScoped?: boolean } = {}) {
  const day = railDay()
  /*
   * `omitScoped` drops the section — header, list and the offer under it — when
   * the column beside this one is already showing the same notes; the rule
   * itself is in state.ts. Nothing is lost with it: a day the list is scoped to
   * carries its own *Create daily note* row at the top of that list, so the
   * offer is on screen either way. The phone passes nothing, its calendar tab
   * being a screen of its own with no second column to agree with.
   */
  if (omitScoped && dayNotesDuplicated(scope.value, day)) return null
  /*
   * Events are not in this list, because they are in the one directly above it.
   * A note that says when it happens is *shown as* the thing that happens — and
   * the column used to say a meeting twice, once under a clock and once under a
   * heading, which is the same redundancy the scoped-day rule above exists to
   * avoid. They keep their dot on the month and they are still in the middle
   * column when the list is scoped to a day: those two answer "what is filed
   * here", which an event is. This one answers "what did you write", which an
   * event is not.
   */
  const list = notesOnDay(day).filter((n) => !n.event)
  /*
   * The offer is only made when the day hasn't got one. Once it has, the note
   * is already sitting in the list above, and a second way in from the same
   * panel would either open it twice or, worse, make a "2" copy.
   */
  const hasDaily = dailyNoteFor(day) !== undefined
  return (
    <div class="rail-section day-notes">
      <h3>
        <IconNotes size={12} />
        Notes
        <span class="spacer" />
        {list.length > 0 && <span>{list.length}</span>}
      </h3>
      {list.length === 0 ? (
        <p class="rail-empty">Nothing written on this day.</p>
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
 * What the day asks of you — the calendar read the other way round.
 *
 * Its own section now rather than a run of checkboxes under the notes. Sharing
 * a panel with them meant the day's work had no heading of its own to be
 * counted in, and the only thing separating a task from a note was that one of
 * them had a checkbox on it.
 *
 * It keeps everything due on its day, and the Due list below drops whatever
 * this one has already shown — see `dueBeyond`. The yielding used to go the
 * other way, which cost nothing on a day you were not looking at and printed
 * "Nothing due on this day" on the day you almost always are.
 */
export function DayTasksPanel() {
  const day = railDay()
  const due = tasksDueOn(tasks.value, day, settings.value.showDoneTasks)
  return (
    <div class="rail-section day-tasks">
      <h3>
        <IconCheck size={12} />
        Tasks
        <span class="spacer" />
        {due.length > 0 && <span>{due.length}</span>}
        {/*
          Adding from a day is about that day: the task is filed in that day's
          note and carries its date, so it appears in the list below rather than
          somewhere you have to go and look for it. On the header beside the
          count, where the agenda keeps its own +, so the two sections offer the
          same thing in the same place instead of one of them hiding it at the
          bottom of a list.
        */}
        <button
          class="rail-group-btn"
          onClick={() => openQuickAdd({ mode: 'task', day, due: day })}
          aria-label="Add task for this day"
          title="Add task for this day"
        >
          <IconPlus size={14} />
        </button>
      </h3>
      {due.length === 0 ? (
        <p class="rail-empty">Nothing due on this day.</p>
      ) : (
        due.map((t) => <TaskRow key={t.id} task={t} />)
      )}
    </div>
  )
}

/**
 * The one-line way into capture from a list of tasks.
 *
 * A row rather than a floating button, because it belongs to the list it adds
 * to — and on a desktop, where the phone's + is not on screen, this is the way
 * in that isn't the command palette.
 */
function AddTaskRow({
  day,
  due,
  label = 'Add task',
}: {
  day?: number
  due?: number
  label?: string
}) {
  return (
    <button class="day-add-row" onClick={() => openQuickAdd({ mode: 'task', day, due })}>
      <IconPlus size={12} />
      {label}
    </button>
  )
}

/**
 * How many rows one group draws before it stops.
 *
 * A list long enough to hit this is a list nobody is reading to the end of, and
 * a thousand rows of DOM cost something on every keystroke. The count is said
 * out loud rather than silently dropped — a cap you cannot see is a lie.
 */
const CAP = 200

/**
 * One task, wherever a task appears: the rail, the phone tab, a Tag Folder that
 * gathers tasks, and the day panel. Same checkbox, same date chip, so ticking
 * one is the same act everywhere and always writes to the note it lives on.
 */
function TaskRow({
  task: t,
  showNote = true,
  terms = [],
}: {
  task: TaskItem
  showNote?: boolean
  /** Set only where this row sits under a search box; see `TasksPanel`. */
  terms?: string[]
}) {
  return (
    <div class="task-row" data-done={t.done ? '1' : '0'}>
      <input
        type="checkbox"
        class="task-check"
        checked={t.done}
        aria-label={t.text}
        onChange={() =>
          void toggleTask(t.path, t.line).then((ok) => {
            // A note can refuse: one whose own properties say it is read-only
            // is a form, and its tasks are part of the form rather than of the
            // list. Saying so beats a checkbox that springs back.
            if (!ok) notify(`${t.noteTitle} is read-only`)
          })
        }
      />
      <span
        class="task-text"
        role="button"
        tabIndex={0}
        onClick={() => openNote(t.path, { line: t.line })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            openNote(t.path, { line: t.line })
          }
        }}
      >
        {t.text ? <Highlight text={t.text} terms={terms} /> : <em class="dim">Untitled task</em>}
        {showNote && (
          <span class="task-meta">
            <span>
              <Highlight text={getEntry(t.path)?.title ?? t.noteTitle} terms={terms} />
            </span>
          </span>
        )}
      </span>
      <DueChip
        due={t.due}
        label={t.text || 'this task'}
        onPick={(date) =>
          void setDue(t.path, t.line, date).then((ok) => {
            if (!ok) notify(`${t.noteTitle} is read-only`)
          })
        }
      />
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
 *
 * `query` is passed only where this panel sits under a search box, which is
 * the note list and nowhere else: the rail and the phone's Tasks tab have no
 * search of their own, and a list that quietly narrowed itself to whatever was
 * typed in a different column would be a list nobody could trust. Counts and
 * the empty state follow the filter, so a search that finds nothing says so
 * rather than offering to teach you the checkbox syntax again.
 */
export function TasksPanel({
  items,
  title = 'Tasks',
  empty,
  query,
  class: cls,
}: {
  items?: TaskItem[]
  title?: string
  empty?: preact.ComponentChildren
  query?: string
  /** An extra class, for the one place this panel is a peer of a group. */
  class?: string
}) {
  const searching = !!query?.trim()
  /*
   * The words, not the rule: `#home` in the box is why these tasks are here,
   * and marking it inside a task's own text would underline the wrong thing.
   * `matchingTasks` applies both halves.
   */
  const hlTerms = searching ? searchTerms(parseSearch(query!).text) : []
  const all = searching ? matchingTasks(items ?? tasks.value) : (items ?? tasks.value)
  const open = all.filter((t) => !t.done)
  const done = all.filter((t) => t.done)
  /*
   * Finished ones are out by default and the heading still counts them, so the
   * list is what you owe rather than an archive that grows for ever. `items`
   * lists are exempt: their rule already said whether done ones belong.
   */
  const withDone = settings.value.showDoneTasks
  const shown = items ? all : withDone ? [...open, ...done] : open

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
      [
        ...([
          ['none', 'No grouping'],
          ['due', 'By due date'],
          ['note', 'By note'],
        ] as const).map(([id, label]) => ({
          label,
          checked: by === id,
          onSelect: () => update({ taskGroupBy: id }),
        })),
        // Only where this panel owns its list: a folder's rule decides its own.
        ...(items
          ? []
          : [
              {
                label: 'Show completed',
                separated: true,
                checked: withDone,
                onSelect: () => update({ showDoneTasks: !withDone }),
              },
            ]),
      ],
      'Arrange tasks',
    )

  return (
    <div class={cls ? `rail-section ${cls}` : 'rail-section'}>
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
          {searching ? (
            <>No tasks match “{query}”.</>
          ) : (
            (empty ?? (
              <>
                Type <code>- [ ]</code> in any note to add a task. Each one gets a date button here
                and in the note.
              </>
            ))
          )}
        </p>
      ) : shown.length === 0 ? (
        <p class="rail-empty">All clear.</p>
      ) : (
        groups.map((g) => (
          <Fragment key={g.key}>
            {g.label && <div class="task-group">{g.label}</div>}
            {g.items.slice(0, CAP).map((t) => (
              <TaskRow key={t.id} task={t} showNote={by !== 'note'} terms={hlTerms} />
            ))}
            {g.items.length > CAP && (
              <div class="task-more">and {g.items.length - CAP} more</div>
            )}
          </Fragment>
        ))
      )}
      {/*
        Only where this panel owns its list. A Tag Folder's rule decides what
        belongs in it, and a captured task goes to the daily note — so an add
        row inside a folder would offer to add something that then wouldn't
        appear there.
      */}
      {!items && !searching && <AddTaskRow />}
    </div>
  )
}

/**
 * The rail's own task list: what is due today, and what is already late —
 * apart from whatever the selected day's own section has just shown.
 *
 * Narrowed twice, for two different reasons. By date, on purpose: the sidebar's
 * Tasks row holds every task in the vault, and repeating that list under a
 * calendar made the two columns compete, whereas dates are what the column
 * beside it is about. And by the day above it, so that looking at today — which
 * is most of the time — does not draw the same row twice in one column.
 */
function DueTasksPanel() {
  return (
    <TasksPanel
      items={dueBeyond(tasks.value, railDay())}
      title="Due"
      class="rail-due"
      empty={<>Nothing else is due or late. The sidebar’s Tasks list has the rest.</>}
    />
  )
}

/**
 * The wide-screen right column.
 *
 * Two tiers rather than four sections in a row. The calendar picks a day; the
 * group under it is everything about that day, named once at the top; and Due
 * sits outside that group because it is the one list here that is not about the
 * selected day at all — it is what is late and what is owed today, whichever
 * day you happen to be looking at, minus whatever that day has already said.
 */
export function RightRail() {
  return (
    <div class="pane rail">
      <div class="rail-scroll">
        <CalendarPanel />
        <div class="rail-day">
          <RailDayHead />
          <AgendaPanel />
          <DayNotesPanel omitScoped />
          <DayTasksPanel />
        </div>
        <DueTasksPanel />
      </div>
    </div>
  )
}
