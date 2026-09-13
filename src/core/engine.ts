/**
 * The reconcile engine.
 *
 * Design rules, in priority order:
 *
 *   1. NEVER lose content. Every path through this file either preserves both
 *      sides or keeps the side that has content. There is no code path that
 *      discards an edit because a timestamp looked older.
 *   2. Never block the UI. Reconciling runs entirely off the interaction path;
 *      the vault is already readable and writable from IndexedDB before this
 *      file does anything at all.
 *   3. Converge. After a run completes on every device with no further edits,
 *      all devices hold identical content.
 *
 * The mechanism is a three-way reconcile per file, using the content hash and
 * remote revision captured at the last successful run as the common ancestor.
 * Concurrent edits to the same note are merged line-wise when they touched
 * different regions, and preserved as two separate files when they did not.
 *
 * One engine reconciles the vault against one *target*, and a vault may have
 * two: the cloud backend from Settings, and a folder on this machine opened
 * through the File System Access API. They are the same problem — a set of
 * files somewhere else that has to be brought into agreement with the set of
 * files here — so they are the same code, differing only in which adapter they
 * talk to and which half of each file's bookkeeping they read and write. See
 * `SyncSlot` in core/types.ts for why there are exactly two.
 *
 * Running two of these against one vault converges the same way running one on
 * two devices does, and for the same reason: each run only ever moves content
 * from a place that has it to a place that does not, so whichever order the two
 * happen to run in, an edit made anywhere ends up everywhere. That is what
 * carries a note typed in Obsidian out to a phone that cannot see the folder,
 * and a note typed on the phone back down onto the disk.
 */

import { signal } from '@preact/signals'
import type { RemoteAdapter, RemoteEntry, SyncMeta, SyncSlot, SyncStatus, VaultFile } from './types'
import { isPreconditionFailed } from './types'
import { merge3 } from './merge'
import {
  acceptDeletion,
  addAttachment,
  dirtyCount,
  folderPendingCount,
  forget,
  getRaw,
  installFromRemote,
  listAll,
  markSynced,
  metaFor,
  pendingFor,
  persistDeviceRegistry,
} from './vault'
import { isDevicePath, localDeviceName, recordWrite } from './devices'
import { pushVersion } from './db'
import { hashBlob, hashText, isNotePath, mimeForPath, ymd } from './util'

/**
 * The name this device signs conflict copies with. One value for every engine:
 * it is what the machine is called, not what a particular target is called.
 */
let deviceLabel = 'device'

export function setDeviceLabel(name: string): void {
  deviceLabel = name
}

/**
 * "The user has stopped typing" — announced once, listened to by every engine.
 *
 * The editor has one such moment and should not have to know how many places
 * want telling about it, or how soon each of them wants to act: a folder on
 * this machine is worth writing to within a second or two, and a server across
 * a network is worth waiting a little longer for so a paragraph goes up as one
 * request rather than four. Each engine's own module decides that for itself.
 */
const settleHooks = new Set<() => void>()

export function onEditsSettled(fn: () => void): () => void {
  settleHooks.add(fn)
  return () => settleHooks.delete(fn)
}

export function editsSettled(): void {
  for (const fn of settleHooks) fn()
}

export interface EngineConfig {
  /** Which half of each file's bookkeeping this engine owns. */
  slot: SyncSlot
  /** Web Lock name, so two windows of one vault don't reconcile it at once. */
  lock: string
  /** Skip runs entirely while the browser reports being offline. */
  needsNetwork: boolean
  /**
   * Publish this device's write registry with each run.
   *
   * True for the cloud, which is how other *devices* learn who wrote a note.
   * False for the folder: the registry is an ordinary vault file and syncs to
   * disk like any other, but a write to a directory on this machine is not a
   * fact about this device that anywhere else needs told.
   */
  publishDevices: boolean
  /** What the status line calls this target when it is idle and connected. */
  describeIdle: (adapter: RemoteAdapter) => string
  /** What the status line says when nothing is attached. */
  idleDetail: string
}

export class SyncEngine {
  readonly status = signal<SyncStatus>({ phase: 'idle', pendingCount: 0, conflictCount: 0 })

  /** Paths that produced a conflict copy in the most recent run, for the UI banner. */
  readonly recentConflicts = signal<string[]>([])

  /**
   * Files the most recent run could not reconcile, and why.
   *
   * A run that fails on some of its files is not a run that succeeded. The whole
   * point of a per-file error being caught is that the *other* files still go
   * through; the price of that is that somebody has to remember which ones did
   * not, or "Synced" ends up meaning "tried".
   */
  readonly recentFailures = signal<Array<{ path: string; error: string }>>([])

  private adapter: RemoteAdapter | undefined
  private running: Promise<void> | undefined
  /** Set when a run is requested while one is already in flight. */
  private rerunRequested = false

  /**
   * Bumped every time the adapter changes.
   *
   * A run is a plan drawn up against one target — paths, revisions, ids — and
   * changing it halfway through would push the second half of that plan at
   * something that has never seen any of it. The run captures the number it
   * started with and every call checks it, so a switch abandons the run instead
   * of half-applying it.
   */
  private generation = 0
  private runGeneration = -1

  constructor(private cfg: EngineConfig) {}

  get slot(): SyncSlot {
    return this.cfg.slot
  }

  /**
   * The adapter this run is talking to, or an error if it is no longer the one
   * the app is configured for.
   */
  private remote(): RemoteAdapter {
    if (!this.adapter || this.runGeneration !== this.generation)
      throw new Error('The target changed while syncing — this run was abandoned.')
    return this.adapter
  }

  setAdapter(a: RemoteAdapter | undefined): void {
    this.adapter = a
    this.generation++
    this.status.value = {
      ...this.status.value,
      phase: 'idle',
      detail: a ? this.cfg.describeIdle(a) : this.cfg.idleDetail,
      lastError: undefined,
    }
  }

  currentAdapter(): RemoteAdapter | undefined {
    return this.adapter
  }

  /**
   * Number of local files this target has not confirmed. Drives the status pill.
   *
   * The vault keeps this as a running total. It used to be counted here, by
   * copying the whole file map and filtering it — which is cheap once and was
   * not being asked once: `setStatus` reads it, and a run over a large vault
   * reports progress a few hundred times.
   */
  pendingCount(): number {
    /*
     * Nothing is owed to a target that is not there.
     *
     * The folder's count is derived from what each file says the folder last
     * confirmed, and with no folder attached that is "nothing, ever" for every
     * file in the vault — which is the right answer to "what would a folder
     * need writing to it" and a badly wrong one to "how far behind are you".
     */
    if (this.cfg.slot !== 'folder') return dirtyCount()
    return this.adapter ? folderPendingCount() : 0
  }

  /**
   * Patch the status line, always with a fresh pending count.
   *
   * Public because the scheduling around an engine has things to say too — that
   * the network came back, that a folder needs its permission handed over — and
   * every one of those is a moment the count may have moved. A caller writing
   * `status.value` directly would be a status line reporting "3 pending" long
   * after they went up.
   */
  setStatus(patch: Partial<SyncStatus>): void {
    this.status.value = { ...this.status.value, ...patch, pendingCount: this.pendingCount() }
  }

  /* ----------------------------------------------------------------- entry */

  /**
   * Run a reconcile. Safe to call at any time from anywhere: concurrent calls
   * coalesce, and a call made during a run schedules exactly one more run after
   * it, so a burst of triggers can't stampede the target.
   */
  run(): Promise<void> {
    if (this.running) {
      this.rerunRequested = true
      return this.running
    }
    this.running = (async () => {
      try {
        await this.runOnce()
      } finally {
        this.running = undefined
      }
      if (this.rerunRequested) {
        this.rerunRequested = false
        await this.run()
      }
    })()
    return this.running
  }

  private async runOnce(): Promise<void> {
    if (!this.adapter) {
      this.setStatus({ phase: 'idle', detail: this.cfg.idleDetail })
      return
    }
    if (this.cfg.needsNetwork && !navigator.onLine) {
      this.setStatus({ phase: 'offline', detail: 'Offline — changes are saved locally' })
      return
    }
    return this.withLock(() => this.runLocked())
  }

  /**
   * Run the body only if no other tab of this vault is reconciling this target.
   *
   * Every ordinary tab boots its own engines, so without this two of them
   * reconcile the same vault against the same target at the same time — the same
   * files listed, uploaded and stamped twice, and each one's write looking to the
   * other like a change from a different device. The tab that skips loses
   * nothing: writes are mirrored between windows, so whichever tab holds the lock
   * is pushing everything both of them have.
   *
   * Web Locks are released when the tab holding one goes away, crash included, so
   * a lock can never be left behind. Where the API is missing the behaviour is
   * exactly what it was before.
   */
  private async withLock(body: () => Promise<void>): Promise<void> {
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
    if (!locks) return body()
    let ran = false
    await locks.request(this.cfg.lock, { ifAvailable: true }, async (lock) => {
      if (!lock) return
      ran = true
      await body()
    })
    if (!ran) this.setStatus({ detail: 'Another window of this vault is syncing…' })
  }

  private async runLocked(): Promise<void> {
    const conflicts: string[] = []
    /** Files this run could not reconcile. See `recentFailures`. */
    const failures: Array<{ path: string; error: string }> = []
    this.runGeneration = this.generation
    try {
      // Anything this device pushed since the last run is written out now, so it
      // travels with this run rather than waiting for the next one.
      if (this.cfg.publishDevices) await persistDeviceRegistry()
      this.setStatus({
        phase: 'listing',
        detail: 'Checking for changes…',
        progress: 0,
        lastError: undefined,
      })
      if (!this.remote().isConnected()) await this.remote().connect()

      const remoteList = await this.remote().list()
      const remoteFiles = new Map<string, RemoteEntry>()
      for (const e of remoteList) if (!e.isDir) remoteFiles.set(e.path, e)

      const paths = new Set<string>([...listAll().map((f) => f.path), ...remoteFiles.keys()])
      // Device records go first. They are tiny, and a note pulled after the file
      // that says who wrote it can be attributed in this run instead of the next.
      const ordered = [...paths].sort((a, b) => Number(isDevicePath(b)) - Number(isDevicePath(a)))
      const plan: Array<() => Promise<void>> = []

      for (const path of ordered) {
        const R = remoteFiles.get(path)
        // The local side is read when the item actually runs, not now: a run can
        // take seconds, and an edit made in the meantime must not be reconciled
        // away on the strength of a stale snapshot.
        plan.push(() => this.reconcile(path, R, conflicts))
      }

      this.setStatus({ phase: 'pulling', detail: `Syncing ${plan.length} files…` })

      // Bounded concurrency: enough to keep the pipe busy, low enough that a
      // rate-limited backend does not start returning 403s.
      const CONCURRENCY = 5
      let done = 0
      let cursor = 0
      const workers = Array.from({ length: Math.min(CONCURRENCY, plan.length) }, async () => {
        // A target swapped out from under the run makes the rest of the plan
        // meaningless, so the workers stop rather than failing every file in turn.
        while (cursor < plan.length && this.runGeneration === this.generation) {
          const i = cursor++
          try {
            await plan[i]()
          } catch (e) {
            // One bad file must not abort the whole run; the rest still sync and
            // the failure is retried next time. It is recorded, though — a run
            // that could not write half the vault must not report "Synced".
            failures.push({ path: ordered[i], error: (e as Error).message ?? String(e) })
            console.warn('[slate] sync item failed', ordered[i], e)
          }
          done++
          if (done % 5 === 0 || done === plan.length)
            this.setStatus({
              progress: done / plan.length,
              detail: `Syncing ${done}/${plan.length}…`,
            })
        }
      })
      await Promise.all(workers)
      if (this.cfg.publishDevices) await this.pushDeviceRegistry()

      this.recentConflicts.value = conflicts
      this.recentFailures.value = failures

      if (failures.length) {
        // Degraded, not done. `lastSyncAt` is the moment the two sides were last
        // known to agree, and after this run they demonstrably do not, so it is
        // left where it was. Those files are still pending and go again next run.
        const n = failures.length
        const summary = `${n} file${n === 1 ? '' : 's'} could not sync (${failures[0].path}: ${failures[0].error})`
        this.setStatus({
          phase: 'error',
          progress: undefined,
          conflictCount: conflicts.length,
          lastError: summary,
          detail: `Synced ${done - n} of ${plan.length} — ${n} failed`,
        })
        return
      }

      this.setStatus({
        phase: 'idle',
        progress: undefined,
        lastSyncAt: Date.now(),
        conflictCount: conflicts.length,
        detail: conflicts.length
          ? `Synced — ${conflicts.length} conflict ${conflicts.length === 1 ? 'copy' : 'copies'} kept`
          : this.cfg.describeIdle(this.remote()),
      })
    } catch (e) {
      // Whatever got through before this still counts, and whatever did not is
      // still worth naming — the banner reads "the last run", not "the last run
      // that finished".
      this.recentFailures.value = failures
      const msg = (e as Error).message ?? String(e)
      this.setStatus({
        phase: 'error',
        progress: undefined,
        lastError: msg,
        detail: msg,
      })
    }
  }

  /**
   * Save this run's record of what this device pushed, and push it too.
   *
   * It only becomes pending at the very end of the run that filled it, so
   * leaving it to the next run would mean the other devices learn who wrote a
   * note one sync later than the note itself — and the pending-changes count
   * would never settle at zero. A failure here costs nothing but that delay.
   */
  private async pushDeviceRegistry(): Promise<void> {
    try {
      const path = await persistDeviceRegistry()
      if (!path) return
      const f = getRaw(path)
      if (f && pendingFor(f, this.cfg.slot))
        await this.push(path, f, metaFor(f, this.cfg.slot).remoteRev)
    } catch (e) {
      console.warn('[slate] could not publish the device registry', e)
    }
  }

  /* ------------------------------------------------------------- reconcile */

  private async reconcile(
    path: string,
    R: RemoteEntry | undefined,
    conflicts: string[],
  ): Promise<void> {
    const slot = this.cfg.slot
    const L = getRaw(path)

    // ---- remote-only: a file another device created. Pull it.
    if (!L && R) return this.pull(path, R, conflicts)

    if (!L) return

    // ---- tombstone handling
    if (L.deleted) {
      if (!R) {
        // The target agrees it is gone. The tombstone has done its job here.
        await forget(path, slot)
        return
      }
      const remoteMoved = this.remoteChanged(L, R)
      if (remoteMoved) {
        // Someone edited this file after we deleted it. An edit beats a delete —
        // resurrect rather than destroy work we can't see.
        await this.pull(path, R, conflicts)
        return
      }
      // The revision goes with the delete. The check above was made against a
      // listing that may be seconds old by the time this file's turn comes round,
      // and a third device can write in that window; the adapter refuses rather
      // than deleting a version nobody here has ever seen.
      try {
        await this.remote().remove(R, R.rev)
      } catch (e) {
        if (!isPreconditionFailed(e)) throw e
        const fresh = (await this.remote().list()).find((x) => x.path === path && !x.isDir)
        // Same rule as above, one round later: an edit beats a delete.
        if (fresh) return this.pull(path, fresh, conflicts)
        // Refused, and now absent — someone else deleted it first. Nothing to do
        // but agree.
      }
      await forget(path, slot)
      return
    }

    const meta = metaFor(L, slot)
    const localChanged = pendingFor(L, slot)

    // ---- local-only
    if (!R) {
      if (meta.baseHash === undefined) {
        // Never reconciled with this target: this is simply a new local file.
        return this.push(path, L, undefined)
      }
      if (localChanged) {
        // Deleted there, but we have unpushed changes. Content wins: re-upload.
        return this.push(path, L, undefined)
      }
      // Deleted there and we have nothing newer. Accept the deletion — and pass
      // it on to the other target, which is still holding a copy.
      if (L.kind === 'note') {
        await pushVersion({
          path,
          at: Date.now(),
          text: L.text ?? '',
          hash: L.hash,
          reason: 'delete',
          device: localDeviceName(),
        })
      }
      await acceptDeletion(path, slot)
      return
    }

    // ---- both sides exist
    const rChanged = this.remoteChanged(L, R)

    if (!localChanged && !rChanged) return
    if (!localChanged && rChanged) return this.pull(path, R, conflicts)
    if (localChanged && !rChanged) return this.push(path, L, meta.remoteRev)

    // ---- both changed
    return this.resolve(path, L, R, conflicts)
  }

  /**
   * Has the target moved since we last agreed with it?
   *
   * Prefer the revision identifier. Fall back to modified time only when the
   * adapter gives us no revision at all, and when in doubt answer "yes" — a
   * needless pull is harmless, a missed one loses an edit.
   */
  private remoteChanged(L: VaultFile, R: RemoteEntry): boolean {
    const m = metaFor(L, this.cfg.slot)
    if (R.rev !== undefined && m.remoteRev !== undefined) return R.rev !== m.remoteRev
    if (R.rev !== undefined && m.remoteRev === undefined) return true
    if (R.mtime !== undefined && m.remoteMtime !== undefined)
      return Math.abs(R.mtime - m.remoteMtime) > 1500
    return true
  }

  /* ------------------------------------------------------------------ pull */

  /**
   * A row for content that has just arrived from this engine's target.
   *
   * Where the two targets differ, and the reason a folder and a cloud backend
   * add up to more than either alone. What came off the disk is settled with
   * the folder and unknown to the cloud, so the cloud run sends it onward; what
   * came off the cloud is settled with the cloud and unknown to the folder, so
   * the folder run writes it to disk. Neither engine has to know the other
   * exists — each simply declines to speak for a target that is not its own.
   */
  private rowFrom(
    base: Omit<VaultFile, 'dirty' | 'sync' | 'folder'>,
    existing: VaultFile | undefined,
    meta: SyncMeta,
  ): VaultFile {
    if (this.cfg.slot === 'folder') {
      const cloud = existing?.sync ?? {}
      return { ...base, dirty: cloud.baseHash !== base.hash, sync: cloud, folder: meta }
    }
    return { ...base, dirty: false, sync: meta, folder: existing?.folder }
  }

  private async pull(path: string, R: RemoteEntry, conflicts: string[]): Promise<void> {
    const now = Date.now()
    const existing = getRaw(path)
    if (isNotePath(path) || path.endsWith('.json')) {
      const { text, rev, mtime } = await this.remote().getText(R)
      const hash = await hashText(text)
      // Typing does not stop for a network round trip. If the file changed
      // locally while this request was in flight, installing the remote text
      // would erase an edit the target has never seen — merge it instead.
      const raced = this.racedLocalEdit(path, hash)
      if (raced) return this.resolve(path, raced, R, conflicts, text)
      await installFromRemote([
        this.rowFrom(
          {
            path,
            kind: 'note',
            text,
            mime: mimeForPath(path),
            size: text.length,
            hash,
            mtime: mtime ?? now,
            ctime: existing?.ctime ?? mtime ?? now,
            deleted: false,
          },
          existing,
          {
            baseHash: hash,
            baseText: text,
            remoteRev: rev ?? R.rev,
            remoteMtime: mtime ?? R.mtime,
            lastSyncedAt: now,
          },
        ),
      ])
      return
    }

    const { blob, rev, mtime } = await this.remote().getBlob(R)
    const hash = await hashBlob(blob)
    const raced = this.racedLocalEdit(path, hash)
    if (raced) return this.resolve(path, raced, R, conflicts)
    await installFromRemote([
      this.rowFrom(
        {
          path,
          kind: 'attachment',
          blob,
          mime: blob.type || mimeForPath(path),
          size: blob.size,
          hash,
          mtime: mtime ?? now,
          ctime: existing?.ctime ?? mtime ?? now,
          deleted: false,
        },
        existing,
        {
          baseHash: hash,
          remoteRev: rev ?? R.rev,
          remoteMtime: mtime ?? R.mtime,
          lastSyncedAt: now,
        },
      ),
    ])
  }

  /**
   * Does the local file hold unpushed content that differs from what we just
   * downloaded? If so the pull would erase an edit the target has never seen, and
   * the two sides have to be merged instead.
   *
   * A tombstone is not an edit: writing the remote copy over a local tombstone is
   * the resurrection the caller is deliberately performing.
   */
  private racedLocalEdit(path: string, remoteHash: string): VaultFile | undefined {
    const cur = getRaw(path)
    if (!cur || cur.deleted || !pendingFor(cur, this.cfg.slot)) return undefined
    return cur.hash === remoteHash ? undefined : cur
  }

  /* ------------------------------------------------------------------ push */

  private async push(path: string, L: VaultFile, ifMatch: string | undefined): Promise<void> {
    const body = L.kind === 'note' ? (L.text ?? '') : L.blob
    if (body === undefined) return
    const mime = L.mime || mimeForPath(path)

    try {
      const res = await this.remote().put(path, body, mime, ifMatch)
      if (this.cfg.publishDevices) recordWrite(path)
      await markSynced(
        path,
        {
          baseHash: L.hash,
          baseText: L.kind === 'note' ? (L.text ?? '') : undefined,
          remoteRev: res.rev,
          remoteMtime: res.mtime,
        },
        this.cfg.slot,
      )
    } catch (e) {
      if (isPreconditionFailed(e)) {
        // The target changed between our listing and our write. Re-list just this
        // file and fall through to a proper merge instead of forcing.
        const fresh = (await this.remote().list()).find((x) => x.path === path && !x.isDir)
        if (fresh) {
          const conflicts: string[] = []
          await this.resolve(path, L, fresh, conflicts)
          if (conflicts.length)
            this.recentConflicts.value = [...this.recentConflicts.value, ...conflicts]
          return
        }
      }
      throw e
    }
  }

  /* -------------------------------------------------------------- conflict */

  /**
   * Both sides changed since the last run.
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
  private async resolve(
    path: string,
    L: VaultFile,
    R: RemoteEntry,
    conflicts: string[],
    knownRemoteText?: string,
  ): Promise<void> {
    const slot = this.cfg.slot
    if (L.kind === 'attachment') {
      const { blob } = await this.remote().getBlob(R)
      const remoteHash = await hashBlob(blob)
      if (remoteHash === L.hash) {
        // Same bytes on both sides — not a conflict at all, just re-stamp.
        await markSynced(
          path,
          { baseHash: L.hash, remoteRev: R.rev, remoteMtime: R.mtime },
          slot,
        )
        return
      }
      const copy = this.conflictPath(path)
      await addAttachment(blob, copy)
      conflicts.push(copy)
      await this.push(path, L, R.rev)
      return
    }

    const remoteText = knownRemoteText ?? (await this.remote().getText(R)).text
    const localText = L.text ?? ''

    if (remoteText === localText) {
      await markSynced(
        path,
        {
          baseHash: L.hash,
          baseText: localText,
          remoteRev: R.rev,
          remoteMtime: R.mtime,
        },
        slot,
      )
      return
    }

    const base = metaFor(L, slot).baseText
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
          device: localDeviceName(),
        })
        const stamped: SyncMeta = {
          ...metaFor(L, slot),
          remoteRev: R.rev,
          remoteMtime: R.mtime,
        }
        await installFromRemote([
          {
            ...L,
            text: m.merged,
            hash,
            size: m.merged.length,
            mtime: now,
            // Merged text is new to *both* targets, whichever one produced it.
            dirty: true,
            sync: slot === 'cloud' ? stamped : L.sync,
            folder: slot === 'folder' ? stamped : L.folder,
          },
        ])
        const merged = getRaw(path)
        if (merged) await this.push(path, merged, R.rev)
        return
      }
    }

    // Overlapping edits, or no common ancestor to merge against. Keep both.
    const copy = this.conflictPath(path)
    const now = Date.now()
    const header =
      `---\nconflict-of: "${path}"\nconflict-at: ${new Date(now).toISOString()}\n---\n\n` +
      `> This is the version that was on ${this.conflictSource()} when a conflicting edit\n` +
      `> was found. Your version is still in **${path}**. Merge whatever you need from\n` +
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
        // New to both targets: neither has ever seen this file.
        dirty: true,
        sync: {},
      },
    ])
    conflicts.push(copy)

    // Now the local version can safely take the canonical path.
    await this.push(path, L, R.rev)
  }

  /** What the conflict copy's header calls the side it came from. */
  private conflictSource(): string {
    return this.cfg.slot === 'folder' ? 'disk, in the connected folder,' : 'the server'
  }

  /**
   * Where a conflict copy goes.
   *
   * The name has to be unique or it is not a copy at all — writing one conflict
   * copy over another is precisely the content loss the copy exists to prevent,
   * and two conflicts on one note within the same minute is not exotic: a note
   * open on two machines produces exactly that. Seconds narrow the window and the
   * counter closes it, including against a copy still sitting in the vault from a
   * previous run.
   */
  private conflictPath(path: string): string {
    const dot = path.lastIndexOf('.')
    const stem = dot > 0 ? path.slice(0, dot) : path
    const ext = dot > 0 ? path.slice(dot) : ''
    const now = new Date()
    const stamp = `${ymd(now.getTime())} ${now.toTimeString().slice(0, 8).replace(/:/g, '')}`
    const base = `${stem} (conflict — ${deviceLabel} ${stamp})`
    let out = `${base}${ext}`
    for (let n = 2; getRaw(out); n++) out = `${base} ${n}${ext}`
    return out
  }
}
