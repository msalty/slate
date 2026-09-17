/** Boot helpers, kept out of main.tsx so the ordering there stays readable. */

import { initVault as loadVault, ready, warmSearchIndex } from '../core/vault'
import { loadFolders, loadSmartFolders } from '../core/folders'
import { loadTemplates } from '../core/templates'
import { applySharedSettings, loadSettings, settings } from '../core/settings'
import { loadDisclosure } from '../core/disclosure'
import { requestPersistence } from '../core/db'
import { setDeviceLabel, status } from '../core/sync'
import { folderStatus } from '../core/foldersync'
import { setLocalDevice } from '../core/devices'
import { openVaults } from '../core/vaults'

export async function initVault(): Promise<void> {
  // First, and before anything can touch storage: which vault is this window
  // showing, and therefore which database is everything below about.
  await openVaults()
  await loadSettings()
  // Which folders the sidebar had unfolded, so the tree comes back the shape
  // it was left in rather than folding itself up on every reload.
  await loadDisclosure()
  // Before the vault loads, so the device records it reads are folded into this
  // device's own entry rather than replacing it.
  setLocalDevice(settings.value.deviceId, settings.value.deviceName)
  await loadVault()
  // Folder and Tag Folder definitions live in the vault, so they are available
  // as soon as it is loaded — no extra round trip before the UI can render.
  await loadFolders()
  await loadSmartFolders()
  await loadTemplates()
  setDeviceLabel(settings.value.deviceName)
  ready.value = true
  // Nothing waits for this: it fills the search index a few milliseconds at a
  // time while the app is idle, and searching works — reading every note, as it
  // always did — from the moment the vault is up. See core/searchindex.ts.
  warmSearchIndex()
}

/**
 * Vault-wide preferences live in backstage/config.json, which may not have
 * synced yet on a fresh device. A failure here is never fatal — the local
 * defaults are perfectly usable.
 *
 * "Usable" is not "yours", though, and that gap used to last the whole session.
 * A device installed a minute ago has no config.json to read, so it boots on
 * defaults; the first sync brings the file down moments later and nothing
 * looked at it again until the next reload. What that feels like is reinstalling
 * the app and finding the editor back in live preview with every note's
 * frontmatter showing — the settings were on the server the whole time. So when
 * there was no file to read, this comes back for it.
 */
export async function applySharedSettingsSafe(): Promise<void> {
  if (!(await readVaultPrefs())) retryAfterFirstSync()
  // Ask once, after the app is up, so the prompt (where there is one) doesn't
  // land in front of a blank screen.
  void requestPersistence()
}

/**
 * The preferences and folder shapes the vault carries rather than the device.
 *
 * Answers whether the shared file was there — the folder and template loads
 * are best-effort either way, and a throw from any of them leaves the device's
 * own settings in place rather than taking the app down.
 */
async function readVaultPrefs(): Promise<boolean> {
  try {
    const applied = await applySharedSettings()
    // A first sync may have brought these in after boot.
    await loadFolders()
    await loadSmartFolders()
    await loadTemplates()
    return applied
  } catch (e) {
    console.warn('[slate] could not read shared settings', e)
    return false
  }
}

/**
 * Read them again after the first run that finishes — from either target.
 *
 * Once, and only where a file could still arrive: a vault with no backend and
 * no folder is never sent one, and a subscription waiting for a sync that
 * cannot happen is a subscription that never ends. Nothing here can undo a
 * preference changed in between — `applySharedSettings` skips the keys this
 * device has changed and not yet written, the same guard that protects a change
 * made just before a reload.
 *
 * The folder counts, and used to not. A vault whose backend is "Local only" but
 * which has a folder attached is an entirely ordinary desktop setup — it is
 * half the point of connected folders — and `backstage/config.json`, the folder
 * definitions and the templates all arrive in its first sweep exactly as they
 * would from a server. Watching only the cloud meant such a vault read the
 * files, ignored them, and ran on defaults until the next reload.
 */
function retryAfterFirstSync(): void {
  const s = settings.value
  const watched = [
    ...(s.backend !== 'none' ? [status] : []),
    ...(s.folder.enabled ? [folderStatus] : []),
  ]
  if (!watched.length) return

  let done = false
  const stops: Array<() => void> = []
  for (const sig of watched) {
    const before = sig.peek().lastSyncAt
    stops.push(
      sig.subscribe((st) => {
        // `lastSyncAt` moves only when a run completes with nothing left
        // failing, which is the only kind of run that can be trusted to have
        // brought the file down. Whichever target gets there first will do.
        if (done || st.lastSyncAt === undefined || st.lastSyncAt === before) return
        done = true
        // Out of the notification before unsubscribing from it.
        queueMicrotask(() => {
          for (const stop of stops) stop()
        })
        void readVaultPrefs()
      }),
    )
  }
}
