/**
 * Insert a file the vault already has.
 *
 * The Insert menu used to offer two ways to upload from the machine you were
 * sitting at and no way at all to reach a file that was already in Slate — so
 * the only route to the image you attached last week was to find it in Files,
 * copy the path, and type the embed by hand. This is that route: a box you
 * type into and a list that narrows as you do.
 *
 * It is a palette rather than a grid of thumbnails because filenames are what
 * people remember and what they can type; the thumbnail sits on the row as
 * confirmation of the one they landed on, not as the way to find it.
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { attachmentUrl, attachments } from '../core/vault'
import { basename, formatBytes, mediaClass, relativeTime, searchTerms } from '../core/util'
import { Highlight } from './Highlight'
import { IconClose, IconSearch, IconUpload } from './Icons'
import { closeFilePicker, filePick, rankFiles } from './pickFile'

/**
 * How many rows are drawn at once. A vault with a thousand attachments would
 * otherwise mint a thousand object URLs to fill a list nobody scrolls to the
 * bottom of; past the cap the answer is to type, which is the point of the box.
 */
const MAX_ROWS = 200

export function FilePicker() {
  const req = filePick.value
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const all = attachments.value
  const terms = useMemo(() => searchTerms(q), [q])
  const matched = useMemo(() => rankFiles(all, q), [all, q])
  const hits = matched.length > MAX_ROWS ? matched.slice(0, MAX_ROWS) : matched

  useEffect(() => {
    if (!req) return
    setQ('')
    setSel(0)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [req])

  // Arrowing past the bottom of the box should follow the selection down.
  useEffect(() => {
    listRef.current?.querySelector('[data-sel="1"]')?.scrollIntoView({ block: 'nearest' })
  }, [sel, hits.length])

  // Escape closes it from wherever the focus has landed — a row that was
  // clicked, say — and not only from the box it opened in.
  useEffect(() => {
    if (!req) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      closeFilePicker()
      req.onCancel?.()
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [req])

  if (!req) return null

  /** Closed with nothing chosen. */
  const dismiss = () => {
    closeFilePicker()
    req.onCancel?.()
  }

  const choose = (i: number) => {
    const f = hits[i]
    if (!f) return
    closeFilePicker()
    req.onPick(f.path)
  }

  const upload = () => {
    closeFilePicker()
    req.onUpload()
  }

  return (
    <div class="scrim" onClick={dismiss}>
      <div
        class="palette file-picker"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Insert a file"
      >
        <div class="file-picker-search">
          <IconSearch size={15} />
          <input
            ref={inputRef}
            value={q}
            placeholder="Search files in Slate…"
            aria-label="Search files in Slate"
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
          {!all.length ? (
            <div class="empty" style={{ padding: '28px 20px' }}>
              No files in Slate yet. Anything you paste, drop or upload lands here.
            </div>
          ) : !hits.length ? (
            <div class="empty" style={{ padding: '28px 20px' }}>
              No file matches “{q.trim()}”.
            </div>
          ) : (
            hits.map((f, i) => {
              const kind = mediaClass(f.path)
              const url = kind === 'image' ? attachmentUrl(f.path) : undefined
              const name = basename(f.path)
              return (
                <button
                  key={f.path}
                  class="palette-row file-pick-row"
                  data-sel={i === sel ? '1' : '0'}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => choose(i)}
                >
                  {url ? (
                    <img class="file-pick-thumb" src={url} alt="" loading="lazy" />
                  ) : (
                    <span class="file-pick-thumb file-pick-kind">{kind.toUpperCase().slice(0, 3)}</span>
                  )}
                  <span class="file-pick-text">
                    <span class="file-pick-name">
                      <Highlight text={name} terms={terms} />
                    </span>
                    <span class="file-pick-sub">
                      {kind} · {formatBytes(f.size)} · {relativeTime(f.mtime)} ·{' '}
                      <Highlight text={f.path} terms={terms} />
                    </span>
                  </span>
                </button>
              )
            })
          )}
          {matched.length > hits.length && (
            <div class="empty" style={{ padding: '12px 20px' }}>
              …and {matched.length - hits.length} more. Type to narrow it down.
            </div>
          )}
        </div>

        <div class="file-picker-foot">
          <span class="file-picker-count">
            {q.trim()
              ? `${matched.length} of ${all.length}`
              : `${all.length} file${all.length === 1 ? '' : 's'}`}
          </span>
          <button class="btn" onClick={upload}>
            <IconUpload size={14} />
            Upload instead…
          </button>
        </div>
      </div>
    </div>
  )
}
