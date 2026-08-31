/**
 * Photo and file insertion from the editor toolbar.
 *
 * Everything routes through the same `insertFiles` the paste handler uses, so a
 * photo taken on a phone gets the same re-encoding, the same dated attachment
 * folder, and the same resizable, lightboxable embed as a pasted screenshot.
 *
 * The three sources differ only by the attributes on a throwaway <input>:
 *
 *   - `capture="environment"` asks the OS for the camera directly. iOS and
 *     Android honour it; a desktop browser ignores it and shows a file dialog,
 *     which is the right fallback rather than an error.
 *   - `accept="image/*"` with no capture opens the photo library (iOS shows its
 *     own Photo Library / Take Photo / Browse sheet).
 *   - no accept at all allows any file, for PDFs and video.
 */

import type { EditorView } from '@codemirror/view'
import { insertFiles } from './paste'

export type ImageSource = 'camera' | 'library' | 'file'

/**
 * Open a native picker and insert whatever comes back.
 *
 * The input is attached to the document because iOS Safari ignores `click()` on
 * a detached input, and removed on the next tick after the change event —
 * removing it synchronously cancels the picker on some Android builds.
 */
export function pickAndInsert(view: EditorView, source: ImageSource): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.style.position = 'fixed'
  input.style.left = '-9999px'
  input.style.opacity = '0'

  if (source === 'camera') {
    input.accept = 'image/*'
    input.capture = 'environment'
  } else if (source === 'library') {
    input.accept = 'image/*'
    input.multiple = true
  } else {
    input.multiple = true
  }

  const cleanup = () => {
    setTimeout(() => input.remove(), 0)
  }

  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? [])
    if (files.length) {
      view.focus()
      insertFiles(view, files)
    }
    cleanup()
  })
  // Fires when the picker is dismissed without choosing anything. Not supported
  // everywhere, hence the change handler also cleans up.
  input.addEventListener('cancel', cleanup)

  document.body.appendChild(input)
  input.click()
}

/** True when the device plausibly has a camera worth offering. */
export function hasCamera(): boolean {
  if (typeof navigator === 'undefined') return false
  // A coarse pointer is the best available proxy: `mediaDevices` is present on
  // desktops with no camera and absent on insecure origins, so neither is a
  // reliable signal on its own.
  return (
    'capture' in document.createElement('input') &&
    window.matchMedia?.('(pointer: coarse)').matches === true
  )
}
