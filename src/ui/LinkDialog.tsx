/**
 * Add or edit an external link.
 *
 * Two fields, because a markdown link is two things — the words you read and
 * the address you go to — and on a phone there is no other way to reach the
 * address: the URL is hidden behind the label the moment it renders.
 *
 * Clearing the URL is how you remove a link and keep the words, which is the
 * thing people actually want when they say "unlink".
 */

import { useEffect, useRef, useState } from 'preact/hooks'
import { signal } from '@preact/signals'
import { isUri } from '../editor/links'
import { IconClose } from './Icons'

interface Draft {
  text: string
  url: string
  /** True when the dialog opened on a link that already exists. */
  existing: boolean
  onSubmit: (text: string, url: string) => void
}

const draft = signal<Draft | null>(null)

export function openLinkDialog(d: Draft) {
  draft.value = d
}

export function LinkDialog() {
  const d = draft.value
  const [text, setText] = useState('')
  const [url, setUrl] = useState('')
  const urlRef = useRef<HTMLInputElement>(null)
  const textRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!d) return
    setText(d.text)
    setUrl(d.url)
    // Whichever half is missing is the one to type into.
    requestAnimationFrame(() => (d.text && !d.url ? urlRef : d.url ? textRef : urlRef).current?.focus())
  }, [d])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') draft.value = null
    }
    if (d) addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [d])

  if (!d) return null

  const trimmed = url.trim()
  const valid = !trimmed || isUri(trimmed)
  const close = () => (draft.value = null)
  const submit = () => {
    if (!valid) return
    d.onSubmit(text.trim() || trimmed, trimmed)
    close()
  }

  return (
    <div class="scrim" onClick={close}>
      <div
        class="dialog"
        style={{ width: 'min(460px, 100%)' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div class="dialog-head">
          <h2>{d.existing ? 'Edit link' : 'Add link'}</h2>
          <span style={{ flex: 1 }} />
          <button class="icon-btn" onClick={close} aria-label="Close">
            <IconClose />
          </button>
        </div>

        <div class="dialog-body">
          <label class="field">
            <span>Text</span>
            <input
              ref={textRef}
              type="text"
              placeholder="What the link says"
              value={text}
              onInput={(e) => setText((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </label>
          <label class="field">
            <span>Link to</span>
            <input
              ref={urlRef}
              type="text"
              inputMode="url"
              autocapitalize="off"
              autocorrect="off"
              spellcheck={false}
              placeholder="https://example.com"
              value={url}
              onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
            <small>
              {!valid
                ? 'That isn’t an address this can open.'
                : d.existing
                  ? 'Clear this to remove the link and keep the words.'
                  : 'Web addresses, mailto:, tel:, ssh: — anything your device can open.'}
            </small>
          </label>
        </div>

        <div class="dialog-foot">
          <span style={{ flex: 1 }} />
          <button class="btn" onClick={close}>
            Cancel
          </button>
          <button class="btn btn-primary" disabled={!valid} onClick={submit}>
            {d.existing && !trimmed ? 'Remove link' : 'Done'}
          </button>
        </div>
      </div>
    </div>
  )
}
