/**
 * Daily notes.
 *
 * One note per calendar day, named `YYYY-MM-DD` so that `calendarDateFor`
 * files it under that day no matter when the file was actually created — a
 * note written on Sunday about Friday still belongs to Friday.
 *
 * The lookup is title-based rather than path-based on purpose: a vault that
 * already keeps its daily notes somewhere other than `Daily/` should be found,
 * not shadowed by a second empty note in a folder the user never chose.
 */

import type { NoteIndexEntry } from './types'
import { startOfDay, ymd } from './util'
import { createNote, notes } from './vault'
import { templateBodyForDay } from './templates'

/** Where a daily note is created when there isn't one yet. */
export const DAILY_FOLDER = 'Daily'

/** The day a daily note is named for, as the file name uses it. */
export function dailyNoteName(day: number): string {
  return ymd(startOfDay(day))
}

/** A day's daily note, if the vault already has one. */
export function dailyNoteFor(day: number): NoteIndexEntry | undefined {
  const name = dailyNoteName(day)
  const hits = notes.value.filter((n) => n.title === name)
  // A note in the daily folder wins over a same-named one elsewhere.
  return hits.find((n) => n.folder === DAILY_FOLDER) ?? hits[0]
}

/**
 * The path of a day's daily note, creating the note if it doesn't exist yet,
 * and where the caret belongs in a note that was just created.
 *
 * A template on `Daily/` is what this is really for. Every daily note used to
 * start life as a bare `# 2026-09-04` and nothing else, which the README has
 * had on its list of gaps since the calendar was written. The date handed to
 * the template is *the day the note is for*, not today: a note written on
 * Saturday about Thursday is Thursday's, and its `{{date}}` has to agree with
 * the name on the file.
 */
export async function dailyNotePath(day: number): Promise<DailyNote> {
  const existing = dailyNoteFor(day)
  if (existing) return { path: existing.path, created: false }
  const name = dailyNoteName(day)
  const t = templateBodyForDay(DAILY_FOLDER, name, day)
  return {
    path: await createNote(DAILY_FOLDER, name, t?.text ?? `# ${name}\n\n`),
    created: true,
    caret: t?.caret,
  }
}

export interface DailyNote {
  path: string
  /** False when the day already had one, so nothing was written. */
  created: boolean
  /** Where a template asked the caret to go, if it did. */
  caret?: number
}
