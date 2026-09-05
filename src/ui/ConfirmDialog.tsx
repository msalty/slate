/**
 * A yes/no dialog: a question, a sentence of context, two buttons.
 *
 * The destructive actions in the app use the browser's own `confirm()` and are
 * right to — an alert nobody can dismiss by accident is exactly what belongs in
 * front of "permanently delete". This is for the other kind of question, the
 * offer made in the middle of something: it has to look like part of the app,
 * it has to be dismissible without the dismissal feeling like an escape, and on
 * a phone it must not be a system alert box thrown over the whole screen. Same
 * shell as PromptDialog, which exists for the same reason one field further on.
 *
 * The confirming button takes focus, so Return answers the question the way
 * somebody who asked for the thing in the first place means to answer it, and
 * Escape is always no.
 */

import { useEffect, useRef } from 'preact/hooks'
import { signal } from '@preact/signals'
import { IconClose } from './Icons'

interface Ask {
  title: string
  /** One or two sentences: what will happen, and where. */
  body: preact.ComponentChildren
  confirm?: string
  cancel?: string
  onConfirm: () => void | Promise<void>
}

const ask = signal<Ask | null>(null)

export function openConfirm(a: Ask) {
  ask.value = a
}

export function ConfirmDialog() {
  const a = ask.value
  const ref = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!a) return
    requestAnimationFrame(() => ref.current?.focus())
  }, [a])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') ask.value = null
    }
    if (a) addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [a])

  if (!a) return null

  const close = () => (ask.value = null)
  const go = () => {
    close()
    void a.onConfirm()
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
          <h2>{a.title}</h2>
          <span style={{ flex: 1 }} />
          <button class="icon-btn" onClick={close} aria-label="Close">
            <IconClose />
          </button>
        </div>
        <div class="dialog-body">
          <p class="dialog-text">{a.body}</p>
        </div>
        <div class="dialog-foot">
          <span style={{ flex: 1 }} />
          <button class="btn" onClick={close}>
            {a.cancel ?? 'Cancel'}
          </button>
          <button ref={ref} class="btn btn-primary" onClick={go}>
            {a.confirm ?? 'OK'}
          </button>
        </div>
      </div>
    </div>
  )
}
