/**
 * Clipboard and drag-and-drop handling.
 *
 * Pasting a screenshot is the single most-used path in a notes app, so it has
 * to feel instantaneous. It does not wait for optimization: a placeholder goes
 * into the document immediately, the image is re-encoded off the interaction
 * path, and the placeholder is swapped for the real embed when it lands. If
 * anything fails, the placeholder is replaced with a visible note rather than
 * disappearing silently.
 */

import { EditorView } from '@codemirror/view'
import { addAttachment } from '../core/vault'
import { attachmentPath, imagesFromDataTransfer, optimizeImage } from '../core/images'
import { settings } from '../core/settings'
import { uid } from '../core/util'

async function ingest(file: File): Promise<string> {
  const s = settings.value
  const isImage = file.type.startsWith('image/')
  let blob: Blob = file
  let mime = file.type

  if (isImage) {
    const out = await optimizeImage(file, {
      maxEdge: s.imageMaxEdge,
      quality: s.imageQuality,
      format: s.imageFormat,
    })
    blob = out.blob
    mime = out.blob.type || file.type
  }

  const path = attachmentPath(s.attachmentFolder, file.name || 'pasted', mime)
  return addAttachment(blob, path)
}

/**
 * Insert placeholders now, real embeds when ready. Placeholders are ordinary
 * text, so an undo during the wait behaves sanely.
 *
 * Exported so the toolbar's photo picker inserts through exactly the same path
 * as a paste — same optimization, same attachment folder, same embed syntax,
 * so a photo from the camera is resizable and lightboxable like any other.
 */
export function insertFiles(view: EditorView, files: File[]) {
  const tokens = files.map(() => `<!--slate-uploading:${uid(6)}-->`)
  const head = view.state.selection.main
  view.dispatch({
    changes: { from: head.from, to: head.to, insert: `${tokens.join('\n')}\n` },
    selection: { anchor: head.from + tokens.join('\n').length + 1 },
    scrollIntoView: true,
  })

  files.forEach(async (file, i) => {
    const token = tokens[i]
    let replacement: string
    try {
      const path = await ingest(file)
      replacement = `![[${path}]]`
    } catch (e) {
      console.error('[slate] attachment failed', e)
      replacement = `> Could not attach **${file.name || 'pasted file'}** — ${(e as Error).message}`
    }
    // Re-find the token: the user has very likely kept typing.
    const text = view.state.doc.toString()
    const at = text.indexOf(token)
    if (at < 0) return
    view.dispatch({
      changes: { from: at, to: at + token.length, insert: replacement },
    })
  })
}

export const pasteHandler = EditorView.domEventHandlers({
  paste(event, view) {
    const images = imagesFromDataTransfer(event.clipboardData)
    if (!images.length) return false
    event.preventDefault()
    insertFiles(view, images)
    return true
  },

  drop(event, view) {
    const dt = event.dataTransfer
    if (!dt?.files?.length) return false
    const files = Array.from(dt.files)
    if (!files.length) return false
    event.preventDefault()
    // Drop lands where the pointer is, not where the caret was.
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
    if (pos != null) view.dispatch({ selection: { anchor: pos } })
    insertFiles(view, files)
    return true
  },

  dragover(event) {
    if (event.dataTransfer?.types?.includes('Files')) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    }
    return false
  },
})
