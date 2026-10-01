/**
 * What you do with a note an importer owns: write your own notes about it, or
 * take it off the importer's hands.
 *
 * The importer files what it writes under folders of its own — meetings in
 * `backstage/calendar/<Account>/…`, out of every list and search and reached
 * from the agenda, contacts in `Contacts/Address Book/<Account>/…` — so that
 * everything in them is the importer's and emptying one clears it. Your
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

import { computed } from '@preact/signals'
import { eventFor, parseFrontmatter, type FrontmatterValue } from './markdown'
import { setPropertyValue } from './properties'
import { eventFolderFor, eventNoteName } from './eventnote'
import { eventTitle } from './eventname'
import { moveNoteToFolder } from './folders'
import { splitWikiInner, formatWikiLink } from './wikilink'
import {
  backstageEvents,
  createNote,
  detachNote,
  getEntry,
  getText,
  isExternal,
  isHidden,
  linkableNotes,
  occupied,
  linkNameFor,
  resolveLink,
} from './vault'
import { ymd } from './util'
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
  return (
    entry.event?.title?.trim() ||
    eventTitle(entry.title, entry.event?.title, entry.source !== undefined)
  )
}

/* ------------------------------------------------------------------ kinds */

/**
 * What an import is, by the one rule everything that treats meetings and
 * people differently shares: no `start:` at all is a person; a `start:` that
 * reads as a time is a meeting; a `start:` nobody can read is a meeting with a
 * broken time — never a person. Write notes and Detach each once had a rule of
 * their own, and Detach's took every unreadable meeting for a contact: it moved
 * it into `Contacts/` and took its ownership keys away.
 */
export type ImportKind = 'meeting' | 'contact' | 'broken-meeting'

export function importKind(path: string): ImportKind | undefined {
  const entry = getEntry(path)
  const text = getText(path)
  if (!entry || entry.source === undefined || text === undefined) return undefined
  if (entry.event) return 'meeting'
  return 'start' in parseFrontmatter(text).data ? 'broken-meeting' : 'contact'
}

/** Refused, with what to do about it: a meeting whose time cannot be read. */
export class BrokenMeetingError extends Error {
  constructor(path: string, doing: 'detach' | 'notes') {
    super(
      `"${getEntry(path)?.title ?? path}" has a start time Slate can't read. Fix the time in the ` +
        `calendar it comes from; once it syncs you can ${doing === 'detach' ? 'detach it' : 'write notes on it'}.`,
    )
    this.name = 'BrokenMeetingError'
  }
}

/**
 * A Detach that moved the note but could not take the importer's keys off it.
 * Carries where it went: the note is in your own folder, still an import and
 * still read-only, and pressing Detach there again finishes the job.
 */
export class DetachIncompleteError extends Error {
  constructor(readonly dest: string) {
    super(`Moved to ${dest}, but it is still kept up to date by its importer.`)
    this.name = 'DetachIncompleteError'
  }
}

/* ------------------------------------------------------------------ detach */

/**
 * Detach a note and file it where your own notes of its kind live. Resolves to
 * where it ended up, or undefined when nothing owns it.
 *
 * An event goes to `Calendar/<year>/<month>/` under the name `>New event` would
 * have given it — `Standup - 2026-09-21` rather than the importer's
 * `Standup (a41b)` — so it reads and sorts like the rest of that folder. A
 * contact goes to `Contacts/`, keeping its name, which is the link target.
 *
 * Moved first and detached second. The other way round, a move that failed
 * left a meeting that was no longer an import in backstage — off the agenda,
 * because the agenda takes only imports from there, and off every list and
 * search, because it is backstage: a note nothing on screen could reach. This
 * way round, a move that fails changes nothing, and a detach that fails after
 * it leaves an import in your own folder, still read-only and still one press
 * from detaching — the importer follows a moved file by its `uid:` (§6.2), so
 * nothing is duplicated in the meantime.
 *
 * The move goes through `relocate`, so every link to the note follows it. Once
 * detached, the importer finds no file with the record's `uid:` and writes the
 * meeting afresh (docs/calendar-contacts.md, §6.2): the copy you detached stops
 * changing, and the live one keeps up with the calendar.
 */
export async function detachAndFile(path: string): Promise<string | undefined> {
  const kind = importKind(path)
  if (!kind) return undefined
  if (kind === 'broken-meeting') throw new BrokenMeetingError(path, 'detach')
  const entry = getEntry(path)!
  const text = getText(path)!

  const data = parseFrontmatter(text).data
  const event = eventFor(data)
  const dest = event
    ? await moveNoteToFolder(
        path,
        eventFolderFor(event.start),
        (n) => `${eventNoteName(meetingTitle(entry), startDate(data, event), n)}.md`,
      )
    : await moveNoteToFolder(path, CONTACTS_FOLDER)
  /*
   * Checked rather than assumed. A file deleted by a sync as the move began is
   * moved nowhere, and the destination it was given is a path with nothing at
   * it; reporting that as detached opened a note that did not exist.
   */
  if (!occupied(dest)) throw new Error(`"${entry.title}" was gone before it could be moved.`)
  try {
    await detachNote(dest)
  } catch {
    throw new DetachIncompleteError(dest)
  }
  if (getEntry(dest)?.source !== undefined) throw new DetachIncompleteError(dest)
  return dest
}

/* ------------------------------------------------------------- write notes */

/**
 * Your own notes on each note they are *about*, by the property that says so:
 * `meeting:` for a meeting, `contact:` for a person. Keyed
 * `<key>\u0000<record>` (see `recordOf`).
 *
 * The property is what says "these are my notes on this"; a note that merely
 * mentions something in passing does not count. Worked out once per change to
 * the vault, each note read once — not once per import it links to, which is
 * what walking the backlinks did — and only the notes whose frontmatter has
 * one of the two keys are parsed at all. Not only for imports: a person you
 * have detached is still the person your notes are about, and those notes
 * still go first in their mentions.
 */
const notesNamed = computed(() => {
  const out = new Map<string, string[]>()
  for (const e of linkableNotes.value) {
    if (isExternal(e) || !e.links.length) continue
    const text = getText(e.path) ?? ''
    if (!/^(meeting|contact):/m.test(text)) continue
    const data = parseFrontmatter(text).data
    for (const key of ['meeting', 'contact']) {
      const v = data[key]
      const link = typeof v === 'string' ? /^\s*\[\[(.*)\]\]\s*$/.exec(v)?.[1] : undefined
      const target = link === undefined ? undefined : resolveLink(splitWikiInner(link).target)
      if (!target) continue
      const k = `${key}\u0000${recordOf(target)}`
      const list = out.get(k)
      if (!list) out.set(k, [e.path])
      else if (!list.includes(e.path)) list.push(e.path)
    }
  }
  for (const list of out.values()) list.sort()
  return out
})

function notesNaming(key: string, target: string): string[] {
  return notesNamed.value.get(`${key}\u0000${recordOf(target)}`) ?? []
}

/**
 * The record an import stands for — its `source:` and `uid:` — or, for any
 * other note, its path.
 *
 * Notes are kept against the record rather than the file, because one record
 * can have two files: a trashed meeting restored beside the copy the importer
 * wrote afresh, or a sync conflict copy. The agenda shows one row per record
 * (`eventsByDay`), and notes written from the other copy were not that row's —
 * its pencil stayed unlit, and pressing it made a second `… 2.md`.
 */
function recordOf(path: string): string {
  const e = getEntry(path)
  return e?.source !== undefined ? `record\u0000${e.source}\u0000${e.uid}` : `path\u0000${path}`
}

/**
 * The copy of an import everything else should use: where a record has two
 * files, the importer's own (the one in backstage), or failing that the first
 * by path — the same one the agenda shows (`eventsByDay`). Notes are written
 * against it, so they link to the copy that stays when the other is cleared
 * away, and two presses on the two copies are one request, not two notes.
 */
const canonical = computed(() => {
  const out = new Map<string, string>()
  for (const e of [...linkableNotes.value, ...backstageEvents.value]) {
    if (e.source === undefined) continue
    const k = recordOf(e.path)
    const other = out.get(k)
    const better =
      !other || (isHidden(e.path) !== isHidden(other) ? isHidden(e.path) : e.path < other)
    if (better) out.set(k, e.path)
  }
  return out
})

export function canonicalCopy(path: string): string {
  return getEntry(path)?.source === undefined ? path : (canonical.value.get(recordOf(path)) ?? path)
}

/** Your own notes about a meeting: the ones whose `meeting:` names it. */
export function notesForMeeting(meeting: string): string[] {
  return notesNaming('meeting', meeting)
}

/** Your own notes about a person: the ones whose `contact:` names them. */
export function notesForContact(contact: string): string[] {
  return notesNaming('contact', contact)
}

/**
 * The note to write about an import in — a meeting, or a person (see
 * `contactNotes` at the end) — the one you already have, or a new one.
 * `created` says which, so the caller knows whether to open it for typing.
 *
 * For a meeting:
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
export function notesAbout(
  imported: string,
): Promise<{ path: string; created: boolean } | undefined> {
  /*
   * One at a time per import. The look for existing notes and the note made
   * when there are none are an await apart, so a double press — or the banner
   * and the agenda pencil in quick succession — both found none and made two.
   * A press while one is under way gets that one's answer.
   */
  const target = canonicalCopy(imported)
  const running = inFlight.get(target)
  if (running) return running
  const p = findOrMake(target).finally(() => inFlight.delete(target))
  inFlight.set(target, p)
  return p
}

const inFlight = new Map<string, Promise<{ path: string; created: boolean } | undefined>>()

async function findOrMake(
  imported: string,
): Promise<{ path: string; created: boolean } | undefined> {
  const kind = importKind(imported)
  if (!kind) return undefined
  // Said, not swallowed: the button was there, and pressing it did nothing.
  if (kind === 'broken-meeting') throw new BrokenMeetingError(imported, 'notes')
  const entry = getEntry(imported)!
  const text = getText(imported)!
  if (kind === 'contact') return contactNotes(imported, entry)
  if (!entry.event) return undefined // a meeting always has one; this tells the type so
  const meeting = imported
  const existing = notesForMeeting(meeting)
  if (existing.length) return { path: existing[0], created: false }

  const title = meetingTitle(entry)
  const data = parseFrontmatter(text).data
  const day = startDate(data, entry.event)
  /*
   * Filed under the day the meeting is on *here*, which is the day the agenda
   * lists it under and the folder it goes in — not the date its own zone
   * writes. A 00:30 Tokyo meeting on the first of October is on the thirtieth
   * of September in New York, and notes dated the first were filed in
   * September's folder and missing from the day the meeting was shown on. The
   * name keeps the meeting's own date, as a hand-made event's does.
   */
  let body = setPropertyValue(`# ${title}\n\n`, 'date', ymd(entry.event.start))
  body = setPropertyValue(body, 'meeting', formatWikiLink({ target: linkNameFor(meeting) }))
  /*
   * Who was there, copied from the meeting as it is now. The meeting lives in
   * backstage, so its own `attendees:` are no one's mentions — which is the
   * point: a contact's mentions were two hundred meetings they only sat
   * through. Your notes carry the list instead, so a person's mentions are
   * the meetings you wrote something about. A copy, not a live view: notes
   * from the day say who was there that day.
   */
  const attendees = Array.isArray(data.attendees)
    ? data.attendees.map((a) => String(a).trim()).filter(Boolean)
    : []
  if (attendees.length) body = setPropertyValue(body, 'attendees', attendees)
  const path = await createNote(eventFolderFor(entry.event.start), title, body, (n) =>
    eventNoteName(title, day, n),
  )
  return { path, created: true }
}

/**
 * The note to write about a person in — the one you have, or a new one.
 *
 * A contact file is the importer's and read-only, so what you know about
 * somebody ("prefers email, met in Lisbon") needs a note of your own. One per
 * person rather than one per occasion: meetings have dates, people do not.
 * Filed beside the contacts you keep by hand, in `Contacts/`, and called
 * `Notes on Jane Doe` — not `Jane Doe`, which would share the contact's name,
 * and a shared name turns every `[[Jane Doe]]` into a question of which one.
 *
 * `contact:` is the link back: it puts the note first in the contact's Linked
 * Mentions, and it is how the next press finds it rather than making another.
 */
async function contactNotes(
  contact: string,
  entry: NoteIndexEntry,
): Promise<{ path: string; created: boolean }> {
  const existing = notesForContact(contact)
  if (existing.length) return { path: existing[0], created: false }
  const title = `Notes on ${entry.title}`
  const body = setPropertyValue(
    `# ${title}\n\n`,
    'contact',
    formatWikiLink({ target: linkNameFor(contact) }),
  )
  return { path: await createNote(CONTACTS_FOLDER, title, body), created: true }
}
