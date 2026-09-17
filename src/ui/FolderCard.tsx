/**
 * The Connected Folder controls, in Settings → Sync.
 *
 * Above the backend rather than inside it, because a folder is not one of the
 * choices in that list: it is somewhere the vault *also* lives, and the two
 * together are the arrangement most desktops want — files on this disk for
 * Obsidian and git to work on, a server to carry them to a phone.
 *
 * The connect flow has a step in the middle on purpose. Pointing Slate at a
 * directory that already holds notes is the ordinary way this gets used, and it
 * is exactly the moment somebody wants to know they are not about to lose the
 * other side, so picking a folder shows what connecting it would do and waits.
 * Nothing is written until the second click.
 */

import { useState } from 'preact/hooks'
import { settings, updateFolder } from '../core/settings'
import {
  connectFolder,
  disconnectFolder,
  folderConnected,
  folderModeSupported,
  folderName,
  folderNeedsPermission,
  folderStatus,
  folderSync,
  pickFolder,
  previewFolder,
  type FolderPreview,
} from '../core/foldersync'
import { reconnectFolder } from '../core/foldersync'
import { notify } from './state'
import { IconWarn } from './Icons'

/** A folder that has been picked but not yet connected, with its preview. */
interface Pending {
  handle: FileSystemDirectoryHandle
  preview: FolderPreview
}

export function FolderCard() {
  const s = settings.value
  const st = folderStatus.value
  const [pending, setPending] = useState<Pending | undefined>()
  const [busy, setBusy] = useState(false)

  if (!folderModeSupported()) {
    return (
      <div class="callout">
        <strong>Connected Folder needs the File System Access API,</strong> which this browser does
        not have. It is available in Chromium browsers on the desktop — Chrome, Edge, Brave, Arc,
        Vivaldi — and not yet in Firefox, Safari, or any browser on a phone. Everything else works
        exactly as it does: notes are saved on this device and reach your others through the backend
        below.
      </div>
    )
  }

  const pick = async () => {
    setBusy(true)
    try {
      const handle = await pickFolder()
      if (!handle) return // the picker was dismissed; not an error
      setPending({ handle, preview: await previewFolder(handle) })
    } catch (e) {
      notify((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const connect = async () => {
    if (!pending) return
    setBusy(true)
    try {
      await connectFolder(pending.handle)
      updateFolder({ enabled: true, name: pending.handle.name })
      setPending(undefined)
      notify(`Connected to “${pending.handle.name}”. Your notes are files in that folder now.`)
    } catch (e) {
      notify((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async () => {
    if (
      !confirm(
        `Stop using “${folderName.value}”?\n\nNothing in the folder is deleted or moved — every file stays exactly where it is, and every note stays in Slate. They simply stop being kept in step.`,
      )
    )
      return
    await disconnectFolder()
    updateFolder({ enabled: false, name: '' })
    notify('Folder disconnected. Nothing in it was changed.')
  }

  const reconnect = async () => {
    setBusy(true)
    try {
      if (await reconnectFolder()) notify(`Reconnected to “${folderName.value}”.`)
      else notify('Permission was not granted, so the folder is still disconnected.', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <label class="field">
        <span>Connected folder</span>
        {folderConnected.value ? (
          <div class="folder-row">
            <span class="status-dot" data-phase={st.phase} />
            <strong>{folderName.value}</strong>
            <span class="folder-detail">{st.detail}</span>
          </div>
        ) : folderNeedsPermission.value ? (
          <div class="folder-row">
            <span class="status-dot" data-phase="offline" />
            <strong>{folderName.value}</strong>
            <span class="folder-detail">needs permission again</span>
          </div>
        ) : (
          <small>
            Keep the vault as ordinary Markdown files in a folder you choose, so Obsidian, git, your
            editor and your backups can work on the same notes Slate does. This is in addition to
            the backend below, not instead of it — a folder is on this machine, and a backend is
            what reaches your phone.
          </small>
        )}
      </label>

      {pending && (
        <div class="callout">
          <strong>“{pending.handle.name}” — what connecting would do:</strong>
          <ul class="folder-preview">
            <li>
              <b>{pending.preview.incoming}</b>{' '}
              {pending.preview.incoming === 1 ? 'file' : 'files'} in the folder will be added to
              this vault.
            </li>
            <li>
              <b>{pending.preview.outgoing}</b>{' '}
              {pending.preview.outgoing === 1 ? 'note' : 'notes'} from this vault will be written
              into the folder.
            </li>
            <li>
              <b>{pending.preview.shared}</b> {pending.preview.shared === 1 ? 'file is' : 'files are'}{' '}
              on both sides. Where they match, nothing happens; where they differ, both versions are
              kept and the second is named as a conflict copy.
            </li>
          </ul>
          Nothing in the folder is deleted, and nothing leaves this vault.
          <div class="folder-actions">
            <button class="btn btn-primary" disabled={busy} onClick={connect}>
              {busy ? 'Connecting…' : 'Connect this folder'}
            </button>
            <button class="btn" onClick={() => setPending(undefined)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {!pending && (
        <div class="folder-actions">
          {folderNeedsPermission.value ? (
            <>
              <button class="btn btn-primary" disabled={busy} onClick={reconnect}>
                Reconnect
              </button>
              <button class="btn btn-danger" onClick={disconnect}>
                Forget this folder
              </button>
            </>
          ) : folderConnected.value ? (
            <>
              <button
                class="btn"
                disabled={st.phase === 'listing' || st.phase === 'pulling'}
                onClick={() => void folderSync()}
              >
                Check the folder now
              </button>
              <button class="btn btn-danger" onClick={disconnect}>
                Disconnect
              </button>
            </>
          ) : (
            <button class="btn btn-primary" disabled={busy} onClick={pick}>
              {busy ? 'Reading the folder…' : 'Choose a folder…'}
            </button>
          )}
          {folderConnected.value && st.pendingCount > 0 && (
            <span style={{ fontSize: 12, color: 'var(--accent)' }}>
              {st.pendingCount} to write
            </span>
          )}
        </div>
      )}

      {folderConnected.value && (
        <label class="field">
          <span>Check for outside changes every</span>
          <select
            value={String(s.folder.pollSec)}
            onChange={(e) =>
              updateFolder({ pollSec: Number((e.target as HTMLSelectElement).value) })
            }
          >
            <option value="2">2 seconds</option>
            <option value="5">5 seconds</option>
            <option value="15">15 seconds</option>
            <option value="60">1 minute</option>
          </select>
          <small>
            Only while this window is visible. Where the browser supports watching a folder
            directly, changes show up the moment they are saved and this is only a safety net.
          </small>
        </label>
      )}

      {folderConnected.value && (
        <div class="callout">
          Files and folders whose names begin with a dot are left alone entirely — Slate never
          reads, writes or deletes <code>.git</code>, <code>.obsidian</code>, <code>.trash</code> or
          anything else another tool keeps in there.
        </div>
      )}

      {st.lastError && folderConnected.value && (
        <div class="callout callout-danger">
          <IconWarn size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
          <strong>Last folder sync:</strong> {st.lastError}
        </div>
      )}
    </>
  )
}
