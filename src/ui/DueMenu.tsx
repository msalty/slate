/**
 * The due-date picker.
 *
 * Presets first, calendar second. Four one-tap options cover most of what a
 * date on a task actually means — today, tomorrow, the weekend, next week —
 * and the grid below is there for the rest rather than being the main event.
 *
 * It is not a dialog. It rides on the context menu, so it is a popover under
 * your cursor on a desktop and a sheet up from the bottom of a phone, and it
 * inherits that component's scrim, dismissal and off-screen flipping rather
 * than growing its own. The one thing it adds is the grid, which is the rail's
 * calendar grid — same helper, same week layout — so the month you get when
 * picking a date is the month you already know.
 */

import { useState } from 'preact/hooks'
import { dueLabel, duePresets, monthGrid, startOfDay } from '../core/util'
import { openMenuWith } from './Menu'
import { IconChevronLeft, IconChevronRight } from './Icons'

const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

interface Props {
  current: number | undefined
  onPick: (date: number | undefined) => void
  close: () => void
}

function DuePicker({ current, onPick, close }: Props) {
  const today = startOfDay(Date.now())
  // Open on the month of the date being changed, not on this one: someone
  // revisiting a task due in November should not have to page back to it.
  const [anchor, setAnchor] = useState(startOfDay(current ?? today))
  const anchorDate = new Date(anchor)
  const days = monthGrid(anchor)

  const choose = (date: number | undefined) => {
    onPick(date)
    close()
  }

  const shiftMonth = (delta: number) => {
    const d = new Date(anchor)
    d.setDate(1)
    d.setMonth(d.getMonth() + delta)
    setAnchor(startOfDay(d))
  }

  return (
    <div class="due-pick">
      <div class="due-presets">
        {duePresets(today).map((p) => (
          <button
            key={p.date}
            class="menu-item due-preset"
            aria-current={p.date === current}
            onClick={() => choose(p.date)}
          >
            <span>{p.label}</span>
            <span class="spacer" />
            {/*
              Weekday then day, assembled rather than asked for as one string:
              a `{ weekday, day }` format comes back as "4 Fri" in a good many
              locales, which reads as a date that has lost its month.
            */}
            <span class="due-preset-when">
              {new Date(p.date).toLocaleDateString(undefined, { weekday: 'short' })}{' '}
              {new Date(p.date).getDate()}
            </span>
          </button>
        ))}
      </div>

      <div class="due-cal">
        <div class="due-cal-head">
          <button
            class="icon-btn"
            onClick={() => shiftMonth(-1)}
            aria-label="Previous month"
          >
            <IconChevronLeft size={17} />
          </button>
          <div class="due-cal-title" aria-live="polite">
            {anchorDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
          </div>
          <button class="icon-btn" onClick={() => shiftMonth(1)} aria-label="Next month">
            <IconChevronRight size={17} />
          </button>
        </div>

        {/*
          Plain buttons, not `role="grid"`. A grid promises arrow-key roving
          focus, and promising that without implementing it leaves a screen
          reader user worse off than the buttons alone. Each day carries its
          full date instead, so the column headers are decoration.
        */}
        <div class="due-grid">
          {DOW.map((d, i) => (
            <div key={i} class="due-dow" aria-hidden="true">
              {d}
            </div>
          ))}
          {days.map((day) => (
            <button
              key={day}
              class="due-day"
              data-outside={new Date(day).getMonth() !== anchorDate.getMonth() ? '1' : '0'}
              data-today={day === today ? '1' : '0'}
              data-past={day < today ? '1' : '0'}
              aria-pressed={day === current}
              aria-label={new Date(day).toDateString()}
              onClick={() => choose(day)}
            >
              {new Date(day).getDate()}
            </button>
          ))}
        </div>
      </div>

      {current !== undefined && (
        <button class="menu-item due-clear" onClick={() => choose(undefined)}>
          Clear due date
        </button>
      )}
    </div>
  )
}

/**
 * Open the picker at a point on screen.
 *
 * `current` both highlights the day already chosen and decides which month
 * opens; passing `undefined` is how a task with no date asks for one.
 */
export function openDueMenu(
  at: { clientX: number; clientY: number },
  current: number | undefined,
  onPick: (date: number | undefined) => void,
) {
  openMenuWith(
    at,
    (close) => <DuePicker current={current} onPick={onPick} close={close} />,
    {
      title: current === undefined ? 'Due date' : `Due ${dueLabel(current)}`,
      cls: 'menu-due',
    },
  )
}

/** Where a chip's own menu should appear: just under the chip, not under the finger. */
export function anchorOf(el: Element): { clientX: number; clientY: number } {
  const r = el.getBoundingClientRect()
  return { clientX: r.left, clientY: r.bottom + 4 }
}
