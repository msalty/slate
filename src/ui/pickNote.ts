/**
 * The state behind the "pick a note" palette.
 *
 * Split from the component for the same reason the file picker is: whoever
 * wants a note chosen should not have to import the dialog that draws one.
 *
 * The ranking is `rankFiles` unchanged — it works on anything with a path and
 * an mtime, which a note index entry is. Notes and attachments want exactly the
 * same order: a name that starts with what you typed, then a name that contains
 * it, then something matched only by its folder, newest first within each.
 */

import { signal } from '@preact/signals'
import type { NoteIndexEntry } from '../core/types'

export interface NotePickRequest {
  /** Heading for the dialog, so it can say what the note is being picked *for*. */
  title: string
  placeholder?: string
  /** Vault paths to leave out — typically what has already been chosen. */
  exclude?: string[]
  onPick: (entry: NoteIndexEntry) => void
  onCancel?: () => void
}

/** Non-null while the picker is open. */
export const notePick = signal<NotePickRequest | null>(null)

export function openNotePicker(req: NotePickRequest): void {
  notePick.value = req
}

export function closeNotePicker(): void {
  notePick.value = null
}
