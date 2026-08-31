/** Boot helpers, kept out of main.tsx so the ordering there stays readable. */

import { initVault as loadVault, ready } from '../core/vault'
import { loadFolders, loadSmartFolders } from '../core/folders'
import { applySharedSettings, loadSettings, settings } from '../core/settings'
import { requestPersistence } from '../core/db'
import { setDeviceLabel } from '../core/sync'

export async function initVault(): Promise<void> {
  await loadSettings()
  await loadVault()
  // Folder and Tag Folder definitions live in the vault, so they are available
  // as soon as it is loaded — no extra round trip before the UI can render.
  await loadFolders()
  await loadSmartFolders()
  setDeviceLabel(settings.value.deviceName)
  ready.value = true
}

/**
 * Vault-wide preferences live in backstage/config.json, which may not have
 * synced yet on a fresh device. A failure here is never fatal — the local
 * defaults are perfectly usable.
 */
export async function applySharedSettingsSafe(): Promise<void> {
  try {
    await applySharedSettings()
    // A first sync may have brought these in after boot.
    await loadFolders()
    await loadSmartFolders()
  } catch (e) {
    console.warn('[slate] could not read shared settings', e)
  }
  // Ask once, after the app is up, so the prompt (where there is one) doesn't
  // land in front of a blank screen.
  void requestPersistence()
}
