/**
 * Making an event by hand.
 *
 * An event is an ordinary note with `start:` on it, so this is not a new kind
 * of file and there is nothing here that reads one — that is `eventFor` in
 * markdown.ts. All this decides is where a new one goes and what is already
 * written in it when it opens.
 *
 * Kept apart from `core/events`-style parsing for the reason `daily.ts` is
 * kept apart from the index: this end imports the vault to write a file, and
 * the parsing end is imported *by* the vault to read one.
 */

import { eventFor, isKnownZone, parseFrontmatter, wallClockIn } from './markdown'
import { readProperties, removeProperty, setPropertyValue } from './properties'
import { templateBodyFor } from './templates'
import { createNote } from './vault'
import { addDays, dirname, roundUpToHalfHour, startOfDay, ymd } from './util'
import { eventNoteName } from './eventname'
import type { TemplateBody } from './templates'

/** Where an event is created when nothing says otherwise. */
export const CALENDAR_FOLDER = 'Calendar'

/**
 * `Calendar/2026/09`.
 *
 * Year and month subfolders because this is the one folder in the vault that
 * fills up on its own: an importer writing a rolling few months of a busy
 * calendar puts hundreds of files here, and a directory with hundreds of files
 * in it is one nobody opens twice. The name still carries the whole date, so
 * the folder is an index rather than the only way to know when something was.
 */
export function eventFolderFor(day: number): string {
  const d = new Date(startOfDay(day))
  return `${CALENDAR_FOLDER}/${d.getFullYear()}/${`${d.getMonth() + 1}`.padStart(2, '0')}`
}

/*
 * The name a new event is given, and how the agenda reads it back, are in
 * `eventname.ts` — side by side, because they have to be exact inverses.
 */
export { eventNoteName } from './eventname'

/* ------------------------------------------------- the values a field holds */

/**
 * `2026-09-21T14:30` — what a `datetime-local` field holds, and what `start:`
 * is written as. The same string in both places, so nothing is converted on the
 * way from the dialog into the file.
 */
export function localDateTime(at: number): string {
  const d = new Date(at)
  const p = (n: number) => `${n}`.padStart(2, '0')
  return `${ymd(d)}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * The instant a field value names, in the zone that was chosen for it.
 *
 * Put through `eventFor` rather than parsed here, which is the whole point: a
 * field holds a wall clock, and a wall clock only becomes a moment once you say
 * *whose* clock. Asking the same parser the note will be read by means the
 * dialog's idea of "is the end after the start" and the file's idea of when the
 * event is cannot come apart — and it means the two days a year a wall clock is
 * skipped or repeated are handled once, in one place, rather than differently
 * in every caller.
 */
export function instantOf(value: string, tz?: string): number | undefined {
  return eventFor({ start: value, ...(tz ? { tz } : {}) })?.start
}

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Later on the clock face, by so many minutes — arithmetic no zone takes part
 * in, and the only kind that always produces a value this format can hold.
 */
export function wallPlus(wall: string, minutes: number): string {
  const m = WALL_RE.exec(wall.trim())
  if (!m) return wall
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5] + minutes))
  const p = (n: number) => `${n}`.padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

/** An hour later on the clock face. */
export function wallPlusHour(wall: string): string {
  return wallPlus(wall, 60)
}

/** How far apart two clock faces are, in minutes, whatever either one means. */
function wallMinutes(from: string, to: string): number {
  const a = WALL_RE.exec(from.trim())
  const b = WALL_RE.exec(to.trim())
  if (!a || !b) return 0
  const ms =
    Date.UTC(+b[1], +b[2] - 1, +b[3], +b[4], +b[5]) - Date.UTC(+a[1], +a[2] - 1, +a[3], +a[4], +a[5])
  return ms / 60_000
}

/**
 * What the dialog opens with: the chosen day, at the next half hour, for an
 * hour.
 *
 * The rollover is the whole reason this takes an instant from
 * `roundUpToHalfHour` rather than a clock face. At 23:45 the next half hour is
 * midnight *tomorrow*, and rounding to "00:00" and then hanging that on today
 * opened every late-night event twenty-four hours in the past.
 *
 * It only rolls when the day being offered is today. A day picked out of the
 * calendar keeps its own date and takes the suggested clock time onto it: the
 * point of the suggestion is "a time you might plausibly want", not "now".
 *
 * An hour long by the *clock* rather than by the millisecond, so a meeting made
 * on the morning the clocks go forward is an hour rather than two.
 */
export function defaultEventTimes(day: number, now = Date.now()): { start: string; end: string } {
  const rounded = new Date(roundUpToHalfHour(now))
  let at: Date
  if (startOfDay(day) === startOfDay(now)) {
    at = rounded
  } else {
    at = new Date(startOfDay(day))
    at.setHours(rounded.getHours(), rounded.getMinutes(), 0, 0)
  }
  /*
   * And then read back the way it will be stored — but only when the day being
   * offered is today.
   *
   * What goes in the field is a wall clock, and on the morning the clocks go
   * back a wall clock is ambiguous: an instant that is correctly the *second*
   * 01:30 writes out as "01:30" and reads back as the first, forty-five minutes
   * before we started. The rounding above cannot fix that, because the loss
   * happens when the instant becomes a string, so the string is stepped on
   * until it names a moment still to come.
   *
   * On a day you picked out of the calendar there is nothing to fix. A past day
   * is *supposed* to be in the past, and checking it against now walked the
   * suggestion off the day you asked for and onto the next one — twenty to
   * midnight on the twentieth became half one in the morning on the twenty
   * first, which is neither the time nor the day.
   */
  let wall = localDateTime(at.getTime())
  if (startOfDay(day) === startOfDay(now)) {
    for (let i = 0; i < 4 && (instantOf(wall) ?? 0) < now; i++) wall = wallPlus(wall, 30)
  }
  return { start: wall, end: wallPlusHour(wall) }
}



/**
 * An end moved to keep the length it had, for when the start is changed.
 *
 * What every calendar does, and its absence is what makes a two-field form
 * tedious: nudging a meeting an hour later should not mean re-typing when it
 * finishes. An end that was before its start had no length worth keeping, so it
 * comes back as an hour.
 */
export function keepDuration(
  prevStart: string,
  prevEnd: string,
  nextStart: string,
  tz?: string,
): string {
  const a = instantOf(prevStart, tz)
  const b = instantOf(prevEnd, tz)
  const c = instantOf(nextStart, tz)
  if (a === undefined || c === undefined) return prevEnd
  /*
   * A whole-day event moves by whole days and stays a pair of bare dates.
   *
   * Sent through the clock instead, the end came back as `2026-09-30T00:00` —
   * a datetime against a bare-date start, which is not a mixture `eventFor`
   * will take. It refuses the end, falls back to "one day", and a week away
   * turns into an afternoon.
   */
  if (BARE_DATE.test(prevStart) && BARE_DATE.test(prevEnd) && BARE_DATE.test(nextStart)) {
    if (b === undefined || b < a) return prevEnd
    return ymd(addDays(c, Math.round((b - a) / 86_400_000)))
  }
  // An hour on the clock rather than an hour of elapsed time, because that is
  // what "an hour long" means to the person who has to read it back.
  if (b === undefined || b <= a) return wallPlusHour(nextStart)
  /*
   * Written back in the chosen zone, since that is the clock the field shows;
   * in the device's zone it would be a different time on the face.
   */
  const proposed = wallClockIn(c + (b - a), tz)
  /*
   * And only if the clock face can still name it.
   *
   * One hour a year happens twice, and this format has one spelling for both.
   * An hour-long event moved to 01:30 on the morning the clocks go back ends at
   * the *second* 01:30 — which writes out as "01:30", reads back as the first,
   * and leaves an event that starts and finishes at the same moment. Zero
   * minutes long, silently, from a move that had nothing wrong with it.
   *
   * So the answer is read back before it is accepted, and when the spelling has
   * lost which of the two it meant, the length is kept on the clock face
   * instead: 01:30 to 02:30 is an hour to anybody reading it, and is a thing
   * the file can actually say.
   */
  if (instantOf(proposed, tz) === c + (b - a)) return proposed
  return wallPlus(nextStart, Math.max(wallMinutes(prevStart, prevEnd), 1))
}

/**
 * The nearest template at or above the folder, within `Calendar/`.
 *
 * A template is assigned to one folder by name, which is right everywhere else
 * and wrong here: `Calendar/2026/09` is not a folder anybody chose, it is where
 * September went, and a template assigned to a folder you never see is not a
 * feature. So the walk goes up — and stops at `Calendar/`, because a template
 * on the vault root is for notes at the vault root and an event is not one.
 */
function templateForEvent(folder: string, title: string, day: number): TemplateBody | undefined {
  for (
    let f = folder;
    f === CALENDAR_FOLDER || f.startsWith(`${CALENDAR_FOLDER}/`);
    f = dirname(f)
  ) {
    const t = templateBodyFor(f, title, day)
    if (t) return t
  }
  return undefined
}

/**
 * Move an event's start, and take its end with it.
 *
 * The properties form edits one key at a time and promises that what you did
 * not touch comes back byte for byte, which is the right promise for a form
 * over somebody's frontmatter. This is the one deliberate exception, for one
 * pair of keys, and it is worth saying why: the alternative is not "the end
 * stays put", it is *the duration silently becomes an hour*. An end left before
 * its start is not an error the file can hold — `eventFor` replaces it with an
 * hour — so moving a two-hour meeting from nine to two in the afternoon, and
 * touching nothing else, quietly made it one hour long.
 *
 * Only when both keys are already there and the start actually moves. An empty
 * `end:` is a template saying "an hour", and an hour follows a start on its
 * own.
 */
export function setEventStart(text: string, next: string): string {
  const fm = parseFrontmatter(text).data
  const prevStart = typeof fm.start === 'string' ? fm.start : ''
  const prevEnd = typeof fm.end === 'string' ? fm.end : ''
  /*
   * Only a zone that is one. The app deliberately keeps an unreadable `tz:` so
   * it can be shown as broken rather than silently ignored — which means one
   * can be sitting in a note, and handing it to anything that asks `Intl` about
   * it throws. Local time is the fallback everywhere else here; it is the
   * fallback here too.
   */
  const named = typeof fm.tz === 'string' ? fm.tz.trim() : ''
  const tz = named && isKnownZone(named) ? named : undefined
  const moved = setPropertyValue(text, 'start', next)
  if (!prevStart.trim() || !prevEnd.trim()) return moved
  const end = keepDuration(prevStart, prevEnd, next, tz)
  return end === prevEnd ? moved : setPropertyValue(moved, 'end', end)
}

/**
 * The zone a folder's template asks for, if it asks for one.
 *
 * Read so the dialog can *show* it rather than have it applied behind the
 * times you just typed. Somebody whose work calendar lives in another zone can
 * legitimately put one on their `Calendar/` template; what they cannot have is
 * it arriving silently.
 */
export function templateZoneFor(day: number): string | undefined {
  const t = templateForEvent(eventFolderFor(day), '', day)
  if (!t) return undefined
  const tz = readProperties(t.text).find((p) => p.key === 'tz')?.value.trim()
  return tz || undefined
}

/**
 * Every zone this engine knows, for a control that cannot be typo'd.
 *
 * `supportedValuesOf` is ES2022 and not everywhere yet, so a browser without it
 * gets the one zone it is certainly in rather than an empty list — the point is
 * to make a valid choice easy, and "where you are" is the valid choice that
 * matters most.
 */
export function knownZones(...also: Array<string | undefined>): string[] {
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone
  let all: string[] = []
  try {
    all =
      (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ??
      []
  } catch {
    /* fall through to the one zone we are certain of */
  }
  const out = all.length ? [...all] : []
  /*
   * `supportedValuesOf` lists the *canonical* zones, and a zone can be valid
   * without being on it — `UTC` is not there at all, and every alias a tzdata
   * rename leaves behind (`Asia/Calcutta`, `US/Eastern`) may or may not be.
   * A list that silently omits a name the app itself may be holding is a select
   * with nothing selected and a value that saves anyway.
   */
  for (const z of [here, 'UTC', ...also]) {
    if (z && isKnownZone(z) && !out.includes(z)) out.unshift(z)
  }
  return out
}

export interface NewEvent {
  path: string
  /** Where a template asked the caret to go, if it did. */
  caret?: number
}

/**
 * Write a new event and say where it landed.
 *
 * `start` and `end` arrive as the dialog's own field values — `2026-09-21T14:30`
 * for a time, `2026-09-21` for a whole day — and go into the file unchanged,
 * because they are already what `start:` is written as. Nothing is converted on
 * the way, so there is no format to get wrong between the control and the note.
 *
 * The *folder* comes from the start rather than from whatever day the calendar
 * was showing, so changing the date in the dialog files the note in that month.
 *
 * A template on `Calendar/` is picked up the way one on `Daily/` is, and is
 * given the moment the event starts — a meeting written up on Saturday for
 * Thursday is Thursday's, and `{{date}}` and `{{time}}` both have to agree with
 * what the dialog was told. Whatever the template carries is kept; `start:` and
 * `end:` are written over it, because those two are what was just asked for and
 * a template cannot know the answer.
 */
export async function newEventNote(
  title: string,
  start: string,
  end: string,
  tz?: string,
): Promise<NewEvent> {
  /*
   * Read back through `eventFor` rather than parsed again here, so the day this
   * is filed under is the same day the agenda will list it on — one parser, one
   * answer, including for a pair the dialog could not have produced.
   */
  const ev = eventFor({ start, end, ...(tz ? { tz } : {}) })
  const at = ev?.start ?? Date.now()
  const folder = eventFolderFor(at)
  const t = templateForEvent(folder, title, at)
  const body = t?.text ?? `# ${title}\n\n`
  /*
   * The title as typed, first, so the agenda has something better than the
   * filename to read it from. A filename is sanitised, cut to length and has a
   * date put on the end of it, and cannot say afterwards which of those parts
   * somebody typed — `eventTitle` reads it against this instead. Written over
   * whatever a template put there, for the reason the times are: the dialog
   * asked, and a template cannot know the answer.
   */
  const named = title.trim()
  let text = named ? setPropertyValue(body, 'title', named) : body
  text = setPropertyValue(text, 'start', start)
  text = setPropertyValue(text, 'end', end)
  /*
   * Written *or removed*, never left to whatever a template happened to say.
   *
   * A template carrying `tz: Asia/Tokyo` used to survive into the note beside
   * the times the dialog had just collected — and those times are a local wall
   * clock, so choosing the first of October at half past midnight in New York
   * produced an event on the thirtieth of September at half eleven in the
   * morning, filed in a folder that still said October. The dialog asked, so
   * the dialog's answer stands; a template cannot know it.
   */
  text = tz ? setPropertyValue(text, 'tz', tz) : removeProperty(text, 'tz')
  return {
    path: await createNote(folder, title, text, (n) => eventNoteName(title, start, n)),
    caret: t?.caret === undefined ? undefined : t.caret + (text.length - body.length),
  }
}
