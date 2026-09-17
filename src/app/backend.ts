/**
 * Wires the settings choices to concrete adapters and starts the loops.
 *
 * Two of them, independently: the cloud backend chosen in Settings, and the
 * connected folder if there is one. They are not alternatives — a vault can
 * have both, and normally wants both, because a folder is on this machine and a
 * backend is what reaches a phone.
 */

import type { AppSettings, RemoteAdapter } from '../core/types'
import { WebdavAdapter } from '../adapters/webdav'
import { GdriveAdapter } from '../adapters/gdrive'
import { settings, updateGdrive } from '../core/settings'
import { setAdapter, setDeviceLabel, startAutoSync, stopAutoSync, sync } from '../core/sync'
import { folderName, restoreFolder, setFolderPollSec } from '../core/foldersync'
import { setVaultTargets } from '../core/vaults'
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
    s.folder.enabled,
    s.folder.pollSec,
  ])
  if (sig === lastSignature) return
  lastSignature = sig

  /*
   * The folder first, and never conditional on the backend above.
   *
   * A vault whose backend is "Local only" can still be a folder-backed vault —
   * that is the whole desktop story, notes as files on a disk with no server
   * anywhere — so this runs before the early return below and does not care
   * what `backend` says.
   */
  setFolderPollSec(s.folder.pollSec)
  await restoreFolder(s.folder.enabled)
  void setVaultTargets(targetsOf(s))

  stopAutoSync()
  const adapter = buildAdapter(s)
  setAdapter(adapter)

  if (!adapter) return
  if (s.autoSync) startAutoSync(s.syncIntervalSec)
  else void sync() // one catch-up pass even in manual mode
}

/**
 * Every place this vault's content is kept, one entry each.
 *
 * Recorded on the vault's registry entry so that two vaults pointed at the same
 * place can be noticed and said out loud. That is not a tidiness complaint: two
 * separate sets of notes reconciling against one server do not stay separate —
 * each run reads the other's files as notes some device created and pulls them
 * in, and within a few minutes both vaults hold everything, with no way back
 * except by hand.
 *
 * Separate entries rather than one joined string, because a vault can have two
 * targets and sharing either one is enough to merge them. A second vault set up
 * against the same server as the first and given its own folder — which is the
 * arrangement somebody reaches for precisely *because* it feels separate — is
 * already the same vault, and a joined string would have called the two
 * completely different.
 *
 * The folder is identified by its name, which is all a directory handle will
 * tell us without being asked to compare itself against another live handle we
 * do not have. Two folders called `Notes` may well be different folders, so the
 * warning that reads this is phrased as a question rather than a verdict.
 */
function targetsOf(s: AppSettings): string[] {
  const out: string[] = []
  if (s.backend === 'webdav' && s.webdav.url)
    out.push(`webdav:${s.webdav.url.replace(/\/+$/, '')}/${s.webdav.root}`)
  if (s.backend === 'gdrive' && s.gdrive.clientId) out.push(`gdrive:${s.gdrive.folderName}`)
  if (s.folder.enabled && folderName.value) out.push(`folder:${folderName.value}`)
  return out
}
