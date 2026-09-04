/**
 * The one-line notice at the bottom of the window.
 *
 * Its own component only so that both shells — the app and a popped-out note —
 * put up the same thing, rather than two copies of the same markup drifting
 * apart. `notify()` in state.ts is the whole of the API.
 */

import { dismissToast, toast } from './state'

export function Toaster() {
  const t = toast.value
  if (!t) return null
  return (
    <div class="toast" data-kind={t.kind} role="status">
      <span>{t.text}</span>
      {t.action && (
        <button
          class="toast-action"
          onClick={() => {
            const act = toast.value?.action
            dismissToast()
            act?.run()
          }}
        >
          {t.action.label}
        </button>
      )}
    </div>
  )
}
