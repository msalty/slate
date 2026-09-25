/**
 * How an event reads on a day.
 *
 * The agenda shows one day at a time, so the time on a row is answering "when,
 * today" rather than "when" — which is why none of this formats a date. An
 * event that started yesterday and is still running says so in words instead,
 * because "09:30" on a row that began on Tuesday is a lie told precisely.
 *
 * Kept out of the rail component because it is a rule rather than a rendering:
 * the same row appears in the rail and on the phone's calendar tab, and the
 * only way two surfaces agree about what a time means is to ask one function.
 */

import { zoneOffsetAt, type NoteEvent } from './markdown'
import { addDays, startOfDay } from './util'

/** A clock, in whatever form the reader's locale writes one. */
function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/**
 * The time to put in front of an event, read on a particular day.
 *
 * An all-day event says so rather than leaving the column empty. Saying nothing
 * was the first answer — the row is under a heading that already names the day,
 * so the words look redundant — but on screen an empty cell does not read as
 * "no time", it reads as a title that has come loose from the column beside it.
 * A label costs two faint words and keeps the column a column.
 */
/**
 * Which of an event's two ends the row is talking about, on this day.
 *
 * Undefined when neither: a whole-day event, or one that began before today and
 * is still going after it, where the row says "all day" and there is no clock
 * on it to name a zone for.
 *
 * Split out because two labels read this row and they have to agree. They did
 * not: a conference running into the small hours showed "until 01:00" — the
 * local end — beside "04:00 PM Tokyo", which was still the *start*. Two real
 * times, an hour and a day apart, side by side on one line.
 */
export function eventRowInstant(ev: NoteEvent, day: number): number | undefined {
  if (ev.allDay) return undefined
  const today = startOfDay(day)
  const tomorrow = addDays(today, 1)
  // Midnight closes the day before it, the same rule `eventsByDay` files by,
  // so an evening that ends at 00:00 ends today rather than running into it.
  const began = ev.start < today
  const runsOn = ev.end > tomorrow
  if (began && runsOn) return undefined
  return began ? ev.end : ev.start
}

export function eventTimeLabel(ev: NoteEvent, day: number): string {
  const at = eventRowInstant(ev, day)
  if (at === undefined) return 'all day'
  return at === ev.start ? clock(at) : `until ${clock(at)}`
}

/**
 * What an event's own zone adds, when it has one worth saying.
 *
 * The clock is read straight off the instant, in the event's own zone, rather
 * than by shifting the instant and reading it here. Shifting was wrong twice a
 * year and silently: a London event at 03:30 on the morning the *device's*
 * clocks change landed, once moved, on the far side of New York's own
 * transition, so it was formatted with an offset that had nothing to do with
 * either — and came out an hour late.
 *
 * A zone is only worth naming when it disagrees with the clock the reader is
 * looking at, and that is compared by the offset in force at the moment itself
 * rather than by the name, because `Europe/London` and `Europe/Dublin` are the
 * same afternoon.
 */
export function eventZoneLabel(ev: NoteEvent, on?: number): string {
  if (!ev.tz || ev.allDay) return ''
  /*
   * The same instant the time beside it is showing. Given a day, that is
   * whichever end of the event this row is about; given none — the phone's
   * single-day tab, a caller with no day in hand — the start, which is what it
   * was before and is right whenever the event is inside one day.
   */
  const when = on === undefined ? ev.start : eventRowInstant(ev, on)
  if (when === undefined) return ''
  try {
    if (zoneOffsetAt(when, ev.tz) === -new Date(when).getTimezoneOffset() * 60_000) {
      return ''
    }
    const at = new Intl.DateTimeFormat(undefined, {
      timeZone: ev.tz,
      hour: '2-digit',
      minute: '2-digit',
    }).format(when)
    // The city rather than the region: "New York" is where the meeting is, and
    // "America/New_York" is how a computer writes it down.
    return `${at} ${ev.tz.slice(ev.tz.lastIndexOf('/') + 1).replace(/_/g, ' ')}`
  } catch {
    return ''
  }
}

/**
 * A `tz:` the browser cannot read, for the row to show as broken.
 *
 * It is not enough to fall back to local time and carry on. A zone that does
 * nothing looks exactly like a zone that works, and the event it is attached to
 * is quietly an hour or eight out — so the row says the name it could not use
 * and lets you fix it.
 */
export function eventZoneProblem(ev: NoteEvent): string {
  return ev.badZone ?? ''
}

/*
 * What a row is called lives with the function that names the file, in
 * `eventname.ts`, since the one has to undo exactly what the other did.
 */
export { eventTitle } from './eventname'

/** Whether an event has already finished, for dimming a row you have done. */
export function eventIsPast(ev: NoteEvent, now = Date.now()): boolean {
  return !ev.allDay && ev.end < now
}
