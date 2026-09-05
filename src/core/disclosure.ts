/**
 * Which rows in the sidebar's two trees are unfolded.
 *
 * Kept here rather than in each row's own `useState` because a row is
 * unmounted whenever its parent — or the whole "Folders" / "Tag Folders"
 * section — is folded away, and component state dies with it. Reopening a
 * section used to hand every folder inside it a fresh default instead of the
 * shape you left it in, which is why unfolding a section appeared to unfold
 * everything under it at once.
 *
 * This is not an app setting. Settings are compared by value to decide what
 * still needs writing to the shared config, so a set of paths could never live
 * there (see `AppSettings.collapseFolders`), and which folders you have open is
 * about the window in front of you rather than the vault — so it is kept beside
 * the other device-local state, in this device's own store.
 *
 * Everything starts folded. A folder is open because you opened it, and it
 * stays open until you say otherwise.
 */

import { signal } from '@preact/signals'
import { getMeta, setMeta } from './db'
import { normPath } from './util'

const KEY = 'sidebar.open'

/** Prefixed so a folder path and a Tag Folder id can share one set. */
const folderKey = (path: string) => `folder:${path}`
const tagKey = (id: string) => `tag:${id}`

const open = signal<ReadonlySet<string>>(new Set())

/**
 * Written straight through rather than on a timer: a chevron is one deliberate
 * click, the write is a few dozen bytes into IndexedDB, and a debounce here
 * would only add a window in which a closed tab forgets the last one.
 */
function commit(next: Set<string>): void {
  open.value = next
  void setMeta(KEY, [...next])
}

export async function loadDisclosure(): Promise<void> {
  const saved = await getMeta<string[]>(KEY)
  if (Array.isArray(saved)) open.value = new Set(saved.filter((k) => typeof k === 'string'))
}

function setKey(key: string, want: boolean): void {
  if (open.value.has(key) === want) return
  const next = new Set(open.value)
  if (want) next.add(key)
  else next.delete(key)
  commit(next)
}

export function isFolderOpen(path: string): boolean {
  return open.value.has(folderKey(normPath(path)))
}

export function setFolderOpen(path: string, want: boolean): void {
  setKey(folderKey(normPath(path)), want)
}

export function toggleFolder(path: string): void {
  setFolderOpen(path, !isFolderOpen(path))
}

export function isTagFolderOpen(id: string): boolean {
  return open.value.has(tagKey(id))
}

export function setTagFolderOpen(id: string, want: boolean): void {
  setKey(tagKey(id), want)
}

export function toggleTagFolder(id: string): void {
  setTagFolderOpen(id, !isTagFolderOpen(id))
}

/**
 * A renamed folder keeps the shape it had: its own row and every row beneath
 * it. Without this a rename silently folds the subtree back up, which reads as
 * the app having forgotten what you did rather than as a rename.
 */
export function renameOpenFolder(from: string, to: string): void {
  const src = normPath(from)
  const dest = normPath(to)
  if (!src || !dest || src === dest) return
  const prefix = folderKey(src)
  const next = new Set<string>()
  let changed = false
  for (const k of open.value) {
    if (k === prefix || k.startsWith(`${prefix}/`)) {
      next.add(folderKey(dest) + k.slice(prefix.length))
      changed = true
    } else {
      next.add(k)
    }
  }
  if (changed) commit(next)
}

/** Forget a deleted folder and everything that was inside it. */
export function forgetFolder(path: string): void {
  const src = normPath(path)
  if (!src) return
  const prefix = folderKey(src)
  const next = new Set<string>()
  let changed = false
  for (const k of open.value) {
    if (k === prefix || k.startsWith(`${prefix}/`)) changed = true
    else next.add(k)
  }
  if (changed) commit(next)
}

/** Forget deleted Tag Folders. */
export function forgetTagFolders(ids: Iterable<string>): void {
  const doomed = new Set([...ids].map(tagKey))
  const next = new Set<string>()
  let changed = false
  for (const k of open.value) {
    if (doomed.has(k)) changed = true
    else next.add(k)
  }
  if (changed) commit(next)
}
