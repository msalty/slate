/**
 * The cloud half of syncing: one reconcile engine pointed at the backend chosen
 * in Settings — WebDAV, Google Drive, or nothing at all — plus the scheduling
 * that decides when it runs.
 *
 * The reconcile itself lives in core/engine.ts, which is shared with the
 * connected folder (core/foldersync.ts). Everything this file exports is the
 * cloud engine's own: the status the status bar draws, the `sync()` ⌘S calls,
 * and the timers and event listeners that make it automatic. It is the same
 * surface it has always had, so nothing outside had to learn that there is now
 * more than one engine.
 */

import { SyncEngine, editsSettled, onEditsSettled, setDeviceLabel } from './engine'
import type { RemoteAdapter } from './types'

export { setDeviceLabel }

/**
 * The cloud engine.
 *
 * `needsNetwork`, because a backend behind a dead connection is not a backend
 * and every file in the plan would fail the same way. `publishDevices`, because
 * the write registry is how *other machines* learn who wrote a note, and the
 * cloud is the only target that reaches one.
 */
const cloud = new SyncEngine({
  slot: 'cloud',
  lock: 'slate:sync',
  needsNetwork: true,
  publishDevices: true,
  describeIdle: (a: RemoteAdapter) => `Synced with ${a.describe()}`,
  idleDetail: 'Local only',
})

export const status = cloud.status
/** Paths that produced a conflict copy in the most recent run, for the UI banner. */
export const recentConflicts = cloud.recentConflicts
/** Files the most recent run could not sync, and why. */
export const recentFailures = cloud.recentFailures

export function setAdapter(a: RemoteAdapter | undefined): void {
  cloud.setAdapter(a)
}

export function currentAdapter(): RemoteAdapter | undefined {
  return cloud.currentAdapter()
}

/** Number of local files waiting to be pushed. Drives the status pill. */
export function pendingCount(): number {
  return cloud.pendingCount()
}

/**
 * Run a sync. Safe to call at any time from anywhere: concurrent calls
 * coalesce, and a call made during a run schedules exactly one more run after
 * it, so a burst of triggers can't stampede the server.
 */
export function sync(): Promise<void> {
  return cloud.run()
}

/* ---------------------------------------------------------------- scheduling */

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
    cloud.setStatus({ phase: 'idle', detail: 'Back online' })
    void sync()
  })
  addEventListener('offline', () => {
    cloud.setStatus({ phase: 'offline', detail: 'Offline — changes are saved locally' })
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

/**
 * Push a short while after the edits stop, when auto-sync is on.
 *
 * Four seconds, so a paragraph goes up as one request rather than four. A
 * connected folder is nudged by the same announcement but does not wait as
 * long; see core/foldersync.ts.
 */
onEditsSettled((() => {
  let t: ReturnType<typeof setTimeout> | undefined
  return () => {
    if (!timer) return
    if (t) clearTimeout(t)
    t = setTimeout(() => void sync(), 4000)
  }
})())

/**
 * Fired by the editor once edits settle.
 *
 * Every engine hears it — the cloud backend above and a connected folder — so
 * the editor announces the moment once rather than keeping a list of the places
 * that care about it.
 */
export const syncSoon = editsSettled
