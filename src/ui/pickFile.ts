/**
 * The state behind the "File in Slate" picker, and the rule it matches on.
 *
 * Split out of the component so the matching is a plain function over plain
 * rows — the part worth testing — and so the editor can open the picker
 * without importing the dialog that draws it.
 *
 * Matching is the same "every term has to appear" rule the file browser uses
 * (`matchesAll`), against the whole path so typing a folder name narrows to
 * it. What it adds is an order: somebody typing "chart" into a picker is
 * naming a file, not a folder, so a name that starts with what they typed
 * comes before a name that merely contains it, and both come before a file
 * matched only by the folder it sits in. Ties fall back to newest first,
 * which is the order the list already arrives in.
 */

import { signal } from '@preact/signals'
import { basename, matchesAll, searchTerms } from '../core/util'

/** What a row needs to be rankable. `VaultFile` satisfies it. */
export interface PickableFile {
  path: string
  mtime: number
}

export interface FilePickRequest {
  /** The chosen file's vault path. */
  onPick: (path: string) => void
  /**
   * The picker's own way out to the device's file browser, so somebody who
   * opened it and found the file isn't in Slate yet does not have to close it
   * and go back to the Insert menu.
   */
  onUpload: () => void
  /** Closed without inserting anything — the caret is still where it was. */
  onCancel?: () => void
}

/** Non-null while the picker is open. */
export const filePick = signal<FilePickRequest | null>(null)

export function openFilePicker(req: FilePickRequest): void {
  filePick.value = req
}

export function closeFilePicker(): void {
  filePick.value = null
}

/** Files matching `query`, best first. An empty query keeps the given order. */
export function rankFiles<T extends PickableFile>(files: T[], query: string): T[] {
  const terms = searchTerms(query)
  if (!terms.length) return files

  const scored: Array<{ f: T; rank: number }> = []
  for (const f of files) {
    if (!matchesAll(f.path, terms)) continue
    const name = basename(f.path).toLowerCase()
    const rank = name.startsWith(terms[0]) ? 0 : terms.every((t) => name.includes(t)) ? 1 : 2
    scored.push({ f, rank })
  }
  // Stable within a rank, so the newest-first order of the input survives.
  return scored
    .map((s, i) => ({ ...s, i }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((s) => s.f)
}
