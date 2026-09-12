/**
 * Choose a note by name.
 *
 * The same palette as the file picker, pointed at notes — and it exists so that
 * nowhere in the app asks anybody to *type* a note's name. A field you type a
 * title into is a field you can typo, and a typo'd note reference is a silent
 * nothing: it looks right, it saves fine, and the thing it names never happens.
 * Picking from the list makes that failure unreachable.
 *
 * Templates are excluded, because a template is boilerplate for a note that
 * does not exist yet and is never the note you meant.
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { contentNotes } from '../core/vault'
import { relativeTime, searchTerms } from '../core/util'
import { Highlight } from './Highlight'
import { IconClose, IconSearch } from './Icons'
import { closeNotePicker, notePick } from './pickNote'
import { rankFiles } from './pickFile'

/** As in the file picker: past this, typing is the way through, not scrolling. */
const MAX_ROWS = 200

export function NotePicker() {
  const req = notePick.value
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const all = useMemo(() => {
    const skip = new Set(req?.exclude ?? [])
    const rows = contentNotes.value
    return skip.size ? rows.filter((n) => !skip.has(n.path)) : rows
  }, [contentNotes.value, req])
  const terms = useMemo(() => searchTerms(q), [q])
  const matched = useMemo(() => rankFiles(all, q), [all, q])
  const hits = matched.length > MAX_ROWS ? matched.slice(0, MAX_ROWS) : matched

  useEffect(() => {
    if (!req) return
    setQ('')
    setSel(0)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [req])

  useEffect(() => {
    listRef.current?.querySelector('[data-sel="1"]')?.scrollIntoView({ block: 'nearest' })
  }, [sel, hits.length])

  // Captured, because this opens over the editor and over other dialogs, and
  // Escape here should close this rather than whatever is behind it.
  useEffect(() => {
    if (!req) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      closeNotePicker()
      req.onCancel?.()
    }
    addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [req])

  if (!req) return null

  const dismiss = () => {
    closeNotePicker()
    req.onCancel?.()
  }

  const choose = (i: number) => {
    const n = hits[i]
    if (!n) return
    closeNotePicker()
    req.onPick(n)
  }

  return (
    <div class="scrim" onClick={dismiss}>
      <div
        class="palette file-picker"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={req.title}
        data-id="note-picker"
      >
        <div class="file-picker-search">
          <IconSearch size={15} />
          <input
            ref={inputRef}
            value={q}
            placeholder={req.placeholder ?? 'Search your notes…'}
            aria-label={req.title}
            autocapitalize="off"
            autocorrect="off"
            spellcheck={false}
            onInput={(e) => {
              setQ((e.target as HTMLInputElement).value)
              setSel(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSel((s) => Math.min(hits.length - 1, s + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSel((s) => Math.max(0, s - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                choose(sel)
              }
            }}
          />
          <button class="icon-btn" onClick={dismiss} aria-label="Close">
            <IconClose size={16} />
          </button>
        </div>

        <div class="palette-list" ref={listRef}>
          {!hits.length ? (
            <div class="empty" style={{ padding: '28px 20px' }}>
              {q.trim() ? `No note matches “${q.trim()}”.` : 'No notes to choose from.'}
            </div>
          ) : (
            hits.map((n, i) => (
              <button
                key={n.path}
                class="palette-row"
                data-sel={i === sel ? '1' : '0'}
                onMouseEnter={() => setSel(i)}
                onClick={() => choose(i)}
              >
                <span class="file-pick-text">
                  <span class="file-pick-name">
                    <Highlight text={n.title} terms={terms} />
                  </span>
                  <span class="file-pick-sub">
                    {n.folder ? <Highlight text={n.folder} terms={terms} /> : 'Vault root'} ·{' '}
                    {relativeTime(n.mtime)}
                  </span>
                </span>
              </button>
            ))
          )}
          {matched.length > hits.length && (
            <div class="empty" style={{ padding: '12px 20px' }}>
              …and {matched.length - hits.length} more. Type to narrow it down.
            </div>
          )}
        </div>

        <div class="file-picker-foot">
          <span class="file-picker-count">
            {q.trim() ? `${matched.length} of ${all.length}` : `${all.length} note${all.length === 1 ? '' : 's'}`}
          </span>
        </div>
      </div>
    </div>
  )
}
