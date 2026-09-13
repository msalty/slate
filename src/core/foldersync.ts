/**
 * Connected Folder: the vault as ordinary files in a directory you chose.
 *
 * What this adds to Slate is not a new place to put notes — the vault has
 * always been a flat set of Markdown files — but a place *other programs can
 * reach*. With a folder attached, `Work/Standup.md` is a real file on a real
 * disk: Obsidian opens it, `git diff` shows what changed in it, ripgrep finds
 * it, and a backup tool copies it. Slate becomes one of the editors of your
 * notes rather than the only one.
 *
 * It sits *beside* the backend in Settings rather than replacing it, and that
 * is the point of the whole feature. A folder is on one machine; WebDAV and
 * Google Drive reach a phone. Attach both and each edit takes the obvious
 * route: something typed in Obsidian is read off the disk by the folder engine
 * and pushed to the server by the cloud engine, so it is on your phone a minute
 * later; something typed on the phone comes down through the server and is
 * written to disk, so Obsidian has it the next time you look. Neither engine
 * knows the other exists — see core/engine.ts for why that is enough.
 *
 * Three practical things live here rather than in the adapter, because they are
 * about the *session* rather than about the filesystem:
 *
 *  - **The handle.** A `FileSystemDirectoryHandle` survives in IndexedDB across
 *    reloads, so the folder is remembered rather than re-picked every morning.
 *  - **Permission.** Remembering the handle is not permission to use it.
 *    Chromium re-asks on a new session unless the app is installed, and it only
 *    asks inside a click — so a lost permission is surfaced as a signal the UI
 *    turns into a Reconnect button, never as a failed sync.
 *  - **Noticing.** Nothing tells a web page that a file changed on disk. Where
 *    `FileSystemObserver` exists, it does; everywhere else a sweep runs on a
 *    timer while the tab is visible.
 */

import { signal } from '@preact/signals'
import { FolderAdapter, folderModeSupported } from '../adapters/folder'
import { SyncEngine, onEditsSettled, type EngineConfig } from './engine'
import { getMeta, setMeta } from './db'
import { clearFolderMeta, listAll } from './vault'
import type { RemoteEntry } from './types'

export { folderModeSupported }

/** Where the directory handle is kept. Device-local, like every credential. */
const HANDLE_KEY = 'folder.handle'

/**
 * How the folder engine is configured.
 *
 * `needsNetwork: false` — a folder on this machine is exactly the target that
 * still works on a train, and refusing to write to it because the wifi is down
 * would be absurd. `publishDevices: false` — the write registry is how other
 * *machines* learn who wrote a note, and a directory on this one is not another
 * machine; the registry files still sync to disk as ordinary vault files.
 *
 * Exported so the tests reconcile against a folder through exactly the engine
 * the app uses, rather than one configured to resemble it.
 */
export const FOLDER_ENGINE: EngineConfig = {
  slot: 'folder',
  lock: 'slate:sync:folder',
  needsNetwork: false,
  publishDevices: false,
  describeIdle: (a) => `In sync with ${a.describe()}`,
  idleDetail: 'No folder connected',
}

const folder = new SyncEngine(FOLDER_ENGINE)

export const folderStatus = folder.status
export const folderConflicts = folder.recentConflicts
export const folderFailures = folder.recentFailures

/** The attached directory's name, or '' when there isn't one. Drives the UI. */
export const folderName = signal('')

/**
 * True when a folder is remembered but the browser has not been asked for
 * permission to use it in this session.
 *
 * The one state that needs a button rather than a retry: `requestPermission`
 * only works inside a user gesture, so nothing here can resolve it on its own.
 */
export const folderNeedsPermission = signal(false)

/** True while the folder engine is attached and usable. */
export const folderConnected = signal(false)

let adapter: FolderAdapter | undefined
let handle: FileSystemDirectoryHandle | undefined
let timer: ReturnType<typeof setInterval> | undefined
let observer: FileSystemObserver | undefined
let listenersInstalled = false

export function folderSync(): Promise<void> {
  return folder.run()
}

/* ------------------------------------------------------------- permissions */

async function permissionState(
  h: FileSystemDirectoryHandle,
): Promise<PermissionState> {
  // Absent in a browser that has the picker but not the extension, and in the
  // tests' stub. Treat that as granted: the operations themselves will fail
  // clearly enough if it is not.
  return (await h.queryPermission?.({ mode: 'readwrite' })) ?? 'granted'
}

/**
 * Ask for permission to use the remembered folder again.
 *
 * MUST be called from inside a click. Returns whether the folder is now usable;
 * a `false` leaves everything exactly as it was, folder included.
 */
export async function reconnectFolder(): Promise<boolean> {
  if (!handle) return false
  const state = await handle.requestPermission?.({ mode: 'readwrite' })
  if (state !== undefined && state !== 'granted') return false
  folderNeedsPermission.value = false
  attach(handle)
  await folderSync()
  return true
}

/* ------------------------------------------------------------- attach/detach */

function attach(h: FileSystemDirectoryHandle): void {
  handle = h
  adapter = new FolderAdapter(h)
  folder.setAdapter(adapter)
  folderName.value = h.name
  folderConnected.value = true
  startWatching()
}

function detach(): void {
  stopWatching()
  adapter = undefined
  folder.setAdapter(undefined)
  folderConnected.value = false
}

/**
 * Reattach the folder remembered from a previous session, if there is one and
 * we may still use it.
 *
 * Called on boot and whenever the setting changes. Never prompts — see the note
 * on `folderNeedsPermission`.
 */
export async function restoreFolder(enabled: boolean): Promise<void> {
  if (!enabled || !folderModeSupported()) {
    detach()
    folderNeedsPermission.value = false
    folderName.value = ''
    return
  }
  const stored = await getMeta<FileSystemDirectoryHandle>(HANDLE_KEY)
  if (!stored) {
    detach()
    folderName.value = ''
    return
  }
  // Already running against this very folder. Re-attaching would abandon a run
  // in flight and re-list the whole directory to learn nothing, and this is
  // called again for every unrelated settings change.
  if (adapter && handle && (await stored.isSameEntry(handle))) return
  handle = stored
  folderName.value = stored.name
  const state = await permissionState(stored)
  if (state !== 'granted') {
    // Remembered, not usable. The UI offers the button; nothing is lost while
    // it goes unpressed, because the folder's files are untouched either way.
    detach()
    folderNeedsPermission.value = true
    folder.setStatus({ phase: 'idle', detail: `“${stored.name}” needs permission again` })
    return
  }
  folderNeedsPermission.value = false
  attach(stored)
  // Not awaited: this runs from boot and from every settings change, and a
  // first sweep of a large folder must not hold either of them up.
  void folderSync()
}

/**
 * Open the picker and connect what comes back.
 *
 * MUST be called from inside a click. Returns the chosen directory without
 * connecting it, so the caller can show what connecting would do — see
 * `previewFolder` — and only then call `connectFolder`.
 */
export async function pickFolder(): Promise<FileSystemDirectoryHandle | undefined> {
  if (!folderModeSupported()) throw new Error('This browser cannot open a folder.')
  try {
    return await showDirectoryPicker({ id: 'slate-vault', mode: 'readwrite' })
  } catch (e) {
    // The picker throws AbortError when it is dismissed, which is not an error
    // anybody wants reported.
    if ((e as Error).name === 'AbortError') return undefined
    throw e
  }
}

/**
 * What connecting this folder would do, before anything is written.
 *
 * Pointing Slate at a directory that already holds notes is the normal way this
 * feature gets used, and it is also the moment somebody most wants to know they
 * are not about to lose the other side. Nothing here writes: it lists the
 * folder, compares paths with the vault, and counts.
 *
 * Paths in both are deliberately not opened and compared. Reading every file on
 * both sides to say whether they match would take real time on a large vault,
 * and it would not change the answer given for them, which is the honest one:
 * identical files are recognised as agreement and nothing happens to them, and
 * different ones keep both versions.
 */
export interface FolderPreview {
  /** Files in the folder that the vault has not got. */
  incoming: number
  /** Files in the vault the folder has not got. */
  outgoing: number
  /** Paths both sides hold. Matching ones settle; differing ones keep both. */
  shared: number
}

export async function previewFolder(h: FileSystemDirectoryHandle): Promise<FolderPreview> {
  const probe = new FolderAdapter(h)
  await probe.connect()
  const there = new Set(
    (await probe.list()).filter((e: RemoteEntry) => !e.isDir).map((e: RemoteEntry) => e.path),
  )
  const here = new Set(listAll().filter((f) => !f.deleted).map((f) => f.path))
  let shared = 0
  for (const p of here) if (there.has(p)) shared++
  return { incoming: there.size - shared, outgoing: here.size - shared, shared }
}

/** Remember this folder and start reconciling against it. */
export async function connectFolder(h: FileSystemDirectoryHandle): Promise<void> {
  await setMeta(HANDLE_KEY, h)
  folderNeedsPermission.value = false
  attach(h)
  await folderSync()
}

/**
 * Stop using the folder. Nothing in it is touched.
 *
 * The files stay exactly where they are and exactly as they are — that is the
 * whole promise, and it is why disconnecting is a safe thing to try. What goes
 * is this device's *memory* of the folder: the stored handle, and every file's
 * record of what the folder last confirmed. Reconnecting later therefore starts
 * from nothing rather than from a description of a directory that may since
 * have been moved, restored from a backup, or replaced by a different one.
 *
 * The vault is untouched too. Every note is still in browser storage and still
 * syncs to whatever backend is configured, so disconnecting a folder is not a
 * way to lose notes in either direction.
 */
export async function disconnectFolder(): Promise<void> {
  detach()
  handle = undefined
  folderName.value = ''
  folderNeedsPermission.value = false
  await setMeta(HANDLE_KEY, undefined)
  await clearFolderMeta()
  folder.setStatus({
    phase: 'idle',
    detail: 'No folder connected',
    conflictCount: 0,
    lastError: undefined,
    progress: undefined,
  })
}

/* -------------------------------------------------------------- scheduling */

/**
 * How often to sweep when nothing better is available, and how often when
 * something is.
 *
 * A sweep is a directory walk plus a stat of every file. That is local and fast
 * but it is not free, so where `FileSystemObserver` tells us the moment a file
 * changes, the timer drops back to a safety net for the cases an observer can
 * miss — a folder replaced wholesale by a `git checkout`, or a watch the
 * browser quietly dropped.
 */
const OBSERVED_SWEEP_SEC = 60

let pollSec = 5

export function setFolderPollSec(sec: number): void {
  pollSec = Math.max(2, sec)
  if (timer) startWatching()
}

function startWatching(): void {
  stopWatching()
  installListeners()
  startObserver()
  const every = observer ? OBSERVED_SWEEP_SEC : pollSec
  timer = setInterval(() => {
    // A hidden tab has nobody looking at it and no edits arriving through it.
    // Sweeping anyway would spin the disk in the background of every other
    // thing the machine is doing, for a screen nobody can see.
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
    void folderSync()
  }, every * 1000)
}

function stopWatching(): void {
  if (timer) clearInterval(timer)
  timer = undefined
  observer?.disconnect()
  observer = undefined
}

/**
 * Watch the folder properly, where the browser can.
 *
 * `FileSystemObserver` is new and not everywhere, so everything about it is
 * optional: it is feature-detected, its `observe` is allowed to reject, and a
 * failure at any point simply leaves the timer above running at its full rate.
 * When it does work, a file saved in Obsidian shows up in Slate immediately
 * rather than at the top of the next sweep.
 */
function startObserver(): void {
  if (typeof FileSystemObserver !== 'function' || !handle) return
  try {
    const obs = new FileSystemObserver(() => void folderSync())
    void obs.observe(handle, { recursive: true }).catch(() => {
      // Rejected — no watch. Fall back to sweeping at the full rate.
      obs.disconnect()
      if (observer === obs) {
        observer = undefined
        startWatching()
      }
    })
    observer = obs
  } catch {
    observer = undefined
  }
}

function installListeners(): void {
  if (listenersInstalled || typeof document === 'undefined') return
  listenersInstalled = true
  // Coming back to Slate after editing in another program is the single most
  // likely moment for the folder to have changed underneath it, and both of
  // these are worth listening to: a tab switch fires `visibilitychange`, and an
  // installed window that never becomes hidden only fires `focus`.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && adapter) void folderSync()
  })
  addEventListener('focus', () => {
    if (adapter) void folderSync()
  })
}

/**
 * Write out shortly after the edits stop.
 *
 * A second and a bit, against the cloud engine's four. Writing to a local disk
 * costs nothing worth batching for, and the reason to be quick is that the
 * other program looking at these files is probably open on the other monitor.
 */
onEditsSettled((() => {
  let t: ReturnType<typeof setTimeout> | undefined
  return () => {
    if (!adapter) return
    if (t) clearTimeout(t)
    t = setTimeout(() => void folderSync(), 1200)
  }
})())
