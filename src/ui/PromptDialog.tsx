/**
 * A one-field dialog: a name to type, a button to confirm.
 *
 * `prompt()` would do the same job in a line of code, but not on a phone —
 * where it is a system alert that steals the whole screen — and not with a
 * hint under the field explaining what the change will do. Renaming a file
 * repoints every note that used it, and that is worth saying out loud.
 */

import { useEffect, useRef, useState } from 'preact/hooks'
import { signal } from '@preact/signals'
import { IconClose } from './Icons'

interface Draft {
  title: string
  label: string
  value: string
  hint?: string
  confirm?: string
  placeholder?: string
  onSubmit: (value: string) => void | Promise<void>
}

const draft = signal<Draft | null>(null)

export function openPrompt(d: Draft) {
  draft.value = d
}

export function PromptDialog() {
  const d = draft.value
  const [value, setValue] = useState('')
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!d) return
    setValue(d.value)
    requestAnimationFrame(() => {
      const el = ref.current
      if (!el) return
      el.focus()
      // Select the stem, not the extension: renaming "IMG_0421.png" is almost
      // never about the ".png".
      const dot = d.value.lastIndexOf('.')
      el.setSelectionRange(0, dot > 0 ? dot : d.value.length)
    })
  }, [d])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') draft.value = null
    }
    if (d) addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [d])

  if (!d) return null

  const close = () => (draft.value = null)
  const submit = () => {
    const next = value.trim()
    if (!next) return
    close()
    void d.onSubmit(next)
  }

  return (
    <div class="scrim" onClick={close}>
      <div
        class="dialog"
        style={{ width: 'min(420px, 100%)' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div class="dialog-head">
          <h2>{d.title}</h2>
          <span style={{ flex: 1 }} />
          <button class="icon-btn" onClick={close} aria-label="Close">
            <IconClose />
          </button>
        </div>
        <div class="dialog-body">
          <label class="field">
            <span>{d.label}</span>
            <input
              ref={ref}
              type="text"
              value={value}
              placeholder={d.placeholder}
              autocapitalize="off"
              autocorrect="off"
              spellcheck={false}
              onInput={(e) => setValue((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
            {d.hint && <small>{d.hint}</small>}
          </label>
        </div>
        <div class="dialog-foot">
          <span style={{ flex: 1 }} />
          <button class="btn" onClick={close}>
            Cancel
          </button>
          <button class="btn btn-primary" disabled={!value.trim()} onClick={submit}>
            {d.confirm ?? 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
