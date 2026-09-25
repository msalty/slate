/**
 * The two things a note an importer owns offers, as UI actions: write your own
 * notes about it, or detach it. The work is in core/imports.ts; these only
 * open what it made and say what happened.
 */

import { detachAndFile, notesAboutMeeting } from '../core/imports'
import { syncSoon } from '../core/sync'
import { notify, openNote } from './state'

/**
 * Open your notes on a meeting, making them first if there are none. A new
 * note opens ready to type in; one you already have opens to be read, like
 * any note you go back to.
 */
export async function openMeetingNotes(meeting: string): Promise<void> {
  try {
    const r = await notesAboutMeeting(meeting)
    if (!r) return
    openNote(r.path, { editing: r.created })
    if (r.created) syncSoon()
  } catch (e) {
    console.error('[slate] could not make meeting notes', e)
    notify('Those notes could not be made on this device.', 'error')
  }
}

/** Detach a note, file it with your own, and follow it there. */
export async function detachAndOpen(path: string, owner: string): Promise<void> {
  let dest: string | undefined
  try {
    dest = await detachAndFile(path)
  } catch (e) {
    console.error('[slate] could not detach note', e)
    notify('This note could not be detached on this device.', 'error')
    return
  }
  if (!dest) return
  syncSoon()
  if (dest !== path) openNote(dest)
  notify(`Detached from ${owner} — this note is yours now`)
}
