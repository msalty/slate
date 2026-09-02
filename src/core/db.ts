/**
 * IndexedDB schema and access.
 *
 * IndexedDB is a *cache and journal* of the vault, never the only copy of
 * anything. If it is wiped, a sync repopulates it from the remote. What it adds
 * on top of the remote is (a) instant cold start with no network and (b) local
 * version history, which is the last line of defence against losing work.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { VaultFile } from './types'

export interface Version {
  /** Auto-increment key. */
  id?: number
  path: string
  at: number
  text: string
  hash: string
  /** What produced this version, shown in the history list. */
  reason: 'edit' | 'sync-pull' | 'conflict-merge' | 'delete' | 'import'
  /**
   * Name of the device this text came from — this one for a local edit, the
   * device that pushed it for anything pulled. Absent on versions recorded
   * before attribution existed, and on a pull whose author is not yet known.
   */
  device?: string
}

interface SlateDB extends DBSchema {
  files: {
    key: string
    value: VaultFile
    indexes: { 'by-dirty': number; 'by-mtime': number }
  }
  meta: { key: string; value: unknown }
  versions: {
    key: number
    value: Version
    indexes: { 'by-path': string; 'by-at': number }
  }
}

/**
 * The database name is overridable so more than one vault can live in one
 * browser profile — and so the test suite can run two independent "devices"
 * against one another in a single process.
 */
const DB_NAME =
  (globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ ?? 'slate'
const DB_VERSION = 1

let dbPromise: Promise<IDBPDatabase<SlateDB>> | undefined

export function db(): Promise<IDBPDatabase<SlateDB>> {
  if (!dbPromise) {
    dbPromise = openDB<SlateDB>(DB_NAME, DB_VERSION, {
      upgrade(d, oldVersion) {
        if (oldVersion < 1) {
          const files = d.createObjectStore('files', { keyPath: 'path' })
          // Booleans can't be indexed in IDB, so dirty is mirrored as 0/1.
          files.createIndex('by-dirty', 'dirtyFlag')
          files.createIndex('by-mtime', 'mtime')
          d.createObjectStore('meta')
          const versions = d.createObjectStore('versions', {
            keyPath: 'id',
            autoIncrement: true,
          })
          versions.createIndex('by-path', 'path')
          versions.createIndex('by-at', 'at')
        }
      },
      blocked() {
        console.warn('[slate] Another tab is holding an old database version open.')
      },
      terminated() {
        // The browser killed the connection (e.g. storage pressure). Reopen lazily.
        dbPromise = undefined
      },
    })
  }
  return dbPromise
}

/** IDB can't index booleans; keep a numeric mirror in sync on every write. */
type StoredFile = VaultFile & { dirtyFlag: number }

function toStored(f: VaultFile): StoredFile {
  return { ...f, dirtyFlag: f.dirty ? 1 : 0 }
}

export async function putFile(f: VaultFile): Promise<void> {
  const d = await db()
  await d.put('files', toStored(f))
}

export async function putFiles(files: VaultFile[]): Promise<void> {
  const d = await db()
  const tx = d.transaction('files', 'readwrite')
  await Promise.all(files.map((f) => tx.store.put(toStored(f))))
  await tx.done
}

export async function getFile(path: string): Promise<VaultFile | undefined> {
  const d = await db()
  return d.get('files', path)
}

export async function allFiles(): Promise<VaultFile[]> {
  const d = await db()
  return d.getAll('files')
}

export async function deleteFileRow(path: string): Promise<void> {
  const d = await db()
  await d.delete('files', path)
}

export async function dirtyFiles(): Promise<VaultFile[]> {
  const d = await db()
  return d.getAllFromIndex('files', 'by-dirty', 1)
}

/* ------------------------------------------------------------------ meta kv */

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const d = await db()
  return (await d.get('meta', key)) as T | undefined
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  const d = await db()
  await d.put('meta', value, key)
}

/* ---------------------------------------------------------------- versions */

const MAX_VERSIONS_PER_NOTE = 60
const VERSION_TTL_MS = 90 * 24 * 60 * 60 * 1000

/**
 * Record a version. Skipped when the content is identical to the newest stored
 * version, so an idle autosave loop doesn't fill the store with duplicates.
 */
export async function pushVersion(v: Omit<Version, 'id'>): Promise<void> {
  const d = await db()
  const tx = d.transaction('versions', 'readwrite')
  const idx = tx.store.index('by-path')
  let newest: Version | undefined
  let cursor = await idx.openCursor(IDBKeyRange.only(v.path), 'prev')
  if (cursor) newest = cursor.value
  if (newest?.hash === v.hash) {
    await tx.done
    return
  }
  await tx.store.add(v as Version)

  // Trim: keep the most recent N, drop anything past the TTL.
  const cutoff = Date.now() - VERSION_TTL_MS
  const keys: number[] = []
  cursor = await idx.openCursor(IDBKeyRange.only(v.path), 'prev')
  let seen = 0
  while (cursor) {
    seen++
    if (seen > MAX_VERSIONS_PER_NOTE || cursor.value.at < cutoff) keys.push(cursor.value.id!)
    cursor = await cursor.continue()
  }
  for (const k of keys) await tx.store.delete(k)
  await tx.done
}

export async function versionsFor(path: string): Promise<Version[]> {
  const d = await db()
  const list = await d.getAllFromIndex('versions', 'by-path', path)
  return list.sort((a, b) => b.at - a.at)
}

export async function renameVersions(from: string, to: string): Promise<void> {
  const d = await db()
  const tx = d.transaction('versions', 'readwrite')
  const idx = tx.store.index('by-path')
  let cursor = await idx.openCursor(IDBKeyRange.only(from))
  while (cursor) {
    await cursor.update({ ...cursor.value, path: to })
    cursor = await cursor.continue()
  }
  await tx.done
}

/** Approximate on-device usage, for the settings screen. */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | undefined> {
  if (!navigator.storage?.estimate) return undefined
  const e = await navigator.storage.estimate()
  return { usage: e.usage ?? 0, quota: e.quota ?? 0 }
}

/**
 * Ask the browser not to evict our data under storage pressure. Chrome grants
 * this silently for installed PWAs and engaged sites; Safari ignores it.
 */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false
  try {
    if (await navigator.storage.persisted()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}
