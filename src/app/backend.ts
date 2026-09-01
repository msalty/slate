/** Wires the settings choice to a concrete adapter and starts the sync loop. */

import type { AppSettings, RemoteAdapter } from '../core/types'
import { WebdavAdapter } from '../adapters/webdav'
import { GdriveAdapter } from '../adapters/gdrive'
import { settings, updateGdrive } from '../core/settings'
import { setAdapter, setDeviceLabel, startAutoSync, stopAutoSync, sync } from '../core/sync'
import { setLocalDevice } from '../core/devices'

export function buildAdapter(s: AppSettings): RemoteAdapter | undefined {
  if (s.backend === 'webdav') {
    if (!s.webdav.url) return undefined
    return new WebdavAdapter(s.webdav)
  }
  if (s.backend === 'gdrive') {
    if (!s.gdrive.clientId) return undefined
    return new GdriveAdapter({
      ...s.gdrive,
      // Remember the folder so later sessions skip the lookup.
      onFolderId: (id) => {
        if (settings.value.gdrive.folderId !== id) updateGdrive({ folderId: id })
      },
    })
  }
  return undefined
}

let lastSignature = ''

/**
 * (Re)build the adapter from current settings and restart the sync loop.
 * Idempotent: called on boot and whenever the relevant settings change, and a
 * no-op when nothing that matters has moved.
 */
export async function connectBackend(): Promise<void> {
  const s = settings.value
  setDeviceLabel(s.deviceName)
  // Renaming the device in Settings renames it in everyone else's history too,
  // from the next sync on.
  setLocalDevice(s.deviceId, s.deviceName)

  const sig = JSON.stringify([
    s.backend,
    s.webdav.url,
    s.webdav.username,
    s.webdav.password,
    s.webdav.root,
    s.gdrive.clientId,
    s.gdrive.folderName,
    s.autoSync,
    s.syncIntervalSec,
  ])
  if (sig === lastSignature) return
  lastSignature = sig

  stopAutoSync()
  const adapter = buildAdapter(s)
  setAdapter(adapter)

  if (!adapter) return
  if (s.autoSync) startAutoSync(s.syncIntervalSec)
  else void sync() // one catch-up pass even in manual mode
}
