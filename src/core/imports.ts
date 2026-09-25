/**
 * What you do with a note an importer owns: write your own notes about it, or
 * take it off the importer's hands.
 *
 * The importer files what it writes under folders of its own —
 * `Calendar/Subscribed/<Account>/…` and `Contacts/Address Book/<Account>/…` —
 * so that everything in them is the importer's and emptying one clears it. Your
 * writing belongs where hand-made events already live, `Calendar/<year>/<month>`,
 * and so does anything you detach: a detached note left among the imports would
 * go with them the day that folder is emptied.
 *
 * Nothing here reads those folder names, and nothing should. What a note *is*
 * comes from its frontmatter (`source:` with `uid:`, `start:`); where it goes is
 * worked out from that, so the importer's folders can be called anything.
 *
 * Kept out of vault.ts for the reason eventnote.ts is: this end decides where
 * files go and imports the vault to put them there.
 */

import { eventFor, parseFrontmatter, type FrontmatterValue } from './markdown'
import { setPropertyValue } from './properties'
import { eventFolderFor, eventNoteName } from './eventnote'
import { eventTitle } from './eventname'
import { persistFolders } from './folders'
import { splitWikiInner, formatWikiLink } from './wikilink'
import {
  backlinkMap,
  collisionNamesFor,
  createNote,
  detachNote,
  getEntry,
  getText,
  isExternal,
  linkNameFor,
  occupied,
  relocateNote,
  resolveLink,
} from './vault'
import { basename, joinPath, ymd } from './util'
import type { NoteIndexEntry } from './types'

/** Where a detached contact goes: beside the ones you keep by hand (§2.2). */
export const CONTACTS_FOLDER = 'Contacts'

/**
 * The day an event is on, as its own `start:` writes it.
 *
 * Off the text rather than off the parsed instant: a zoned event's wall clock
 * in its own zone can fall on a different date from the one it lands on here,
 * and the name is made from what the file says — the same rule
 * `newEventNote` names a hand-made event by.
 */
function startDate(data: Record<string, FrontmatterValue>, event: { start: number }): string {
  const raw = typeof data.start === 'string' ? data.start.trim() : ''
  return /^\d{4}-\d{2}-\d{2}/.exec(raw)?.[0] ?? ymd(event.start)
}

/** What an event is called: what the importer recorded, or its filename read by shape. */
function meetingTitle(entry: NoteIndexEntry): string {
  return entry.event?.title?.trim() || eventTitle(entry.title, entry.event?.title)
}

/* ------------------------------------------------------------------ detach */

/**
 * Detach a note and file it where your own notes of its kind live. Resolves to
 * where it ended up, or undefined when there was nothing to detach.
 *
 * An event goes to `Calendar/<year>/<month>/` under the name `>New event` would
 * have given it — `Standup - 2026-09-21` rather than the importer's
 * `Standup (a41b)` — so it reads and sorts like the rest of that folder. A
 * contact goes to `Contacts/`, keeping its name, which is the link target.
 *
 * Detached first and moved second. The other way round, a move that landed
 * and a detach that did not would leave a note the importer still claims in
 * the middle of your own; this way round, the worst case is a note that is
 * yours but still sitting in the importer's folder.
 *
 * The move goes through `relocate`, so every link to the note follows it. The
 * importer, finding its file gone, writes the meeting afresh where it was
 * (docs/calendar-contacts.md, §6.2): the copy you detached stops changing, and
 * the live one keeps up with the calendar.
 */
export async function detachAndFile(path: string): Promise<string | undefined> {
  if (!(await detachNote(path))) return undefined
  const entry = getEntry(path)
  const text = getText(path)
  if (!entry || text === undefined) return path

  const data = parseFrontmatter(text).data
  const event = eventFor(data)
  let folder: string
  let nameFor: (n: number) => string
  if (event) {
    const title = meetingTitle(entry)
    const day = startDate(data, event)
    folder = eventFolderFor(event.start)
    nameFor = (n) => `${eventNoteName(title, day, n)}.md`
  } else {
    folder = CONTACTS_FOLDER
    const again = collisionNamesFor(path)
    nameFor = (n) => (n === 1 ? basename(path) : again(n))
  }

  /*
   * Chosen and handed to `relocate` in the same tick: it checks and reserves
   * the destination before its first await, so nothing can take the name in
   * between. A note already where it would go stays put.
   */
  let dest = joinPath(folder, nameFor(1))
  for (let n = 2; dest !== path && occupied(dest); n++) dest = joinPath(folder, nameFor(n))
  if (dest === path) return path
  await relocateNote(path, dest)
  await persistFolders()
  return dest
}

/* ------------------------------------------------------------- write notes */

/** Your own notes about a meeting: the ones whose `meeting:` names it. */
export function notesForMeeting(meeting: string): string[] {
  const out: string[] = []
  for (const p of backlinkMap.value.get(meeting) ?? []) {
    const e = getEntry(p)
    if (!e || isExternal(e)) continue
    const m = parseFrontmatter(getText(p) ?? '').data.meeting
    const link = typeof m === 'string' ? /^\s*\[\[(.*)\]\]\s*$/.exec(m)?.[1] : undefined
    if (link !== undefined && resolveLink(splitWikiInner(link).target) === meeting) out.push(p)
  }
  return out.sort()
}

/**
 * The note to write about a meeting in: the one you already have, or a new
 * one. `created` says which, so the caller knows whether to open it for typing.
 *
 * A new one is filed on the meeting's day in `Calendar/<year>/<month>/` and
 * carries two things: `date:`, which puts it in that day's list and on the
 * calendar under that day, and `meeting:`, the link back — which is what puts
 * it at the top of the meeting's Linked Mentions, and how the next press finds
 * it again rather than making a second.
 *
 * No `start:`, and so no folder template: the one on `Calendar/` opens with a
 * `start:`, and that would make your notes an event of their own — the same
 * meeting twice on the agenda.
 */
export async function notesAboutMeeting(
  meeting: string,
): Promise<{ path: string; created: boolean } | undefined> {
  const entry = getEntry(meeting)
  const text = getText(meeting)
  if (!entry?.event || text === undefined) return undefined
  const existing = notesForMeeting(meeting)
  if (existing.length) return { path: existing[0], created: false }

  const title = meetingTitle(entry)
  const day = startDate(parseFrontmatter(text).data, entry.event)
  let body = setPropertyValue(`# ${title}\n\n`, 'date', day)
  body = setPropertyValue(body, 'meeting', formatWikiLink({ target: linkNameFor(meeting) }))
  const path = await createNote(eventFolderFor(entry.event.start), title, body, (n) =>
    eventNoteName(title, day, n),
  )
  return { path, created: true }
}
