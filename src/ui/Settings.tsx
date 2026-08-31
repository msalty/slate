/** Settings: backend connection, sync behaviour, editor and image preferences. */

import { useEffect, useState } from 'preact/hooks'
import { settings, update, updateGdrive, updateWebdav } from '../core/settings'
import { buildAdapter, connectBackend } from '../app/backend'
import { currentAdapter, status, sync } from '../core/sync'
import { requestPersistence, storageEstimate } from '../core/db'
import { listAll } from '../core/vault'
import { formatBytes } from '../core/util'
import { notify, settingsOpen } from './state'
import { IconClose, IconWarn } from './Icons'

type Tab = 'sync' | 'editor' | 'files' | 'about'

export function Settings() {
  const [tab, setTab] = useState<Tab>('sync')
  const [testing, setTesting] = useState(false)
  const [usage, setUsage] = useState<{ usage: number; quota: number }>()
  const s = settings.value

  useEffect(() => {
    if (settingsOpen.value) void storageEstimate().then(setUsage)
  }, [settingsOpen.value, tab])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') settingsOpen.value = false
    }
    if (settingsOpen.value) addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [settingsOpen.value])

  if (!settingsOpen.value) return null

  const test = async () => {
    setTesting(true)
    try {
      const a = buildAdapter(settings.value)
      if (!a) {
        notify('Choose a backend first.', 'error')
        return
      }
      await a.connect()
      const list = await a.list()
      notify(`Connected. ${list.filter((e) => !e.isDir).length} files on the server.`)
      await connectBackend()
      void sync()
    } catch (e) {
      notify((e as Error).message, 'error')
    } finally {
      setTesting(false)
    }
  }

  return (
    <div class="scrim" onClick={() => (settingsOpen.value = false)}>
      <div class="dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div class="dialog-head">
          <h2>Settings</h2>
          <span style={{ flex: 1 }} />
          <button class="icon-btn" onClick={() => (settingsOpen.value = false)} aria-label="Close">
            <IconClose />
          </button>
        </div>

        <div class="tabs" role="tablist">
          {(['sync', 'editor', 'files', 'about'] as Tab[]).map((t) => (
            <button
              key={t}
              class="tab"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
            >
              {t === 'sync' ? 'Sync' : t === 'editor' ? 'Editor' : t === 'files' ? 'Images' : 'About'}
            </button>
          ))}
        </div>

        <div class="dialog-body">
          {tab === 'sync' && (
            <>
              <label class="field">
                <span>Backend</span>
                <select
                  value={s.backend}
                  onChange={(e) => update({ backend: (e.target as HTMLSelectElement).value as never })}
                >
                  <option value="none">Local only — no sync</option>
                  <option value="webdav">WebDAV (Nextcloud, Synology, rclone, Apache…)</option>
                  <option value="gdrive">Google Drive</option>
                </select>
                <small>
                  Notes are always saved on this device first. The backend is how they reach your
                  other devices.
                </small>
              </label>

              {s.backend === 'webdav' && (
                <>
                  <label class="field">
                    <span>Server URL</span>
                    <input
                      type="url"
                      placeholder="https://cloud.example.com/remote.php/dav/files/mike"
                      value={s.webdav.url}
                      onInput={(e) => updateWebdav({ url: (e.target as HTMLInputElement).value })}
                    />
                  </label>
                  <div class="field-row">
                    <label class="field">
                      <span>Username</span>
                      <input
                        type="text"
                        autocomplete="username"
                        value={s.webdav.username}
                        onInput={(e) =>
                          updateWebdav({ username: (e.target as HTMLInputElement).value })
                        }
                      />
                    </label>
                    <label class="field">
                      <span>Password or app token</span>
                      <input
                        type="password"
                        autocomplete="current-password"
                        value={s.webdav.password}
                        onInput={(e) =>
                          updateWebdav({ password: (e.target as HTMLInputElement).value })
                        }
                      />
                    </label>
                  </div>
                  <label class="field">
                    <span>Vault folder on the server</span>
                    <input
                      type="text"
                      placeholder="Notes"
                      value={s.webdav.root}
                      onInput={(e) => updateWebdav({ root: (e.target as HTMLInputElement).value })}
                    />
                    <small>Leave blank to use the root of the WebDAV share.</small>
                  </label>
                  <div class="callout">
                    <strong>If the connection fails,</strong> it is almost always CORS. Your server
                    must allow this origin (<code>{location.origin}</code>), allow the{' '}
                    <code>PROPFIND, PUT, DELETE, MKCOL</code> methods, allow the{' '}
                    <code>Authorization, Depth, If-Match, Content-Type</code> headers, and expose{' '}
                    <code>ETag</code>. The README has copy-paste config for Nextcloud, Apache and
                    Caddy.
                  </div>
                  <div class="callout">
                    Credentials are stored in this browser's local database and are sent only to the
                    server above. They are never written into the vault, so they never sync.
                  </div>
                </>
              )}

              {s.backend === 'gdrive' && (
                <>
                  <label class="field">
                    <span>OAuth client ID</span>
                    <input
                      type="text"
                      placeholder="1234567890-abcdef.apps.googleusercontent.com"
                      value={s.gdrive.clientId}
                      onInput={(e) =>
                        updateGdrive({ clientId: (e.target as HTMLInputElement).value })
                      }
                    />
                    <small>
                      Create one free at console.cloud.google.com → APIs &amp; Services →
                      Credentials → OAuth client ID → Web application, with{' '}
                      <code>{location.origin}</code> as an authorized JavaScript origin. Full steps
                      are in the README.
                    </small>
                  </label>
                  <label class="field">
                    <span>Drive folder name</span>
                    <input
                      type="text"
                      value={s.gdrive.folderName}
                      onInput={(e) =>
                        updateGdrive({
                          folderName: (e.target as HTMLInputElement).value,
                          folderId: '',
                        })
                      }
                    />
                  </label>
                  <div class="callout">
                    This uses the <code>drive.file</code> scope, so the app can only see files it
                    created itself — not the rest of your Drive.
                  </div>
                  <div class="callout callout-danger">
                    <IconWarn size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
                    Drive has no conditional-write support, so a same-second edit on two devices has
                    a small race window. Drive's own file version history is the backstop. WebDAV
                    does not have this caveat.
                  </div>
                </>
              )}

              {s.backend !== 'none' && (
                <div style={{ marginTop: 18, display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button class="btn btn-primary" disabled={testing} onClick={test}>
                    {testing ? 'Connecting…' : 'Connect and test'}
                  </button>
                  <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                    {currentAdapter()?.describe() ?? 'Not connected'}
                  </span>
                </div>
              )}

              <label class="check">
                <input
                  type="checkbox"
                  checked={s.autoSync}
                  onChange={(e) => update({ autoSync: (e.target as HTMLInputElement).checked })}
                />
                <span>
                  Sync automatically
                  <small>
                    Syncs on a timer, when the app becomes visible, and when the network comes back.
                    Turn this off to sync only when you press ⌘S.
                  </small>
                </span>
              </label>

              {s.autoSync && (
                <label class="field">
                  <span>Sync every</span>
                  <select
                    value={String(s.syncIntervalSec)}
                    onChange={(e) =>
                      update({ syncIntervalSec: Number((e.target as HTMLSelectElement).value) })
                    }
                  >
                    <option value="30">30 seconds</option>
                    <option value="60">1 minute</option>
                    <option value="300">5 minutes</option>
                    <option value="900">15 minutes</option>
                  </select>
                </label>
              )}

              {status.value.lastError && (
                <div class="callout callout-danger">
                  <strong>Last sync error:</strong> {status.value.lastError}
                </div>
              )}
            </>
          )}

          {tab === 'editor' && (
            <>
              <label class="field">
                <span>Default mode</span>
                <select
                  value={s.editorMode}
                  onChange={(e) =>
                    update({ editorMode: (e.target as HTMLSelectElement).value as never })
                  }
                >
                  <option value="live">Live preview — formatted as you type</option>
                  <option value="source">Markdown source</option>
                </select>
              </label>
              <label class="field">
                <span>Theme</span>
                <select
                  value={s.theme}
                  onChange={(e) => update({ theme: (e.target as HTMLSelectElement).value as never })}
                >
                  <option value="system">Match system</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </label>
              <label class="field">
                <span>Text size — {s.fontSize}px</span>
                <input
                  type="range"
                  min="12"
                  max="22"
                  step="1"
                  value={String(s.fontSize)}
                  style={{ width: '100%', accentColor: 'var(--accent)' }}
                  onInput={(e) => update({ fontSize: Number((e.target as HTMLInputElement).value) })}
                />
              </label>
              <label class="check">
                <input
                  type="checkbox"
                  checked={s.showRightRail}
                  onChange={(e) =>
                    update({ showRightRail: (e.target as HTMLInputElement).checked })
                  }
                />
                <span>
                  Show the calendar and tasks column
                  <small>⌘⇧R toggles it at any time.</small>
                </span>
              </label>
            </>
          )}

          {tab === 'files' && (
            <>
              <label class="field">
                <span>Attachment folder</span>
                <input
                  type="text"
                  value={s.attachmentFolder}
                  onInput={(e) =>
                    update({ attachmentFolder: (e.target as HTMLInputElement).value })
                  }
                />
                <small>
                  Pasted files land in <code>{s.attachmentFolder}/YYYY/MM/</code> inside the vault.
                </small>
              </label>
              <label class="field">
                <span>Re-encode pasted images as</span>
                <select
                  value={s.imageFormat}
                  onChange={(e) =>
                    update({ imageFormat: (e.target as HTMLSelectElement).value as never })
                  }
                >
                  <option value="image/webp">WebP — smallest, universally supported now</option>
                  <option value="image/jpeg">JPEG — widest compatibility, no transparency</option>
                  <option value="original">Keep original format</option>
                </select>
                <small>
                  A full-screen PNG screenshot is typically 4–8 MB. WebP at these settings usually
                  brings it under 300 KB with no visible difference.
                </small>
              </label>
              <div class="field-row">
                <label class="field">
                  <span>Max edge (px)</span>
                  <input
                    type="number"
                    min="0"
                    max="8000"
                    step="100"
                    value={String(s.imageMaxEdge)}
                    onInput={(e) =>
                      update({ imageMaxEdge: Number((e.target as HTMLInputElement).value) })
                    }
                  />
                  <small>0 keeps the original dimensions.</small>
                </label>
                <label class="field">
                  <span>Quality — {Math.round(s.imageQuality * 100)}%</span>
                  <input
                    type="range"
                    min="0.4"
                    max="1"
                    step="0.02"
                    value={String(s.imageQuality)}
                    style={{ width: '100%', accentColor: 'var(--accent)' }}
                    onInput={(e) =>
                      update({ imageQuality: Number((e.target as HTMLInputElement).value) })
                    }
                  />
                </label>
              </div>
              <div class="callout">
                Originals are kept whenever re-encoding would make the file bigger, and animated
                GIFs and SVGs are never touched.
              </div>
            </>
          )}

          {tab === 'about' && (
            <>
              <div class="field">
                <span>This device</span>
                <input
                  type="text"
                  value={s.deviceName}
                  onInput={(e) => update({ deviceName: (e.target as HTMLInputElement).value })}
                />
                <small>Used to label conflict copies so you can tell them apart.</small>
              </div>

              <div class="callout">
                <strong>Vault</strong>
                <br />
                {listAll().filter((f) => !f.deleted && f.kind === 'note').length} notes ·{' '}
                {listAll().filter((f) => !f.deleted && f.kind === 'attachment').length} files
                <br />
                {usage && (
                  <>
                    On-device storage: {formatBytes(usage.usage)}
                    {usage.quota ? ` of ${formatBytes(usage.quota)} available` : ''}
                  </>
                )}
              </div>

              <button
                class="btn"
                style={{ marginTop: 14 }}
                onClick={async () => {
                  const ok = await requestPersistence()
                  notify(
                    ok
                      ? 'This browser will keep your notes even under storage pressure.'
                      : 'The browser did not grant persistent storage. Install the app to improve the odds.',
                    ok ? 'info' : 'error',
                  )
                }}
              >
                Request persistent storage
              </button>

              <div class="callout" style={{ marginTop: 18 }}>
                <strong>Keyboard</strong>
                <br />
                ⌘K palette · ⌘N new note · ⌘S sync · ⌘F find in note · ⌘⇧M source mode · ⌘⇧R calendar
                · ⌘\ sidebar · ⌘B bold · ⌘I italic · ⌘K on a selection makes a wikilink
              </div>
            </>
          )}
        </div>

        <div class="dialog-foot">
          <button class="btn btn-primary" onClick={() => (settingsOpen.value = false)}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
