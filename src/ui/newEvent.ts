/**
 * "New event", from wherever it is asked for.
 *
 * Two places ask — the palette and the `+` on the agenda — and they are the
 * same action, so the day they mean is worked out here rather than in either of
 * them. The dialog itself is `NewEventDialog`.
 */

import { openNewEventDialog } from './NewEventDialog'
import { scope, selectedDay } from './state'
import { startOfDay } from '../core/util'

/** The day a new event belongs to: the one being looked at, or today. */
export function eventDay(): number {
  const s = scope.value
  return s.kind === 'day' ? startOfDay(s.date) : selectedDay.value
}

export function openNewEvent(day = eventDay()) {
  openNewEventDialog(day)
}
