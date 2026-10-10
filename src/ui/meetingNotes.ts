/**
 * The two things a note an importer owns offers, as UI actions: write your own
 * notes about it, or detach it. The work is in core/imports.ts; these only
 * open what it made and say what happened.
 */

import {
  BrokenMeetingError,
  DetachIncompleteError,
  detachAndFile,
  notesAbout,
} from '../core/imports'
import { syncSoon } from '../core/sync'
import { activePath, navigationMark, notify, openNote } from './state'
import { titleFromPath } from '../core/util'

/**
 * Open your notes on a meeting or a person, making them first if there are
 * none. A new note opens ready to type in; one you already have opens to be
 * read, like any note you go back to.
 *
 * Only if nobody has gone anywhere in the meantime. Making the note is a
 * write, and a write can be slow: press it on meeting A, go on to meeting B,
 * and A's note used to open over B when A finished last. The note is still
 * made; a new one is announced with a way to open it instead.
 */
export async function openNotesAbout(imported: string): Promise<void> {
  const mark = navigationMark()
  const from = activePath.peek()
  try {
    const r = await notesAbout(imported)
    if (!r) return
    if (r.created) syncSoon()
    if (stillHere(mark, from)) openNote(r.path, { editing: r.created })
    else if (r.created)
      notify(`Started “${titleFromPath(r.path)}”.`, 'info', {
        label: 'Open',
        run: () => openNote(r.path, { editing: true }),
      })
  } catch (e) {
    if (e instanceof BrokenMeetingError) {
      notify(e.message, 'error')
      return
    }
    console.error('[slate] could not make notes', e)
    notify('Those notes could not be made on this device.', 'error')
  }
}

/** Nobody has navigated since `mark` was taken, from the note that was open then. */
function stillHere(mark: number, from: string | undefined): boolean {
  return navigationMark() === mark && activePath.peek() === from
}

/** Detach a note, file it with your own, and follow it there. */
export async function detachAndOpen(path: string, owner: string): Promise<void> {
  const mark = navigationMark()
  const from = activePath.peek()
  let dest: string | undefined
  try {
    dest = await detachAndFile(path)
  } catch (e) {
    if (e instanceof BrokenMeetingError) {
      notify(e.message, 'error')
      return
    }
    /*
     * Moved, but still the importer's: say where it is and follow it there —
     * the path it was opened at no longer exists — and Detach is still on
     * its banner to finish the job.
     */
    if (e instanceof DetachIncompleteError) {
      if (stillHere(mark, from)) openNote(e.dest)
      notify(`${e.message} Press Detach again to finish.`, 'error')
      return
    }
    console.error('[slate] could not detach note', e)
    notify('This note could not be detached on this device.', 'error')
    return
  }
  if (!dest) return
  syncSoon()
  // Followed there only if you are still on the note you detached.
  if (dest !== path && stillHere(mark, from)) openNote(dest)
  notify(`Detached from ${owner} — this note is yours now`)
}
