/**
 * Which device wrote what.
 *
 * The sync protocol carries no identity — a file on a WebDAV server is bytes
 * and an ETag, and nothing in it says who put it there. So attribution has to
 * be recorded in the vault itself, and the only shape that is safe is one file
 * per device: `backstage/devices/<id>.json`, holding that device's name and the
 * paths it has pushed lately. No two devices ever write the same file, so this
 * registry cannot conflict, cannot merge badly, and cannot lose an edit — the
 * worst it can do is be a little out of date.
 *
 * That is enough for version history to say "Pulled from server · Mike's
 * iPhone" rather than leaving you to guess which machine you were at.
 *
 * This module holds no reference to the vault: the vault feeds it files and
 * asks it for names. That keeps the dependency one-way.
 */

import { BACKSTAGE, type VaultFile } from './types'

export const DEVICES_DIR = `${BACKSTAGE}/devices`

/**
 * How many recent writes one device remembers. Attribution is only ever asked
 * for versions, and those are trimmed at 60 per note and 90 days, so a rolling
 * window costs nothing and keeps the file small enough to sync on every run.
 */
const MAX_WRITES = 300

export interface DeviceRecord {
  id: string
  name: string
  updatedAt: number
  /** path -> ms epoch when this device last pushed that path. */
  writes: Record<string, number>
}

/** id -> record. Includes this device, once `setLocalDevice` has run. */
const records = new Map<string, DeviceRecord>()

let own: DeviceRecord | undefined
let unsaved = false

export function devicePath(id: string): string {
  return `${DEVICES_DIR}/${id}.json`
}

export function isDevicePath(path: string): boolean {
  return path.startsWith(`${DEVICES_DIR}/`)
}

/** Identity of the device this app is running on. Set once at boot. */
export function setLocalDevice(id: string, name: string): void {
  const existing = records.get(id)
  if (existing) {
    if (existing.name !== name) {
      existing.name = name
      unsaved = true
    }
    own = existing
    return
  }
  own = { id, name, updatedAt: Date.now(), writes: {} }
  records.set(id, own)
}

export function localDeviceName(): string | undefined {
  return own?.name
}

/**
 * Take in device files from the vault. Safe to call with the whole vault or
 * with the handful of files a sync just installed.
 */
export function loadDeviceRecords(files: Iterable<VaultFile>): void {
  for (const f of files) {
    if (f.deleted || !f.text || !isDevicePath(f.path)) continue
    let rec: DeviceRecord
    try {
      rec = JSON.parse(f.text) as DeviceRecord
    } catch {
      continue
    }
    if (!rec?.id || typeof rec.name !== 'string') continue
    if (!rec.writes || typeof rec.writes !== 'object') rec.writes = {}
    if (own && rec.id === own.id) {
      // Our own file, read back from disk or pulled from the remote. Anything
      // we have recorded since is newer than what it holds, so it wins.
      own.writes = { ...rec.writes, ...own.writes }
      continue
    }
    records.set(rec.id, rec)
  }
}

/** Note that this device has just pushed `path` to the remote. */
export function recordWrite(path: string): void {
  // Backstage is bookkeeping, not content, and recording a write to the
  // registry itself would keep the registry permanently dirty.
  if (!own || path.startsWith(`${BACKSTAGE}/`)) return
  own.updatedAt = Date.now()
  own.writes[path] = own.updatedAt
  unsaved = true
}

/**
 * The name of the device that last pushed `path`, as far as this device knows.
 * Never this device: the caller asks in order to describe content that arrived
 * from somewhere else.
 */
export function writerFor(path: string): string | undefined {
  let best: DeviceRecord | undefined
  let bestAt = 0
  for (const rec of records.values()) {
    if (rec.id === own?.id) continue
    const at = rec.writes?.[path]
    if (!at || at <= bestAt) continue
    bestAt = at
    best = rec
  }
  return best?.name
}

/**
 * This device's record, trimmed and key-sorted, if it has changed since the
 * last call. Sorted because the file is compared as text before being written:
 * a stable key order is the difference between "nothing to sync" and a fresh
 * upload every run.
 */
export function pendingDeviceRecord(): DeviceRecord | undefined {
  if (!own || !unsaved) return undefined
  unsaved = false
  const recent = Object.entries(own.writes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_WRITES)
  own.writes = Object.fromEntries(recent)
  return {
    id: own.id,
    name: own.name,
    updatedAt: own.updatedAt,
    writes: Object.fromEntries(recent.sort((a, b) => a[0].localeCompare(b[0]))),
  }
}

/** Test seam: forget everything this module knows. */
export function resetDevices(): void {
  records.clear()
  own = undefined
  unsaved = false
}
