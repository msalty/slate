/**
 * What came back from the model, before any of it touches a note.
 *
 * The dialog is the feature's whole safety story, so it is deliberately not a
 * progress bar that then writes something. Three things make it safe: the text
 * arrives in a box you can **edit** — an OCR mistake is fixed here in a
 * keystroke rather than hunted down in the note afterwards — the note it will
 * be written to is **named on the button**, and closing the dialog writes
 * nothing at all.
 *
 * It also reports what left the device, in bytes and pixels. A feature that
 * sends your notes' contents somewhere should say so every time it does it,
 * rather than once in a settings panel nobody reopens.
 */

import { useEffect, useState } from 'preact/hooks'
import { signal } from '@preact/signals'
import { insertIntoNote, transcribeAttachment } from '../app/transcribe'
import { basename, formatBytes, titleFromPath } from '../core/util'
import { getRaw } from '../core/vault'
import { activePath, notify } from './state'
import { IconClose } from './Icons'

interface Target {
  /** The attachment being read. */
  path: string
  /** The note to offer to write into — the one that was open when it started. */
  note?: string
}

const target = signal<Target | undefined>(undefined)

export function openTranscribe(path: string) {
  target.value = { path, note: activePath.value }
}

export function TranscribeDialog() {
  const t = target.value
  const [text, setText] = useState('')
  const [sent, setSent] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [empty, setEmpty] = useState(false)

  useEffect(() => {
    if (!t) return
    let live = true
    setText('')
    setSent(undefined)
    setError(undefined)
    setEmpty(false)
    setBusy(true)
    void transcribeAttachment(t.path)
      .then((r) => {
        if (!live) return
        setText(r.text)
        setEmpty(r.empty)
        setSent(`${r.sent.width}×${r.sent.height}, ${formatBytes(r.sent.bytes)}`)
      })
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setBusy(false))
    // A dialog closed mid-request must not come back to life when it lands.
    return () => {
      live = false
    }
  }, [t?.path])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        target.value = undefined
      }
    }
    if (t) addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [t])

  if (!t) return null

  const close = () => (target.value = undefined)
  const note = t.note
  const noteExists = !!note && getRaw(note)?.text !== undefined

  const insert = async () => {
    if (!note) return
    try {
      await insertIntoNote(note, t.path, text)
      close()
      notify(`Transcription added to ${titleFromPath(note)}`)
    } catch (e) {
      notify((e as Error).message, 'error')
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      notify('Transcription copied')
    } catch {
      notify('This browser would not let the app write to the clipboard', 'error')
    }
  }

  return (
    <div class="scrim" onClick={close}>
      <div
        class="dialog"
        style={{ width: 'min(640px, 100%)' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Transcription"
      >
        <div class="dialog-head">
          <h2>Text from {basename(t.path)}</h2>
          <span style={{ flex: 1 }} />
          <button class="icon-btn" onClick={close} aria-label="Close">
            <IconClose />
          </button>
        </div>

        <div class="dialog-body">
          {busy && <p class="transcribe-status">Reading the image…</p>}

          {error && (
            <div class="callout callout-danger" style={{ whiteSpace: 'pre-wrap' }}>
              {error}
            </div>
          )}

          {!busy && !error && (
            <>
              {empty && !text && (
                <div class="callout">The model found no text in this image.</div>
              )}
              <label class="field">
                <span>Transcription — edit anything it got wrong before inserting</span>
                <textarea
                  class="transcribe-text"
                  value={text}
                  spellcheck={false}
                  onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
                />
              </label>
              {sent && (
                <small class="transcribe-sent">
                  Sent to your provider: one image, {sent}. Nothing else from the vault left this
                  device.
                </small>
              )}
            </>
          )}
        </div>

        <div class="dialog-foot">
          <span style={{ flex: 1 }} />
          <button class="btn" onClick={close}>
            Cancel
          </button>
          <button class="btn" disabled={!text.trim()} onClick={() => void copy()}>
            Copy
          </button>
          <button
            class="btn btn-primary"
            disabled={!text.trim() || !noteExists}
            title={noteExists ? undefined : 'No note was open to write into'}
            onClick={() => void insert()}
          >
            {noteExists ? `Insert into ${titleFromPath(note!)}` : 'Insert'}
          </button>
        </div>
      </div>
    </div>
  )
}
