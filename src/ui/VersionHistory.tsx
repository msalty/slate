/**
 * Local version history.
 *
 * Every save, every sync pull and every delete writes a snapshot to IndexedDB.
 * It is device-local and not synced — it is the safety net for "I pasted over
 * three paragraphs an hour ago", which is the failure mode a sync engine cannot
 * protect you from because it faithfully replicated the mistake.
 */

import { useEffect, useState } from 'preact/hooks'
import { versionsFor, type Version } from '../core/db'
import { getRaw, saveNote } from '../core/vault'
import { activePath, historyOpen, notify } from './state'
import { formatBytes } from '../core/util'
import { IconClose } from './Icons'

const REASON: Record<Version['reason'], string> = {
  edit: 'Edited',
  'sync-pull': 'Pulled from server',
  'conflict-merge': 'Before merge',
  delete: 'Before delete',
  import: 'Imported',
}

export function VersionHistory() {
  const [list, setList] = useState<Version[]>([])
  const [sel, setSel] = useState<Version | undefined>()
  const path = activePath.value

  useEffect(() => {
    if (!historyOpen.value || !path) return
    void versionsFor(path).then((v) => {
      setList(v)
      setSel(v[0])
    })
  }, [historyOpen.value, path])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') historyOpen.value = false
    }
    if (historyOpen.value) addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [historyOpen.value])

  if (!historyOpen.value || !path) return null
  const current = getRaw(path)

  return (
    <div class="scrim" onClick={() => (historyOpen.value = false)}>
      <div
        class="dialog"
        style={{ width: 'min(900px, 100%)' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div class="dialog-head">
          <h2>Version history</h2>
          <span style={{ flex: 1 }} />
          <button class="icon-btn" onClick={() => (historyOpen.value = false)} aria-label="Close">
            <IconClose />
          </button>
        </div>

        <div style={{ display: 'flex', minHeight: 0, flex: 1 }}>
          <div
            style={{
              width: 240,
              borderRight: '1px solid var(--border)',
              overflowY: 'auto',
              padding: 8,
              flex: '0 0 auto',
            }}
          >
            {list.length === 0 && (
              <div class="empty" style={{ padding: 20 }}>
                No earlier versions yet.
              </div>
            )}
            {list.map((v) => (
              <button
                key={v.id}
                class="backlink-row"
                style={{
                  background: sel?.id === v.id ? 'var(--row-active)' : undefined,
                }}
                onClick={() => setSel(v)}
              >
                {new Date(v.at).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
                <small>
                  {REASON[v.reason]} · {formatBytes(v.text.length)}
                </small>
              </button>
            ))}
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: 16, minWidth: 0 }}>
            <pre
              style={{
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: 'var(--font-mono)',
                fontSize: 12.5,
                lineHeight: 1.6,
              }}
            >
              {sel?.text ?? 'Select a version.'}
            </pre>
          </div>
        </div>

        <div class="dialog-foot">
          <span style={{ flex: 1, fontSize: 12, color: 'var(--text-faint)', alignSelf: 'center' }}>
            Restoring keeps the current text as a new version, so this is never destructive.
          </span>
          <button class="btn" onClick={() => (historyOpen.value = false)}>
            Cancel
          </button>
          <button
            class="btn btn-primary"
            disabled={!sel || sel.text === current?.text}
            onClick={async () => {
              if (!sel) return
              await saveNote(path, sel.text)
              historyOpen.value = false
              notify('Restored earlier version')
            }}
          >
            Restore this version
          </button>
        </div>
      </div>
    </div>
  )
}
