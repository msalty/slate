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

import type { NoteEvent } from './markdown'
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
export function eventTimeLabel(ev: NoteEvent, day: number): string {
  if (ev.allDay) return 'all day'
  const today = startOfDay(day)
  const tomorrow = addDays(today, 1)
  // Midnight closes the day before it, the same rule `eventsByDay` files by,
  // so an evening that ends at 00:00 ends today rather than running into it.
  const began = ev.start < today
  const runsOn = ev.end > tomorrow
  if (began && runsOn) return 'all day'
  if (began) return `until ${clock(ev.end)}`
  return clock(ev.start)
}

/**
 * What an event's own zone adds, when it has one worth saying.
 *
 * A zone is only worth naming when it disagrees with the clock the reader is
 * looking at: a meeting written `tz: Europe/London`, read in London, is just a
 * meeting. Compared by the offset in force at the time rather than by the name,
 * because `Europe/London` and `Europe/Dublin` are the same afternoon.
 */
export function eventZoneLabel(ev: NoteEvent): string {
  if (!ev.tz || ev.allDay) return ''
  const here = new Date(ev.start)
  const offsetHere = -here.getTimezoneOffset() * 60_000
  let offsetThere: number
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: ev.tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(ev.start)
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
    offsetThere =
      Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute')) -
      ev.start
  } catch {
    return ''
  }
  if (offsetThere === offsetHere) return ''
  // The city rather than the region: "New York" is where the meeting is, and
  // "America/New_York" is how a computer writes it down.
  const city = ev.tz.slice(ev.tz.lastIndexOf('/') + 1).replace(/_/g, ' ')
  return `${new Date(ev.start + offsetThere - offsetHere).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })} ${city}`
}

/*
 * The optional time is for files that still carry one: anything named by an
 * earlier version of this, and anything an importer chooses to name that way.
 * Nothing here writes one any more — see `eventNoteName`.
 */
const STAMP_RE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{4})?\s+/

/**
 * What an event is called, on a list that already knows the day.
 *
 * The date and time live in the *filename* because a note's title is its
 * filename and two standups on one day would otherwise be one linkable note
 * and one unreachable one. None of that is worth reading twice: the agenda
 * sits under a heading naming the day and puts the clock in its own column, so
 * a row reading "2026-09-21 0930 Standup" at 09:30 on the 21st is saying the
 * same thing three times.
 *
 * Only the stamp comes off, and only when something is left after it — a note
 * genuinely called `2026-09-21` keeps its name rather than losing it.
 */
export function eventTitle(title: string): string {
  const stripped = title.replace(STAMP_RE, '')
  return stripped || title
}

/** Whether an event has already finished, for dimming a row you have done. */
export function eventIsPast(ev: NoteEvent, now = Date.now()): boolean {
  return !ev.allDay && ev.end < now
}
