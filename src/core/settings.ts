/**
 * Settings live in two places on purpose.
 *
 *  - Device-local (IndexedDB `meta`): credentials, backend choice, device id.
 *    These must NOT sync — a WebDAV password or a Drive folder id belongs to
 *    one device, and syncing them would put secrets in the vault.
 *  - Vault-wide (backstage/config.json): preferences you want everywhere —
 *    theme, panel visibility, image settings, attachment folder.
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
] as const

type SharedKey = (typeof SHARED_KEYS)[number]

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
  settings.value = merged
  loaded = true
}

/** Overlay the vault-wide preferences read from backstage/config.json. */
export async function applySharedSettings(): Promise<void> {
  const shared = await readBackstage<Partial<AppSettings>>('config.json')
  if (!shared) return
  const next = { ...settings.value }
  for (const k of SHARED_KEYS) {
    if (shared[k] !== undefined) (next as Record<string, unknown>)[k] = shared[k]
  }
  suppressWrite = true
  settings.value = next
  suppressWrite = false
}

let suppressWrite = false

const persistLocal = debounce((s: AppSettings) => {
  void setMeta('settings', s)
}, 200)

const persistShared = debounce((s: AppSettings) => {
  const shared: Record<string, unknown> = {}
  for (const k of SHARED_KEYS) shared[k] = s[k as SharedKey]
  void writeBackstage('config.json', shared)
}, 1500)

effect(() => {
  const s = settings.value
  if (!loaded || suppressWrite) return
  persistLocal(s)
  persistShared(s)
})

export function update(patch: Partial<AppSettings>): void {
  settings.value = { ...settings.value, ...patch }
}

export function updateWebdav(patch: Partial<AppSettings['webdav']>): void {
  settings.value = { ...settings.value, webdav: { ...settings.value.webdav, ...patch } }
}

export function updateGdrive(patch: Partial<AppSettings['gdrive']>): void {
  settings.value = { ...settings.value, gdrive: { ...settings.value.gdrive, ...patch } }
}
