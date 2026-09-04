/**
 * Settings live in two places on purpose.
 *
 *  - Device-local (IndexedDB `meta`): credentials, backend choice, device id.
 *    These must NOT sync — a WebDAV password or a Drive folder id belongs to
 *    one device, and syncing them would put secrets in the vault.
 *  - Vault-wide (backstage/config.json): preferences you want everywhere —
 *    theme, panel visibility, image settings, attachment folder.
 *
 * The vault-wide half is written on a long timer, because a pane resizer would
 * otherwise write a file on every frame of a drag, and it is overlaid over the
 * device's own copy at boot. Two things stop that arrangement from quietly
 * undoing a change made a moment before a reload: the pending write is flushed
 * when the tab goes away, and the keys this device has changed but not yet
 * written are remembered — on disk, because the case worth defending is the
 * one where nothing got the chance to flush anything.
 */

import { signal, effect } from '@preact/signals'
import { getMeta, setMeta } from './db'
import { readBackstage, writeBackstage } from './vault'
import type { AppSettings } from './types'
import { debounce, uid } from './util'

const SHARED_KEYS = [
  'autoSync',
  'syncIntervalSec',
  'showRightRail',
  'showSidebar',
  'sidebarWidth',
  'listWidth',
  'theme',
  'editorMode',
  'editorWidth',
  'imageMaxEdge',
  'imageQuality',
  'imageFormat',
  'attachmentFolder',
  'fontSize',
  'sortBy',
  'taskGroupBy',
  'showDoneTasks',
  'collapseFolders',
  'collapseTagFolders',
  'collapseTags',
] as const

type SharedKey = (typeof SHARED_KEYS)[number]

/** Where the not-yet-written keys are kept, beside the settings themselves. */
const UNWRITTEN_KEY = 'settings.unwritten'

function defaults(): AppSettings {
  return {
    backend: 'none',
    webdav: { url: '', username: '', password: '', root: '' },
    gdrive: { clientId: '', folderId: '', folderName: 'Slate' },
    autoSync: true,
    syncIntervalSec: 60,
    showRightRail: true,
    showSidebar: true,
    sidebarWidth: 232,
    listWidth: 320,
    theme: 'system',
    editorMode: 'live',
    editorWidth: 'full',
    imageMaxEdge: 2000,
    imageQuality: 0.82,
    imageFormat: 'image/webp',
    attachmentFolder: 'attachments',
    fontSize: 15,
    sortBy: 'mtime',
    taskGroupBy: 'none',
    showDoneTasks: false,
    collapseFolders: false,
    collapseTagFolders: false,
    collapseTags: false,
    deviceId: uid(8),
    deviceName: guessDeviceName(),
  }
}

function guessDeviceName(): string {
  const ua = navigator.userAgent
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) return 'Android'
  if (/Mac OS X/.test(ua)) return 'Mac'
  if (/Windows/.test(ua)) return 'Windows PC'
  if (/Linux/.test(ua)) return 'Linux'
  return 'Device'
}

export const settings = signal<AppSettings>(defaults())

let loaded = false

export async function loadSettings(): Promise<void> {
  const local = await getMeta<Partial<AppSettings>>('settings')
  const merged = { ...defaults(), ...local }
  // Device identity is generated once and then never changes.
  if (!local?.deviceId) {
    merged.deviceId = defaults().deviceId
    await setMeta('settings', merged)
  }
  /*
   * Keys this device changed but never got into the file — from a tab that was
   * killed, or a write that did not land. They outlive the session precisely
   * because that is the case nothing else covers.
   */
  const held = await getMeta<string[]>(UNWRITTEN_KEY)
  if (Array.isArray(held)) {
    for (const k of held) if ((SHARED_KEYS as readonly string[]).includes(k)) unwritten.add(k as SharedKey)
  }
  settings.value = merged
  loaded = true
  /*
   * What this device believes the shared file says. Seeded from its own copy
   * rather than left empty, so the first preference anyone changes marks only
   * itself as unwritten instead of all sixteen.
   */
  agreed = sharedSnapshot(merged)
  installFlushOnHide()
}

/**
 * Overlay the vault-wide preferences read from backstage/config.json.
 *
 * Except the ones this device has changed since it last wrote that file. The
 * shared write is on a long timer — a pane resizer would otherwise write a
 * vault file on every frame of a drag — so a reload inside the window used to
 * read back the value from before the change and silently undo it.
 */
export async function applySharedSettings(): Promise<void> {
  const shared = await readBackstage<Partial<AppSettings>>('config.json')
  if (!shared) return
  const next = { ...settings.value }
  for (const k of SHARED_KEYS) {
    if (unwritten.has(k)) continue
    if (shared[k] !== undefined) (next as Record<string, unknown>)[k] = shared[k]
  }
  suppressWrite = true
  settings.value = next
  suppressWrite = false
  agreed = sharedSnapshot(next)
}

let suppressWrite = false

/** The shared half of the settings, which is all config.json holds. */
function sharedSnapshot(s: AppSettings): Record<string, unknown> {
  const shared: Record<string, unknown> = {}
  for (const k of SHARED_KEYS) shared[k] = s[k as SharedKey]
  return shared
}

/**
 * The shared values as of the last write or read, and the keys that have
 * changed since. `unwritten` is what protects a local change from being
 * overwritten by a stale file — including after a crash, where nothing gets
 * the chance to flush anything.
 */
let agreed: Record<string, unknown> | undefined
const unwritten = new Set<SharedKey>()

async function writeShared(s: AppSettings): Promise<void> {
  const claimed = [...unwritten]
  const snapshot = sharedSnapshot(s)
  unwritten.clear()
  try {
    await writeBackstage('config.json', snapshot)
    agreed = snapshot
    void setMeta(UNWRITTEN_KEY, [])
  } catch (e) {
    // Still unwritten, so still worth protecting from the file on next boot.
    for (const k of claimed) unwritten.add(k)
    void setMeta(UNWRITTEN_KEY, [...unwritten])
    console.warn('[slate] could not write shared settings', e)
  }
}

function writeLocal(s: AppSettings): void {
  void setMeta('settings', s)
  void setMeta(UNWRITTEN_KEY, [...unwritten])
}

const persistLocal = debounce(writeLocal, 200)

const persistShared = debounce((s: AppSettings) => {
  void writeShared(s)
}, 1500)

effect(() => {
  const s = settings.value
  if (!loaded || suppressWrite) return
  for (const k of SHARED_KEYS) if (!agreed || s[k] !== agreed[k]) unwritten.add(k)
  persistLocal(s)
  persistShared(s)
})

/**
 * Write what is still sitting in a debounce, now.
 *
 * `debounce().flush()` cancels the pending call rather than running it, so the
 * work is done here — the same shape the editor uses to make sure a buffer is
 * never left unsaved (see ui/EditorPane.tsx).
 */
export function flushSettings(): void {
  const s = settings.value
  if (persistLocal.pending()) {
    persistLocal.flush()
    writeLocal(s)
  }
  if (persistShared.pending()) {
    persistShared.flush()
    void writeShared(s)
  }
}

let flushInstalled = false

/**
 * A last write when the tab goes away, on the three events that get one. None
 * of them is guaranteed — a killed tab fires nothing, and the write itself may
 * not land — which is why `unwritten` exists rather than this alone.
 */
function installFlushOnHide(): void {
  if (flushInstalled || typeof addEventListener !== 'function' || typeof document === 'undefined')
    return
  flushInstalled = true
  addEventListener('pagehide', flushSettings)
  addEventListener('beforeunload', flushSettings)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSettings()
  })
}

export function update(patch: Partial<AppSettings>): void {
  settings.value = { ...settings.value, ...patch }
}

export function updateWebdav(patch: Partial<AppSettings['webdav']>): void {
  settings.value = { ...settings.value, webdav: { ...settings.value.webdav, ...patch } }
}

export function updateGdrive(patch: Partial<AppSettings['gdrive']>): void {
  settings.value = { ...settings.value, gdrive: { ...settings.value.gdrive, ...patch } }
}
