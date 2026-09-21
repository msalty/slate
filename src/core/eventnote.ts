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

import { templateBodyFor } from './templates'
import { createNote } from './vault'
import { dirname, startOfDay, ymd } from './util'
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
 * `2026-09-21 Design review`.
 *
 * The **date** is in the name because a note's title is its filename, and
 * `titleIndex` gives a contested name to one note and leaves the other
 * unreachable by it — so a weekly standup needs twelve distinguishable names
 * or eleven of its notes cannot be linked to.
 *
 * The **time** is deliberately not, though it was at first. A filename does not
 * follow the frontmatter, so a meeting moved from the morning to the afternoon
 * keeps a name that says 0930 for as long as the note exists — and moving one
 * is a two-second job now that the properties form has a picker on it. Worse,
 * the stale time is invisible exactly where it would be right: the agenda
 * strips the stamp and reads the clock off `start:`. So it was hidden where it
 * was true and shown in the note list, the editor's header, search results and
 * every `[[link]]`, where it could be wrong. Two events with one name on one
 * day get the `2` that every other name collision in the vault gets, and a `2`
 * at least never claims something false.
 */
export function eventNoteName(title: string, day: number): string {
  return `${ymd(day)} ${title}`.trim()
}

/**
 * The frontmatter a new event opens with.
 *
 * `end:` is written out rather than left to the hour `eventFor` would assume,
 * because the first thing anybody does to a new meeting is say how long it is,
 * and a key that is already there is easier to change than one you have to
 * know the name of.
 */
export function eventFrontmatter(day: number, start: string, end: string): string {
  const date = ymd(startOfDay(day))
  return `---\nstart: ${date}T${start}\nend: ${date}T${end}\n---\n\n`
}

const FENCE_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/**
 * Put the keys a template did not write above the ones it did.
 *
 * The rule is the template's: whatever it says stands, and this only supplies
 * what is missing. A template is free to write its own `start:` — the Meeting
 * one does — and getting a second copy of it from here would be one block with
 * the same key in it twice, which is a file that reads as though somebody lost
 * an argument with their editor.
 *
 * A key counts as written even when it is left empty. `end:` with nothing after
 * it is a template saying "fill this in", not a template forgetting to.
 */
export function withFrontmatter(body: string, keys: Array<[string, string]>): string {
  const m = FENCE_RE.exec(body)
  if (!m) return `---\n${keys.map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n${body}`
  const missing = keys.filter(([k]) => !new RegExp(`^${k}\\s*:`, 'm').test(m[1]))
  if (missing.length === 0) return body
  return `---\n${missing.map(([k, v]) => `${k}: ${v}`).join('\n')}\n${body.slice(4)}`
}

/** `09:30` as minutes past midnight, for placing a wall clock on a day. */
function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/** An hour later, as a wall clock, rolling over midnight rather than past it. */
export function anHourAfter(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  return `${`${(h + 1) % 24}`.padStart(2, '0')}:${`${m}`.padStart(2, '0')}`
}

/**
 * The next round half hour, which is when a meeting made now is going to be.
 *
 * Nobody schedules anything for 14:07. Rounding up rather than to the nearest
 * also means the suggestion is never a time that has already gone.
 */
export function nextHalfHour(now = Date.now()): string {
  const d = new Date(now)
  d.setMinutes(d.getMinutes() > 30 ? 60 : 30, 0, 0)
  return `${`${d.getHours()}`.padStart(2, '0')}:${`${d.getMinutes()}`.padStart(2, '0')}`
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

export interface NewEvent {
  path: string
  /** Where a template asked the caret to go, if it did. */
  caret?: number
}

/**
 * Write a new event for a day and say where it landed.
 *
 * A template on `Calendar/` is picked up the way one on `Daily/` is, and is
 * given the *event's* day rather than today — a meeting written up on Saturday
 * for Thursday is Thursday's, and its `{{date}}` has to agree with the name on
 * the file. What the template does not carry, the frontmatter above supplies:
 * an event with no `start:` is not an event, so it is never left to boilerplate
 * to remember.
 */
export async function newEventNote(
  title: string,
  day: number,
  start = nextHalfHour(),
): Promise<NewEvent> {
  const folder = eventFolderFor(day)
  const name = eventNoteName(title, day)
  const date = ymd(startOfDay(day))
  /*
   * The template is given the moment the event *starts*, not the midnight it
   * falls after. `{{date}}` is the same either way and `{{time}}` is not: it
   * came out as `00:00` on every event ever made, which is a field that looks
   * filled in and says nothing.
   */
  const t = templateForEvent(folder, title, startOfDay(day) + minutesOf(start) * 60_000)
  const body = t?.text ?? `# ${title}\n\n`
  const text = withFrontmatter(body, [
    ['start', `${date}T${start}`],
    ['end', `${date}T${anHourAfter(start)}`],
  ])
  return {
    path: await createNote(folder, name, text),
    caret: t?.caret === undefined ? undefined : t.caret + (text.length - body.length),
  }
}
