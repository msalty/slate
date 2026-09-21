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

import { eventFor } from './markdown'
import { readProperties, removeProperty, setPropertyValue } from './properties'
import { templateBodyFor } from './templates'
import { createNote } from './vault'
import { dirname, roundUpToHalfHour, startOfDay, ymd } from './util'
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

/**
 * An event is called what you called it.
 *
 * Nothing is stamped onto the front of it — not the time, and not the date
 * either. A filename does not follow the frontmatter, so anything about *when*
 * written into the name is a claim that stops being true the moment the event
 * moves, and moving one is a two-second job now the properties form has a
 * picker on it. Worse, it was wrong in all the places the name shows — the note
 * list, the editor's header, search, every `[[link]]` — and invisible in the
 * one place it was right, since the agenda reads the clock and the day off
 * `start:`.
 *
 * What that costs is real and worth saying: a weekly standup is twelve notes
 * called Standup, and `[[Standup]]` can only mean one of them. Two in one month
 * get the `2` that every name collision in the vault gets; two in different
 * months are two files with one name. `aliases:` or a rename is the way out for
 * an occurrence worth linking to on its own.
 */
export function eventNoteName(title: string): string {
  return title.trim()
}

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

/** The instant a `datetime-local` or `date` value names, read as local time. */
export function parseLocal(value: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(value.trim())
  if (!m) return undefined
  const at = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] ?? 0),
    Number(m[5] ?? 0),
  )
  return Number.isNaN(at.getTime()) ? undefined : at.getTime()
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
  const end = new Date(at)
  end.setHours(end.getHours() + 1)
  return { start: localDateTime(at.getTime()), end: localDateTime(end.getTime()) }
}

/**
 * An end moved to keep the length it had, for when the start is changed.
 *
 * What every calendar does, and its absence is what makes a two-field form
 * tedious: nudging a meeting an hour later should not mean re-typing when it
 * finishes. An end that was before its start had no length worth keeping, so it
 * comes back as an hour.
 */
export function keepDuration(prevStart: string, prevEnd: string, nextStart: string): string {
  const a = parseLocal(prevStart)
  const b = parseLocal(prevEnd)
  const c = parseLocal(nextStart)
  if (a === undefined || c === undefined) return prevEnd
  if (b === undefined || b <= a) {
    const end = new Date(c)
    end.setHours(end.getHours() + 1)
    return localDateTime(end.getTime())
  }
  return localDateTime(c + (b - a))
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
export function knownZones(): string[] {
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone
  try {
    const all = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.(
      'timeZone',
    )
    if (all?.length) return all.includes(here) ? all : [here, ...all]
  } catch {
    /* fall through */
  }
  return [here]
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
  let text = setPropertyValue(body, 'start', start)
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
    path: await createNote(folder, eventNoteName(title), text),
    caret: t?.caret === undefined ? undefined : t.caret + (text.length - body.length),
  }
}
