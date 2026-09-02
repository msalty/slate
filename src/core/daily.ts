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
 * The path of a day's daily note, creating the note if it doesn't exist yet.
 * Callers that need to know which of the two happened should check
 * `dailyNoteFor` first.
 */
export async function dailyNotePath(day: number): Promise<string> {
  const existing = dailyNoteFor(day)
  if (existing) return existing.path
  const name = dailyNoteName(day)
  return createNote(DAILY_FOLDER, name, `# ${name}\n\n`)
}
