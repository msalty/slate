/** Settings: backend connection, sync behaviour, editor and image preferences. */

import { useEffect, useState } from 'preact/hooks'
import { settings, update, updateGdrive, updateWebdav } from '../core/settings'
import { buildAdapter, connectBackend } from '../app/backend'
import { currentAdapter, status, sync } from '../core/sync'
import { requestPersistence, storageEstimate } from '../core/db'
import { listAll } from '../core/vault'
import { formatBytes } from '../core/util'
import { notify, settingsOpen } from './state'
import { apply, BUILD_ID, check, reinstall, updateReady } from '../app/update'
import { IconClose, IconWarn } from './Icons'
import { createFolder } from '../core/folders'
import { createNote } from '../core/vault'
import {
  assignedTemplate,
  hasTemplates,
  setFolderTemplate,
  STARTER_TEMPLATE,
  TEMPLATES_FOLDER,
  templateNotes,
} from '../core/templates'
import { openNote } from './state'

type Tab = 'sync' | 'editor' | 'files' | 'about'

/**
 * Make `Templates/` and put one template in it, then open it.
 *
 * The only path in the app that creates this folder, and it runs from a button
 * nobody presses by accident. Everything else about templates asks whether the
 * folder is there and does nothing when it is not.
 */
async function startTemplates() {
  await createFolder('', TEMPLATES_FOLDER)
  const path = await createNote(TEMPLATES_FOLDER, 'Example', STARTER_TEMPLATE)
  settingsOpen.value = false
  openNote(path)
  notify('Templates/ created. Edit this note, then pick it from a folder’s menu.')
}

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
                  <option value="rich">Rich text — formatting bar, no syntax</option>
                  <option value="live">Live preview — syntax on the line you're editing</option>
                  <option value="source">Markdown source</option>
                </select>
              </label>
              <label class="field">
                <span>Body width</span>
                <select
                  value={s.editorWidth}
                  onChange={(e) =>
                    update({ editorWidth: (e.target as HTMLSelectElement).value as never })
                  }
                >
                  <option value="full">Full width — the note fills the pane</option>
                  <option value="measure">Reading column — 760px, centred</option>
                </select>
                <small>
                  Full width starts the note at the left edge, so a wider window is wider text.
                </small>
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
              <div class="field">
                <span>Templates</span>
                {hasTemplates.value ? (
                  <>
                    <small>
                      {templateNotes.value.length} template
                      {templateNotes.value.length === 1 ? '' : 's'} in <code>Templates/</code>.
                      Each one is an ordinary note — open it and edit it like any other.
                      Right-click a folder in the sidebar and choose <b>Template…</b> to say
                      which one its new notes start from.
                    </small>
                    {/*
                      * The vault root is the one folder with no row in the
                      * sidebar and so no menu to right-click, and it is where
                      * ⌘N puts a note when no folder is selected — and where a
                      * note created from a broken [[link]] always goes. That
                      * last one is the case `{{title}}` exists for, so without
                      * this control the field had nowhere it could be used.
                      */}
                    <label class="field">
                      <span>Notes outside any folder</span>
                      <select
                        value={assignedTemplate('') ?? ''}
                        onChange={(e) =>
                          void setFolderTemplate('', (e.target as HTMLSelectElement).value || undefined)
                        }
                      >
                        <option value="">No template</option>
                        {templateNotes.value.map((t) => (
                          <option key={t.path} value={t.path}>
                            {t.title}
                          </option>
                        ))}
                      </select>
                      <small>
                        Used by ⌘N with no folder selected, and by a note created from a broken{' '}
                        <code>[[link]]</code> — which is named for the link, so this is where{' '}
                        <code>{'{{title}}'}</code> earns its keep. It does not reach notes inside
                        folders; those follow their own folder, or no template at all.
                      </small>
                    </label>
                    <small>
                      Fields a template can fill in: <code>{'{{title}}'}</code>{' '}
                      <code>{'{{date}}'}</code> <code>{'{{time}}'}</code>{' '}
                      <code>{'{{year}}'}</code> <code>{'{{month}}'}</code>{' '}
                      <code>{'{{day}}'}</code> <code>{'{{weekday}}'}</code>, and{' '}
                      <code>{'{{cursor}}'}</code> for where writing should start. Dates take a
                      pattern — <code>{'{{date:DDDD, D MMMM YYYY}}'}</code> — built from{' '}
                      <code>YYYY MM DD HH mm ss</code>, with <code>MMM</code>/<code>MMMM</code>{' '}
                      for the month by name and <code>DDD</code>/<code>DDDD</code> for the day.
                    </small>
                    <small>
                      <code>{'{{title}}'}</code> is the note's name when it is made — the date
                      for a daily note, the link text for one created from a broken{' '}
                      <code>[[link]]</code>, and the literal word "Untitled" for one made with{' '}
                      <b>New note here</b>. For folders where you name notes yourself, leave the
                      heading empty and put <code>{'{{cursor}}'}</code> in it instead.
                    </small>
                  </>
                ) : (
                  <>
                    <small>
                      A folder can start its new notes from boilerplate: a daily note that
                      already has its date, a meeting note with the fields you always fill in.
                      Templates are ordinary notes in a <code>Templates/</code> folder, so there
                      is no template format and nothing new to learn — and nothing at all
                      happens until you make that folder.
                    </small>
                    <button
                      class="btn"
                      style={{ alignSelf: 'flex-start' }}
                      onClick={() => void startTemplates()}
                    >
                      Create the Templates folder
                    </button>
                  </>
                )}
              </div>
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
                <small>
                  Labels conflict copies, and names this device in the version history on
                  your other ones.
                </small>
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

              <UpdatePanel />

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

/* ---------------------------------------------------------------- updating */

/**
 * What the browser is actually giving us to lay out in.
 *
 * An installed iOS PWA cannot be inspected — no dev tools, no URL bar — so when
 * the shell sits wrong on a device there is otherwise nothing to go on but a
 * photograph. These are the three numbers that decide it: the viewport, the
 * safe-area insets, and whether the shell's box ends flush with the bottom of
 * the screen. A non-zero overhang there means the insets are being counted
 * twice, which is exactly what a bar floating too high looks like.
 */
function displayInfo() {
  // env() values are not readable directly; resolve them through the used
  // padding of a throwaway element.
  const el = document.createElement('div')
  el.style.cssText =
    'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;' +
    'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) ' +
    'env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)'
  document.body.append(el)
  const cs = getComputedStyle(el)
  const inset = {
    top: Math.round(parseFloat(cs.paddingTop) || 0),
    right: Math.round(parseFloat(cs.paddingRight) || 0),
    bottom: Math.round(parseFloat(cs.paddingBottom) || 0),
    left: Math.round(parseFloat(cs.paddingLeft) || 0),
  }
  el.remove()

  const app = document.getElementById('app')?.getBoundingClientRect()
  const installed = matchMedia('(display-mode: standalone)').matches
  /*
   * How much shorter the web view is than the screen. In a browser tab this is
   * just the chrome and means nothing; installed, it is the band of dead space
   * below the app that no amount of CSS can paint into, because the page was
   * never handed those pixels. That is a web-view sizing problem — on iOS,
   * apple-mobile-web-app-status-bar-style.
   */
  const short = installed ? Math.round(screen.height - innerHeight) : 0
  return {
    w: Math.round(innerWidth),
    h: Math.round(innerHeight),
    screenH: Math.round(screen.height),
    inset,
    overhang: app ? Math.round(app.bottom - innerHeight) : 0,
    short: short > 1 ? short : 0,
    installed,
  }
}

/** `20260831T201000Z` → `2026-08-31 20:10 UTC`. */
function formatBuild(id: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/.exec(id)
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]} UTC` : id
}

/**
 * Check for, and install, a new build.
 *
 * This exists because the honest answer to "just reload" is that it does not
 * work: a newly installed service worker waits for the old one to lose control
 * of every open page, and reloading never releases it. Short of closing all
 * tabs or clearing site data, there is otherwise no way out of a stale build
 * from inside the app — which is exactly the corner this button unsticks.
 */
function UpdatePanel() {
  const [busy, setBusy] = useState<'check' | 'reinstall' | undefined>(undefined)
  const [said, setSaid] = useState<string>()
  const waiting = updateReady.value
  const d = displayInfo()

  const upgrade = async () => {
    setBusy('check')
    setSaid(undefined)
    try {
      // Something already waiting means the check is done — go straight to it.
      if (!waiting) {
        const r = await check()
        if (r === 'unsupported') {
          setSaid('This browser is not running Slate from a service worker, so there is nothing to update — a normal reload always gets the latest build.')
          return
        }
        if (r === 'current') {
          setSaid('Slate is already on the newest build.')
          return
        }
      }
      setSaid('New build installed — restarting…')
      await apply()
    } catch (e) {
      setSaid((e as Error).message || 'The update check failed.')
    } finally {
      setBusy(undefined)
    }
  }

  const force = async () => {
    setBusy('reinstall')
    setSaid(undefined)
    try {
      await reinstall()
    } catch (e) {
      setSaid((e as Error).message)
      setBusy(undefined)
    }
  }

  return (
    <div class="callout" style={{ marginTop: 18 }}>
      <strong>Version</strong>
      <br />
      Build {formatBuild(BUILD_ID)}
      <br />
      <span style={{ color: 'var(--text-faint)' }}>
        {d.w}×{d.h} of {d.screenH} · {d.installed ? 'installed' : 'browser tab'} · safe area{' '}
        {d.inset.top}/{d.inset.right}/{d.inset.bottom}/{d.inset.left}
        {d.short > 0 && (
          <span style={{ color: 'var(--danger)' }}> · view is {d.short}px short of the screen</span>
        )}
        {d.overhang !== 0 && (
          <span style={{ color: 'var(--danger)' }}> · shell overhangs by {d.overhang}px</span>
        )}
      </span>
      {waiting && (
        <>
          <br />
          <span style={{ color: 'var(--accent)' }}>A newer build is installed and ready.</span>
        </>
      )}
      {said && (
        <>
          <br />
          {said}
        </>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        <button class="btn btn-primary" onClick={() => void upgrade()} disabled={!!busy}>
          {busy === 'check' ? 'Updating…' : waiting ? 'Update and restart' : 'Check for updates'}
        </button>
        <button class="btn" onClick={() => void force()} disabled={!!busy}>
          {busy === 'reinstall' ? 'Reinstalling…' : 'Reinstall'}
        </button>
      </div>
      <small style={{ display: 'block', marginTop: 8, color: 'var(--text-faint)' }}>
        Reinstall throws away the cached copy of the app and downloads it again — the same effect as
        clearing the browser cache, without touching anything else the browser holds for this site.
        Your notes live in a separate database and are not affected. Needs a connection.{' '}
        <strong>On an installed app this does not refresh the icon, name, colours or how it fills
        the screen</strong> — those come from the manifest, which Android only re-reads when the app
        is removed from the launcher and installed again.
      </small>
    </div>
  )
}
