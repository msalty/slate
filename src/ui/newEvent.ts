/**
 * "New event", from wherever it is asked for.
 *
 * Two places ask — the palette and the `+` on the agenda — and they are the
 * same action, so it lives here rather than in either of them. A note nobody
 * has named is no use as an event, since its name is what the day's list shows
 * and what a `[[link]]` to it has to say, so the title is asked for first.
 */

import { newEventNote, nextHalfHour } from '../core/eventnote'
import { openPrompt } from './PromptDialog'
import { notify, openNote, selectedDay } from './state'
import { scope } from './state'
import { startOfDay } from '../core/util'

/** The day a new event belongs to: the one being looked at, or today. */
export function eventDay(): number {
  const s = scope.value
  return s.kind === 'day' ? startOfDay(s.date) : selectedDay.value
}

export function openNewEvent(day = eventDay()) {
  const start = nextHalfHour()
  const when = new Date(day).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
  openPrompt({
    title: 'New event',
    label: 'What is it?',
    value: '',
    placeholder: 'Design review',
    /*
     * The date and the time are in the hint rather than in fields of their own.
     * A dialog with three inputs is a form, and the two it would add are both
     * already answered — the day by the calendar you are looking at, the time
     * by the clock — and both are easier to change in the note than to get
     * right in a dialog before the thing even has a name.
     */
    hint: `${when} at ${start}, in the Calendar folder. Both are yours to change once it opens.`,
    confirm: 'Create event',
    onSubmit: async (title) => {
      const name = title.trim()
      if (!name) return
      const { path, caret } = await newEventNote(name, day, start)
      openNote(path, { editing: true, caret })
      notify(`Created ${path}`)
    },
  })
}
