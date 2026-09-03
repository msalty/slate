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
import { renderTable } from './table'
import { looksLikeGrid, parseDelimited, tableFromGrid } from './tsv'

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

/**
 * A spreadsheet range on the clipboard, as GFM.
 *
 * The `<table>` in the HTML flavour is the discriminator and nothing more — see
 * tsv.ts for why the cells themselves come from the plain-text flavour. Without
 * that check, every tab-separated paste from a terminal would silently become a
 * table; with it, a paste is only a table when it came out of something that
 * thinks in cells.
 */
function tableFromClipboard(dt: DataTransfer | null): string | undefined {
  if (!dt) return undefined
  if (!/<table[\s>]/i.test(dt.getData('text/html') || '')) return undefined
  const text = dt.getData('text/plain')
  if (!text?.trim()) return undefined
  const grid = parseDelimited(text)
  if (!looksLikeGrid(grid)) return undefined
  return renderTable(tableFromGrid(grid))
}

/**
 * Drop a table into the note as its own block.
 *
 * A pipe table has to start a line, and a table butted straight up against a
 * paragraph is read as more of that paragraph by stricter renderers than this
 * one — so whatever is around the caret decides how many newlines go in front
 * of it and behind it.
 */
function insertTableBlock(view: EditorView, table: string) {
  const { state } = view
  const range = state.selection.main
  const line = state.doc.lineAt(range.from)
  const before = state.doc.sliceString(line.from, range.from)
  const after = state.doc.sliceString(range.to, line.to)

  let lead = ''
  if (before.trim()) lead = '\n\n'
  else if (line.number > 1 && state.doc.line(line.number - 1).text.trim()) lead = '\n'

  const insert = `${lead}${table}\n${after.trim() ? '\n' : ''}`
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: { anchor: range.from + insert.length },
    scrollIntoView: true,
    userEvent: 'input.paste',
  })
}

export const pasteHandler = EditorView.domEventHandlers({
  paste(event, view) {
    /*
     * The table is looked for FIRST, and that ordering is the whole feature.
     *
     * A spreadsheet does not put cells on the clipboard and stop: Excel also
     * puts a *picture* of the copied range there, beside the html and the
     * tab-separated text, and the browser hands it over as an ordinary
     * `image/png` file. So an image-first handler — which this was — turns
     * every spreadsheet paste into a screenshot of a spreadsheet, and the
     * table branch below it can never be reached from the app it was written
     * for.
     *
     * Nothing is lost by preferring the table, because the check that finds
     * one is far narrower than the check that finds an image: it needs a
     * `<table>` in the html flavour AND text that parses as a grid at least
     * two columns wide. A copied image, or a copied web page whose html has
     * an <img> but no table, matches neither and falls straight through.
     */
    const table = tableFromClipboard(event.clipboardData)
    if (table) {
      event.preventDefault()
      insertTableBlock(view, table)
      return true
    }

    const images = imagesFromDataTransfer(event.clipboardData)
    if (images.length) {
      event.preventDefault()
      insertFiles(view, images)
      return true
    }
    return false
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
