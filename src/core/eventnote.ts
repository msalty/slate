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
 * `2026-09-21 0930 Design review`, or `2026-09-21 Office closed` for a day.
 *
 * The time is in the name and not only in the frontmatter because a note's
 * title *is* its filename, and `titleIndex` gives a contested name to one note
 * and leaves the other unreachable by it. Two standups on one day is not an
 * unusual vault, it is a Tuesday.
 */
export function eventNoteName(title: string, day: number, time?: string): string {
  const stamp = time ? `${ymd(day)} ${time.replace(':', '')}` : ymd(day)
  return `${stamp} ${title}`.trim()
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
  const name = eventNoteName(title, day, start)
  const front = eventFrontmatter(day, start, anHourAfter(start))
  const t = templateForEvent(folder, title, startOfDay(day))
  const body = t?.text ?? `# ${title}\n\n`
  /*
   * A template that already opens with its own frontmatter would otherwise get
   * a second block above it, and two `---` fences at the top of a file is one
   * block with the second one's keys read as text. The template wins the shape
   * and the `start:` is folded into it.
   */
  const text = body.startsWith('---\n')
    ? body.replace('---\n', `---\n${front.slice(4, front.indexOf('\n---\n') + 1)}`)
    : front + body
  return {
    path: await createNote(folder, name, text),
    caret: t?.caret === undefined ? undefined : t.caret + (text.length - body.length),
  }
}
