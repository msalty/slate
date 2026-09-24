/**
 * An event's filename, in both directions.
 *
 * `Lunch with Joe - 2026-09-22.md` is written by `eventNoteName` and read back
 * into `Lunch with Joe` by `eventTitle`, and the two live side by side because
 * they have to be exact inverses and were not while they lived apart. Each time
 * one was fixed the other was found to disagree with it one case further out:
 * a long title lost its date to the length cap, a title ending in a date lost
 * that date on the agenda, a title beginning with one lost its front.
 *
 * Those were all one problem. A filename cannot say which of its parts
 * somebody typed and which were added to it, because any shape this writes is
 * also a shape a person can type. So a new event also records its title in
 * `title:`, and the name is read against that record instead of guessed at.
 * Guessing is kept only for notes made before there was a record — none of
 * which ever left the branch this feature was built on.
 *
 * Kept free of the vault so the agenda can read a name without loading
 * everything that writes one.
 */

import { SEGMENT_MAX, fitSegment, numberedSegment, safeSegment } from './util'

/** The date at the head of a `start:` value, whether or not a clock follows. */
const DATE_HEAD = /^(\d{4}-\d{2}-\d{2})/

/**
 * What you called it, and the day it is on — `Lunch with Joe - 2026-09-22`.
 *
 * The date is a *suffix* and the distinction is the whole of why it is here at
 * all: stamped on the front, as it was first built, it pushed the name out of
 * every list that shows one, and the agenda rail — the narrowest of them, one
 * line with an ellipsis — showed the date and then ran out of room before
 * reaching the thing you named.
 *
 * What was wrong with the prefix is still wrong. A filename does not follow the
 * frontmatter, so this date stops being true the moment the event moves, and
 * moving one is a two-second job now the properties form has a picker on it.
 * It is left stale on purpose rather than chased: a rename breaks every
 * `[[link]]` pointing at the note, and the agenda has never read the date — it
 * takes the clock and the day off `start:`.
 *
 * What changed is what the alternative turned out to cost. Collisions are per
 * *folder*, and the folder is `Calendar/<year>/<month>`, so a weekly lunch was
 * `Lunch with Joe`, `Lunch with Joe 2`, `Lunch with Joe 3` through September —
 * and then began again at `Lunch with Joe` in October, because that is a
 * different directory. The same series, numbered differently every month, with
 * nothing in any of the names saying which occurrence it was.
 *
 * It still costs the bare name: there is no `Lunch with Joe.md` for
 * `[[Lunch with Joe]]` to land on, so a link to one occurrence names its date
 * or goes through `aliases:`.
 *
 * `start` is the dialog's own field value — `2026-09-22T14:00` or a bare
 * `2026-09-22` — and only its date is used, so the name says exactly what
 * `start:` says and no zone arithmetic happens on the way.
 *
 * `n` is the attempt, for when the name is taken: the second of two on one day
 * is `Lunch with Joe - 2026-09-22 2`. Everything that follows the title is
 * reserved out of the length budget *before* the title is cut, because
 * `safeSegment` caps a segment at 120 and whatever comes last is what a cap
 * removes — first the date went, and then, once the date had room, the
 * counter pushed a long name to 122.
 *
 * A title that already ends in a date is still given one:
 * `Postmortem - 2026-09-22 - 2026-09-22`. Silly to look at, and it keeps the
 * name mechanical — the part this adds is always exactly the last part.
 */
export function eventNoteName(title: string, start?: string, n = 1): string {
  const safe = safeSegment(title)
  const on = DATE_HEAD.exec(start?.trim() ?? '')?.[1]
  if (!on) return numberedSegment(safe, n)
  const tail = ` - ${on}${n > 1 ? ` ${n}` : ''}`
  return `${fitSegment(safe, SEGMENT_MAX - tail.length)}${tail}`
}

/** What `eventNoteName` adds, taken apart: the title part, the date, the counter. */
const SUFFIX_RE = /^(.*) - (\d{4}-\d{2}-\d{2})(?: (\d+))?$/

/**
 * The name to try on the `n`th attempt, for a note that already has one and is
 * going somewhere it is taken — a folder move, or back out of the trash.
 *
 * A counter makes room for itself by cutting the end of the name, which is
 * right for a name that is only a title and wrong for an event's: the end is
 * the date. A 120-character event moved into a folder that held its twin came
 * out `… - 2026-09- 2`, and the agenda, finding a name nothing would have
 * made, showed the whole mangled filename. So a name in the shape
 * `eventNoteName` makes is made again by it, and the title gives up the room.
 *
 * From the recorded title, when the name is still the one made from it: cut
 * from the whole of it, the new name is also what the record would make, so
 * the agenda goes on reading the event by what was typed.
 */
export function nameAfterCollision(stem: string, recorded?: string): (n: number) => string {
  const m = SUFFIX_RE.exec(stem)
  if (!m) return (n) => numberedSegment(stem, n)
  const date = m[2]
  const made = recorded && eventNoteName(recorded, date, m[3] ? Number(m[3]) : 1) === stem
  const title = made ? recorded : m[1]
  return (n) => eventNoteName(title, date, n)
}

/**
 * `2026-09-21 0930 Standup` — where the stamp went while it went on the front.
 *
 * Followed by a title, and a title does not begin with a dash: without that,
 * a note called nothing but `2026-09-22` — named `2026-09-22 - 2026-09-22` —
 * read as a stamp on the front of a meeting called `- 2026-09-22`.
 */
const HEAD_RE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{4})?\s+(?!-\s)/
/** `Standup - 2026-09-21`, with or without a counter after it. */
const TAIL_RE = /\s+-\s+\d{4}-\d{2}-\d{2}(?:\s+\d+)?$/

/**
 * What an event is called, on a list that already knows the day.
 *
 * `name` is the filename and `recorded` is the event's own `title:`. When the
 * filename is exactly what that title would have been named — date, counter,
 * length cut and all — the record is what it is called, character for
 * character: the colon a filename cannot hold, the end of a title too long for
 * one, a date the person typed on the end of it themselves. Nothing is guessed.
 *
 * When the filename is anything else, the filename wins, because a note's name
 * *is* its filename everywhere else in the app. That is what makes renaming an
 * event from the editor's header work: the new name no longer matches the
 * record, and the agenda follows the file rather than showing what it used to
 * be called. It is also why editing `title:` by hand does not rename anything —
 * it is a record of what was typed, not a second name that could disagree with
 * the first on every surface but this one.
 *
 * Without a record — a note made before there was one, or by hand — the name is
 * read the old way, by shape. The front first: a note stamped on the front is
 * the only kind that had a date-and-time there, while a date on the end is a
 * thing people type as readily as this ever wrote it. That makes
 * `2026-09-21 0930 Postmortem - 2026-09-22`, an old note with a date in its
 * title, read as `Postmortem - 2026-09-22`. The same filename could also be a
 * new note whose title began with a timestamp; no reading of a name alone can
 * tell those apart, which is the reason the record exists.
 *
 * A date is only taken off when something is left after it — a note genuinely
 * called `2026-09-21` keeps its name rather than losing it.
 */
export function eventTitle(name: string, recorded?: string): string {
  if (recorded) {
    const m = SUFFIX_RE.exec(name)
    if (m && eventNoteName(recorded, m[2], m[3] ? Number(m[3]) : 1) === name) return recorded
  }
  const head = name.replace(HEAD_RE, '')
  const stripped = head !== name ? head : name.replace(TAIL_RE, '')
  return stripped || name
}
