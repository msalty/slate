/**
 * Clipboard and drag-and-drop handling, in both directions.
 *
 * Pasting a screenshot is the single most-used path in a notes app, so it has
 * to feel instantaneous. It does not wait for optimization: a placeholder goes
 * into the document immediately, the image is re-encoded off the interaction
 * path, and the placeholder is swapped for the real embed when it lands. If
 * anything fails, the placeholder is replaced with a visible note rather than
 * disappearing silently.
 */

import { formatWikiLink } from '../core/wikilink'
import { EditorSelection, type SelectionRange } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { addAttachment } from '../core/vault'
import { attachmentPath, imagesFromDataTransfer, optimizeImage } from '../core/images'
import { settings } from '../core/settings'
import { uid } from '../core/util'
import { expandToMarkup } from './format'
import { previewMode } from './livePreview'
import { cellText, currentTable, renderTable, tableRowsInSelection } from './table'
import { gridToHtml, looksLikeGrid, parseDelimited, tableFromGrid } from './tsv'

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
      replacement = formatWikiLink({ target: path, embed: true })
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
 * Embed files the vault already holds, at the caret.
 *
 * The counterpart to `insertFiles` for the picker: nothing to ingest, nothing
 * to wait for, so the embed goes straight in. Same `![[path]]` syntax a paste
 * ends up producing, which is what makes an inserted file resizable and
 * lightboxable like every other embed — and what lets the same file be used by
 * two notes instead of being uploaded twice.
 */
export function insertVaultFiles(view: EditorView, paths: string[]): void {
  if (!paths.length) return
  const text = `${paths.map((p) => formatWikiLink({ target: p, embed: true })).join('\n')}\n`
  const head = view.state.selection.main
  view.dispatch({
    changes: { from: head.from, to: head.to, insert: text },
    selection: { anchor: head.from + text.length },
    scrollIntoView: true,
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

/**
 * Put a whole table on the clipboard on demand, rather than by selecting it.
 *
 * Dragging across a table works and is what the `copy` handler below is for,
 * but it is a gesture with no edges: in the rendered modes the table is a
 * single widget, and a drag that overshoots it by a few pixels takes in the
 * paragraph underneath — at which point the copy is correctly refused and the
 * only sign of it is pipes arriving in Excel. This is the same operation with
 * the aim taken out of it: the caret is somewhere in the table, so the table is
 * what gets copied.
 */
export async function copyTable(view: EditorView): Promise<boolean> {
  // Resolved here rather than passed in, so a cell still being typed in is
  // folded into what gets copied — the same rule every other table action uses.
  const cursor = currentTable(view)
  if (!cursor) return false
  const rows = cursor.model.rows.map((r) => r.map(cellText))
  // Both flavours, for the same reason the selection path writes both: the
  // markdown for anything that reads text, the table for anything that reads
  // HTML — which is every spreadsheet.
  return writeBothFlavours(renderTable(cursor.model), gridToHtml(rows, true))
}

/**
 * Write text and HTML together, outside of a copy event.
 *
 * The async clipboard API is the way to do this and wants a `ClipboardItem`.
 * Where that is missing the old trick still works: listen for one copy event,
 * fill it in by hand, and provoke it with `execCommand` against a selection
 * nobody sees. A hidden textarea is what supplies that selection — without one
 * there is nothing to copy and the event never fires.
 */
async function writeBothFlavours(text: string, html: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        }),
      ])
      return true
    }
  } catch {
    // Denied permission lands here as readily as a missing API. Fall through.
  }

  try {
    let wrote = false
    const fill = (e: ClipboardEvent) => {
      e.preventDefault()
      e.clipboardData?.setData('text/plain', text)
      e.clipboardData?.setData('text/html', html)
      wrote = true
    }
    document.addEventListener('copy', fill, true)
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
    document.removeEventListener('copy', fill, true)
    return wrote
  } catch {
    return false
  }
}

/**
 * The selection to put on the clipboard, when it is not the one the user made.
 *
 * Rich text hides the `==` around a highlight and the `## ` in front of a
 * heading, so a selection can only ever be the visible text between them — and
 * the copy comes out plain. Null when the selection already covers whatever it
 * is inside, which is every other mode and nearly every selection in this one.
 *
 * Every range of it, not only the main one. The copy and the cut put one
 * string on the clipboard either way, but a paste writes into each range
 * separately — so reading only the main range rewrote one selected word and
 * left the other alone, and "alone" meant gone, the transaction having
 * replaced the whole selection with a single cursor.
 *
 * The empty ranges are kept rather than being a reason to stand back. Putting
 * a second cursor down somewhere else used to switch the whole thing off, so
 * the word that *was* selected got pasted over without its markup counted and
 * `**one**` became `****X****`. A bare cursor is a place to insert, not a
 * statement about the ranges that are not bare. What each operation then does
 * with an empty range is CodeMirror's rule, kept at both call sites: a paste
 * writes into it, a copy and a cut pass over it.
 */
function markedRanges(
  view: EditorView,
): { ranges: Array<{ from: number; to: number }>; main: number } | null {
  if (view.state.facet(previewMode) !== 'rich') return null
  const sel = view.state.selection

  const grown = sel.ranges.map((r) =>
    r.empty ? { from: r.from, to: r.to } : expandToMarkup(view.state, r.from, r.to),
  )
  if (grown.every((g, i) => g.from === sel.ranges[i].from && g.to === sel.ranges[i].to)) return null

  /*
   * Growing can make two ranges overlap, where the selection's own never do,
   * and two changes over one piece of document is an error CodeMirror throws
   * on. Ranges arrive sorted, so an overlap is always with the ones just
   * built — and only a real one: two spans that merely end and begin at the
   * same offset are two separate edits, and merging them there would paste
   * once where twice was asked for.
   */
  const out: Array<{ from: number; to: number }> = []
  for (const g of grown) {
    let cur = { from: g.from, to: g.to }
    while (out.length && cur.from < out[out.length - 1].to) {
      const prev = out.pop()!
      cur = { from: Math.min(cur.from, prev.from), to: Math.max(cur.to, prev.to) }
    }
    out.push(cur)
  }

  // Whichever of them ended up holding the range the caret was really in.
  const { main } = sel
  const at = out.findIndex((r) => main.from >= r.from && main.to <= r.to)
  return { ranges: out, main: Math.max(0, at) }
}

type Marked = NonNullable<ReturnType<typeof markedRanges>>

/**
 * The ranges a copy or a cut is about: the ones with something in them.
 *
 * CodeMirror ignores an empty range while any range is not empty, and only
 * copies whole lines when the selection is *all* cursors. That second case has
 * nothing to widen over, so it never gets this far — but the check stays,
 * because a copy that put a blank line on the clipboard for each stray cursor
 * would be this handler inventing a rule of its own.
 */
function filled(grown: Marked): Array<{ from: number; to: number }> {
  return grown.ranges.filter((r) => r.from !== r.to)
}

/** What several ranges read as on the clipboard: one per line, as CodeMirror writes them. */
function joinRanges(view: EditorView, ranges: Array<{ from: number; to: number }>): string {
  return ranges.map((r) => view.state.sliceDoc(r.from, r.to)).join(view.state.lineBreak)
}

/**
 * One transaction writing `text(i)` over each range, leaving a cursor after each.
 *
 * The ranges are positions in the document as it stands, so each cursor has to
 * be moved by what the edits before it added or removed — `shift` is that
 * running total. Everything here could be `changeByRange` if the ranges still
 * matched the selection's one for one, but widening can merge two of them into
 * one, which is exactly when getting this wrong would throw.
 */
function spread(grown: Marked, text: (i: number) => string) {
  const changes: Array<{ from: number; to: number; insert: string }> = []
  const cursors: SelectionRange[] = []
  let shift = 0
  grown.ranges.forEach((r, i) => {
    const insert = text(i)
    changes.push({ from: r.from, to: r.to, insert })
    cursors.push(EditorSelection.cursor(r.from + shift + insert.length))
    shift += insert.length - (r.to - r.from)
  })
  return { changes, selection: EditorSelection.create(cursors, grown.main) }
}

export const clipboardHandler = EditorView.domEventHandlers({
  /**
   * Copying a table puts it on the clipboard as a table as well as as markdown.
   *
   * Purely additive: the plain-text flavour stays exactly the markdown that was
   * selected, and an HTML `<table>` is added beside it. Every spreadsheet reads
   * HTML in preference to plain text — it is how a table copied from a web page
   * lands in cells — so Excel gets cells while another markdown editor still
   * gets the pipe table. Writing tab-separated text over the plain flavour
   * would have bought the first and lost the second.
   */
  copy(event, view) {
    /*
     * A copy made inside a rendered cell is the browser copying that cell's own
     * DOM, and the editor's selection is somewhere else entirely — quite
     * possibly stale. Leave it alone.
     */
    if ((event.target as HTMLElement | null)?.closest?.('.cm-table-cell')) return false
    const dt = event.clipboardData
    if (!dt) return false

    const selected = tableRowsInSelection(view.state)
    if (selected) {
      event.preventDefault()
      const { main } = view.state.selection
      dt.setData('text/plain', view.state.sliceDoc(main.from, main.to))
      dt.setData('text/html', gridToHtml(selected.rows, selected.hasHeader))
      return true
    }

    const grown = markedRanges(view)
    const taken = grown && filled(grown)
    if (!taken?.length) return false
    event.preventDefault()
    dt.setData('text/plain', joinRanges(view, taken))
    return true
  },

  /**
   * The same widening, applied to the text that leaves the note *and* to the
   * text taken out of it — a cut that removed only the inside of a highlight
   * would leave a bare `====` behind, which is not even a highlight any more.
   */
  cut(event, view) {
    if ((event.target as HTMLElement | null)?.closest?.('.cm-table-cell')) return false
    const dt = event.clipboardData
    if (!dt) return false
    const grown = markedRanges(view)
    const taken = grown && filled(grown)
    if (!taken?.length) return false

    event.preventDefault()
    dt.setData('text/plain', joinRanges(view, taken))
    /*
     * A note locked by its own properties refuses every edit, and `readOnly` is
     * where it says so — but it is consulted by CodeMirror's *commands*, and
     * this builds its own delete out of a raw dispatch, which nothing checks.
     * So a cut took text out of a note that had said no, while a plain cut in
     * the same note was correctly refused.
     *
     * Copying still happens. Taking a quote out of a note you cannot edit is
     * not an edit, and it is already what a plain cut does there.
     */
    if (view.state.readOnly) return true
    /*
     * No selection of its own: the changes map the one that is there, which
     * collapses each deleted range to a cursor and leaves the bare cursors
     * where they were. Spelling it out would have had to say the same thing.
     */
    view.dispatch({
      changes: taken.map((r) => ({ from: r.from, to: r.to, insert: '' })),
      userEvent: 'delete.cut',
    })
    return true
  },

  paste(event, view) {
    // A note locked by its properties takes nothing from the clipboard. This
    // handler runs before CodeMirror's own, which is the one that would
    // otherwise have refused it.
    if (view.state.readOnly) return false
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

    /*
     * The same widening the copy and the cut above already apply, applied to
     * what the paste replaces — because a selection of the visible text inside
     * `==word==` *means* `==word==`, and all three have to agree about that or
     * none of them is right.
     *
     * They did not. Copy took `==word==` and paste put it back over `word`
     * alone, so copying a highlighted word and pasting it straight back over
     * itself — which has to be a no-op — wrote `====word====`. Bold did the
     * same with `****bold****`.
     *
     * The cost is real and worth stating: pasting plain text over a
     * highlighted word now replaces the highlight rather than landing inside
     * it. That is the same thing cutting there already did, and the
     * alternative was a clipboard whose three operations disagreed about what
     * the selection was.
     */
    const grown = markedRanges(view)
    const pasted = event.clipboardData?.getData('text/plain')
    if (grown && pasted) {
      event.preventDefault()
      const insert = pasted.replace(/\r\n?/g, '\n')
      /*
       * CodeMirror's own rule for a multi-range paste, kept because taking the
       * event away from it must not change what pasting means: as many lines
       * as there are ranges is one line each — it is how a column copied out of
       * one place lands in another — and anything else is the whole text into
       * every range.
       */
      const lines = insert.split('\n')
      const perRange = lines.length === grown.ranges.length
      view.dispatch({
        ...spread(grown, (i) => (perRange ? lines[i] : insert)),
        userEvent: 'input.paste',
      })
      return true
    }
    return false
  },

  drop(event, view) {
    if (view.state.readOnly) return false
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
