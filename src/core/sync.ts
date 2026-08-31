/**
 * The sync engine.
 *
 * Design rules, in priority order:
 *
 *   1. NEVER lose content. Every path through this file either preserves both
 *      sides or keeps the side that has content. There is no code path that
 *      discards an edit because a timestamp looked older.
 *   2. Never block the UI. Sync runs entirely off the interaction path; the
 *      vault is already readable and writable from IndexedDB before this file
 *      does anything at all.
 *   3. Converge. After a run completes on every device with no further edits,
 *      all devices hold identical content.
 *
 * The mechanism is a three-way reconcile per file, using the content hash and
 * remote revision captured at the last successful sync as the common ancestor.
 * Concurrent edits to the same note are merged line-wise when they touched
 * different regions, and preserved as two separate files when they did not.
 */

import { signal } from '@preact/signals'
import type { RemoteAdapter, RemoteEntry, SyncStatus, VaultFile } from './types'
import { PreconditionFailed } from './types'
import { merge3 } from './merge'
import {
  forget,
  installFromRemote,

  listAll,
  markSynced,
  getRaw,
  addAttachment,
} from './vault'
import { pushVersion } from './db'
import { hashBlob, hashText, isNotePath, mimeForPath, ymd } from './util'

export const status = signal<SyncStatus>({ phase: 'idle', pendingCount: 0, conflictCount: 0 })

/** Paths that produced a conflict copy in the most recent run, for the UI banner. */
export const recentConflicts = signal<string[]>([])

let adapter: RemoteAdapter | undefined
let running: Promise<void> | undefined
/** Set when a sync is requested while one is already in flight. */
let rerunRequested = false
let deviceLabel = 'device'

export function setAdapter(a: RemoteAdapter | undefined): void {
  adapter = a
  status.value = {
    ...status.value,
    phase: 'idle',
    detail: a ? `Connected to ${a.describe()}` : 'Local only',
    lastError: undefined,
  }
}

export function currentAdapter(): RemoteAdapter | undefined {
  return adapter
}

export function setDeviceLabel(name: string): void {
  deviceLabel = name
}

/** Number of local files waiting to be pushed. Drives the status pill. */
export function pendingCount(): number {
  return listAll().filter((f) => f.dirty).length
}

function setStatus(patch: Partial<SyncStatus>) {
  status.value = { ...status.value, ...patch, pendingCount: pendingCount() }
}

/* ------------------------------------------------------------------- entry */

/**
 * Run a sync. Safe to call at any time from anywhere: concurrent calls
 * coalesce, and a call made during a run schedules exactly one more run after
 * it, so a burst of triggers can't stampede the server.
 */
export function sync(): Promise<void> {
  if (running) {
    rerunRequested = true
    return running
  }
  running = (async () => {
    try {
      await runOnce()
    } finally {
      running = undefined
    }
    if (rerunRequested) {
      rerunRequested = false
      await sync()
    }
  })()
  return running
}

async function runOnce(): Promise<void> {
  if (!adapter) {
    setStatus({ phase: 'idle', detail: 'Local only' })
    return
  }
  if (!navigator.onLine) {
    setStatus({ phase: 'offline', detail: 'Offline — changes are saved locally' })
    return
  }

  const conflicts: string[] = []
  try {
    setStatus({ phase: 'listing', detail: 'Checking for changes…', progress: 0, lastError: undefined })
    if (!adapter.isConnected()) await adapter.connect()

    const remoteList = await adapter.list()
    const remote = new Map<string, RemoteEntry>()
    for (const e of remoteList) if (!e.isDir) remote.set(e.path, e)

    const local = new Map<string, VaultFile>()
    for (const f of listAll()) local.set(f.path, f)

    const paths = new Set<string>([...local.keys(), ...remote.keys()])
    const plan: Array<() => Promise<void>> = []

    for (const path of paths) {
      const L = local.get(path)
      const R = remote.get(path)
      plan.push(() => reconcile(path, L, R, conflicts))
    }

    setStatus({ phase: 'pulling', detail: `Syncing ${plan.length} files…` })

    // Bounded concurrency: enough to keep the pipe busy, low enough that a
    // rate-limited backend does not start returning 403s.
    const CONCURRENCY = 5
    let done = 0
    let cursor = 0
    const workers = Array.from({ length: Math.min(CONCURRENCY, plan.length) }, async () => {
      while (cursor < plan.length) {
        const i = cursor++
        try {
          await plan[i]()
        } catch (e) {
          // One bad file must not abort the whole run; the rest still sync and
          // the failure is retried next time.
          console.warn('[slate] sync item failed', e)
        }
        done++
        if (done % 5 === 0 || done === plan.length)
          setStatus({ progress: done / plan.length, detail: `Syncing ${done}/${plan.length}…` })
      }
    })
    await Promise.all(workers)

    recentConflicts.value = conflicts
    setStatus({
      phase: 'idle',
      progress: undefined,
      lastSyncAt: Date.now(),
      conflictCount: conflicts.length,
      detail: conflicts.length
        ? `Synced — ${conflicts.length} conflict ${conflicts.length === 1 ? 'copy' : 'copies'} kept`
        : `Synced with ${adapter.describe()}`,
    })
  } catch (e) {
    const msg = (e as Error).message ?? String(e)
    setStatus({
      phase: 'error',
      progress: undefined,
      lastError: msg,
      detail: msg,
    })
  }
}

/* --------------------------------------------------------------- reconcile */

async function reconcile(
  path: string,
  L: VaultFile | undefined,
  R: RemoteEntry | undefined,
  conflicts: string[],
): Promise<void> {
  // ---- remote-only: a file another device created. Pull it.
  if (!L && R) return pull(path, R)

  if (!L) return

  // ---- tombstone handling
  if (L.deleted) {
    if (!R) {
      // The remote agrees it is gone. The tombstone has done its job.
      await forget(path)
      return
    }
    const remoteMoved = remoteChanged(L, R)
    if (remoteMoved) {
      // Someone edited this file after we deleted it. An edit beats a delete —
      // resurrect rather than destroy work we can't see.
      await pull(path, R)
      return
    }
    await adapter!.remove(R)
    await forget(path)
    return
  }

  // ---- local-only
  if (!R) {
    if (L.sync.baseHash === undefined) {
      // Never synced: this is simply a new local file.
      return push(path, L, undefined)
    }
    if (L.dirty) {
      // Deleted remotely, but we have unpushed changes. Content wins: re-upload.
      return push(path, L, undefined)
    }
    // Deleted remotely and we have nothing newer. Accept the deletion, but
    // route it through the local trash so it stays recoverable on this device.
    if (L.kind === 'note') {
      await pushVersion({
        path,
        at: Date.now(),
        text: L.text ?? '',
        hash: L.hash,
        reason: 'delete',
      })
    }
    await forget(path)
    return
  }

  // ---- both sides exist
  const localChanged = L.dirty
  const rChanged = remoteChanged(L, R)

  if (!localChanged && !rChanged) return
  if (!localChanged && rChanged) return pull(path, R)
  if (localChanged && !rChanged) return push(path, L, L.sync.remoteRev)

  // ---- both changed
  return resolve(path, L, R, conflicts)
}

/**
 * Has the remote moved since we last agreed with it?
 *
 * Prefer the revision identifier. Fall back to modified time only when the
 * backend gives us no revision at all, and when in doubt answer "yes" — a
 * needless pull is harmless, a missed one loses an edit.
 */
function remoteChanged(L: VaultFile, R: RemoteEntry): boolean {
  if (R.rev !== undefined && L.sync.remoteRev !== undefined) return R.rev !== L.sync.remoteRev
  if (R.rev !== undefined && L.sync.remoteRev === undefined) return true
  if (R.mtime !== undefined && L.sync.remoteMtime !== undefined)
    return Math.abs(R.mtime - L.sync.remoteMtime) > 1500
  return true
}

/* -------------------------------------------------------------------- pull */

async function pull(path: string, R: RemoteEntry): Promise<void> {
  const now = Date.now()
  const existing = getRaw(path)
  if (isNotePath(path) || path.endsWith('.json')) {
    const { text, rev, mtime } = await adapter!.getText(R)
    const hash = await hashText(text)
    await installFromRemote([
      {
        path,
        kind: 'note',
        text,
        mime: mimeForPath(path),
        size: text.length,
        hash,
        mtime: mtime ?? now,
        ctime: existing?.ctime ?? mtime ?? now,
        dirty: false,
        deleted: false,
        sync: {
          baseHash: hash,
          baseText: text,
          remoteRev: rev ?? R.rev,
          remoteMtime: mtime ?? R.mtime,
          lastSyncedAt: now,
        },
      },
    ])
    return
  }

  const { blob, rev, mtime } = await adapter!.getBlob(R)
  const hash = await hashBlob(blob)
  await installFromRemote([
    {
      path,
      kind: 'attachment',
      blob,
      mime: blob.type || mimeForPath(path),
      size: blob.size,
      hash,
      mtime: mtime ?? now,
      ctime: existing?.ctime ?? mtime ?? now,
      dirty: false,
      deleted: false,
      sync: {
        baseHash: hash,
        remoteRev: rev ?? R.rev,
        remoteMtime: mtime ?? R.mtime,
        lastSyncedAt: now,
      },
    },
  ])
}

/* -------------------------------------------------------------------- push */

async function push(path: string, L: VaultFile, ifMatch: string | undefined): Promise<void> {
  const body = L.kind === 'note' ? (L.text ?? '') : L.blob
  if (body === undefined) return
  const mime = L.mime || mimeForPath(path)

  try {
    const res = await adapter!.put(path, body, mime, ifMatch)
    await markSynced(path, {
      baseHash: L.hash,
      baseText: L.kind === 'note' ? (L.text ?? '') : undefined,
      remoteRev: res.rev,
      remoteMtime: res.mtime,
    })
  } catch (e) {
    if (e instanceof PreconditionFailed) {
      // The remote changed between our listing and our write. Re-list just this
      // file and fall through to a proper merge instead of forcing.
      const fresh = (await adapter!.list()).find((x) => x.path === path && !x.isDir)
      if (fresh) {
        const conflicts: string[] = []
        await resolve(path, L, fresh, conflicts)
        if (conflicts.length) recentConflicts.value = [...recentConflicts.value, ...conflicts]
        return
      }
    }
    throw e
  }
}

/* ---------------------------------------------------------------- conflict */

/**
 * Both sides changed since the last sync.
 *
 * For notes: attempt a three-way merge against the stored base. A clean merge
 * keeps every edit from both devices. A dirty one keeps the local version at
 * the real path (so the editor buffer the user is looking at is never yanked
 * away) and writes the remote version beside it as a clearly-named conflict
 * copy, which then syncs everywhere so the divergence is visible on every
 * device rather than silently resolved on one.
 *
 * For attachments: no merge is possible, so both are kept.
 */
async function resolve(
  path: string,
  L: VaultFile,
  R: RemoteEntry,
  conflicts: string[],
): Promise<void> {
  if (L.kind === 'attachment') {
    const { blob } = await adapter!.getBlob(R)
    const remoteHash = await hashBlob(blob)
    if (remoteHash === L.hash) {
      // Same bytes on both sides — not a conflict at all, just re-stamp.
      await markSynced(path, { baseHash: L.hash, remoteRev: R.rev, remoteMtime: R.mtime })
      return
    }
    const copy = conflictPath(path)
    await addAttachment(blob, copy)
    conflicts.push(copy)
    await push(path, L, R.rev)
    return
  }

  const { text: remoteText } = await adapter!.getText(R)
  const localText = L.text ?? ''

  if (remoteText === localText) {
    await markSynced(path, {
      baseHash: L.hash,
      baseText: localText,
      remoteRev: R.rev,
      remoteMtime: R.mtime,
    })
    return
  }

  const base = L.sync.baseText
  if (base !== undefined) {
    const m = merge3(base, localText, remoteText)
    if (!m.conflict) {
      // Clean merge: both sets of edits survive.
      const hash = await hashText(m.merged)
      const now = Date.now()
      await pushVersion({
        path,
        at: now,
        text: localText,
        hash: L.hash,
        reason: 'conflict-merge',
      })
      await installFromRemote([
        {
          ...L,
          text: m.merged,
          hash,
          size: m.merged.length,
          mtime: now,
          dirty: true,
          sync: { ...L.sync, remoteRev: R.rev, remoteMtime: R.mtime },
        },
      ])
      const merged = getRaw(path)
      if (merged) await push(path, merged, R.rev)
      return
    }
  }

  // Overlapping edits, or no common ancestor to merge against. Keep both.
  const copy = conflictPath(path)
  const now = Date.now()
  const header =
    `---\nconflict-of: "${path}"\nconflict-at: ${new Date(now).toISOString()}\n---\n\n` +
    `> This is the version that was on the server when a conflicting edit was\n` +
    `> found. Your version is still in **${path}**. Merge whatever you need from\n` +
    `> here, then delete this file.\n\n`
  const copyText = header + remoteText
  const copyHash = await hashText(copyText)
  await installFromRemote([
    {
      path: copy,
      kind: 'note',
      text: copyText,
      mime: 'text/markdown',
      size: copyText.length,
      hash: copyHash,
      mtime: now,
      ctime: now,
      dirty: true,
      sync: {},
    },
  ])
  conflicts.push(copy)

  // Now the local version can safely take the canonical path.
  await push(path, L, R.rev)
}

function conflictPath(path: string): string {
  const dot = path.lastIndexOf('.')
  const stem = dot > 0 ? path.slice(0, dot) : path
  const ext = dot > 0 ? path.slice(dot) : ''
  const stamp = `${ymd(Date.now())} ${new Date().toTimeString().slice(0, 5).replace(':', '')}`
  return `${stem} (conflict — ${deviceLabel} ${stamp})${ext}`
}

/* -------------------------------------------------------------- scheduling */

let timer: ReturnType<typeof setInterval> | undefined
let listenersInstalled = false

/**
 * Start automatic syncing. Triggers are deliberately event-driven rather than
 * purely periodic: the useful moments are when the app becomes visible, when
 * the network comes back, and shortly after an edit settles.
 */
export function startAutoSync(intervalSec: number): void {
  stopAutoSync()
  timer = setInterval(() => void sync(), Math.max(15, intervalSec) * 1000)
  installListeners()
  void sync()
}

export function stopAutoSync(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}

function installListeners() {
  if (listenersInstalled) return
  listenersInstalled = true

  addEventListener('online', () => {
    setStatus({ phase: 'idle', detail: 'Back online' })
    void sync()
  })
  addEventListener('offline', () => {
    setStatus({ phase: 'offline', detail: 'Offline — changes are saved locally' })
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && timer) void sync()
  })
  // A best-effort last push when the tab goes away. Content is already durable
  // in IndexedDB at this point, so failure here only delays a sync.
  addEventListener('pagehide', () => {
    if (timer && pendingCount() > 0) void sync()
  })
}

/** Fired by the editor once edits settle, when auto-sync is on. */
export const syncSoon = (() => {
  let t: ReturnType<typeof setTimeout> | undefined
  return () => {
    if (!timer) return
    if (t) clearTimeout(t)
    t = setTimeout(() => void sync(), 4000)
  }
})()
