/**
 * Inline widgets rendered into the editor by the live-preview plugin.
 *
 * Widgets are compared with `eq()` rather than rebuilt on every update — that
 * is what keeps an image from flickering (and losing an in-progress resize
 * drag) each time a character is typed elsewhere in the note.
 */

import { EditorView, WidgetType } from '@codemirror/view'
import { attachmentUrl, getRaw } from '../core/vault'
import { renderInline } from './inline'
import { dueLabel, dueTone, formatBytes, mediaClass, startOfDay } from '../core/util'
import { requestDueMenu, requestLightbox } from './context'
import { wireLinkTaps } from './linkClicks'
import {
  cellSource,
  cellText,
  focusedCell,
  insertRow,
  isDelimiterRow,
  parseTable,
  renderTable,
  requestCellFocus,
  takeCellFocus,
  type TableModel,
} from './table'

export { isDelimiterRow }

/* ------------------------------------------------------------------ ruler */

export class HrWidget extends WidgetType {
  eq() {
    return true
  }
  toDOM() {
    const el = document.createElement('span')
    el.className = 'cm-hr'
    el.setAttribute('aria-hidden', 'true')
    return el
  }
  ignoreEvent() {
    return false
  }
}

/* ----------------------------------------------------------------- bullet */

/** Replaces a literal "-" / "*" / "+" list marker with a typographic bullet. */
export class BulletWidget extends WidgetType {
  eq() {
    return true
  }
  toDOM() {
    const el = document.createElement('span')
    el.className = 'cm-bullet'
    el.textContent = '•'
    el.setAttribute('aria-hidden', 'true')
    return el
  }
  ignoreEvent() {
    return true
  }
}

/* --------------------------------------------------------------- checkbox */

export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super()
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked
  }
  toDOM(view: EditorView) {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-task-checkbox'
    box.checked = this.checked
    box.setAttribute('aria-label', this.checked ? 'Completed task' : 'Incomplete task')
    box.addEventListener('mousedown', (e) => {
      // Toggle on mousedown so the click never lands as a caret placement.
      e.preventDefault()
      e.stopPropagation()
      const pos = view.posAtDOM(box)
      const line = view.state.doc.lineAt(pos)
      const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/.exec(line.text)
      if (!m) return
      const at = line.from + m[1].length
      view.dispatch({
        changes: { from: at, to: at + 1, insert: m[2] === ' ' ? 'x' : ' ' },
        // Keep the caret where it was; toggling shouldn't move focus.
        selection: view.state.selection,
        scrollIntoView: false,
      })
    })
    return box
  }
  ignoreEvent() {
    return false
  }
}

/* -------------------------------------------------------------- due chip */

/**
 * A task's due date, as the same chip the task list shows.
 *
 * Two shapes, one widget. With a date it *replaces* the `📅 2026-09-04` in the
 * source, so the note reads as a sentence with a date on the end instead of a
 * sentence with syntax in it. Without one it is a ghost outline appended to the
 * line — and only to the line the caret is on, which is the same rule the rest
 * of live preview follows for revealing what a line is really made of. A
 * checklist of twenty items doesn't sprout twenty grey buttons; the one you are
 * working on offers you a date.
 */
export class DueChipWidget extends WidgetType {
  constructor(readonly date: number | undefined) {
    super()
  }
  eq(other: DueChipWidget) {
    return other.date === this.date
  }
  toDOM(view: EditorView) {
    const today = startOfDay(Date.now())
    const el = document.createElement('span')
    el.className = 'cm-due-chip'
    el.setAttribute('role', 'button')
    el.setAttribute('tabindex', '-1')
    el.dataset.set = this.date === undefined ? '0' : '1'
    if (this.date !== undefined) el.dataset.tone = dueTone(this.date, today)
    el.textContent = this.date === undefined ? '' : dueLabel(this.date, today)
    el.title = this.date === undefined ? 'Set a due date' : `Due ${dueLabel(this.date, today)}`
    el.setAttribute('aria-label', el.title)
    // Same trick as the checkbox: act on mousedown so the press never also
    // lands as a caret placement inside the widget.
    const open = (e: Event) => {
      e.preventDefault()
      e.stopPropagation()
      const r = el.getBoundingClientRect()
      requestDueMenu({ x: r.left, y: r.bottom + 4 }, view.posAtDOM(el), this.date)
    }
    el.addEventListener('mousedown', open)
    return el
  }
  ignoreEvent() {
    return false
  }
}

/* ------------------------------------------------------------------ table */

/** Chromium and Safari have had `plaintext-only` for years; Firefox recently. */
const PLAINTEXT_ONLY = (() => {
  if (typeof document === 'undefined') return false
  const el = document.createElement('div')
  el.setAttribute('contenteditable', 'plaintext-only')
  return el.contentEditable === 'plaintext-only'
})()

/**
 * Renders a GFM pipe table as a real HTML table.
 *
 * Cell content goes through the inline renderer, so **bold**, `code`, links and
 * wikilinks inside a cell render like they do anywhere else — CodeMirror's own
 * decorations can't reach text that lives inside a widget, so without this a
 * cell would show its markdown literally.
 *
 * In rich text the cells are editable in place. Each one is its own
 * contenteditable host, which is what makes that safe: CodeMirror ignores DOM
 * mutations inside a widget, and while the browser's focus is in a cell the
 * editor does not consider itself focused, so nothing fights over the caret.
 * A cell commits when it loses focus or when Tab, Enter or Escape says it is
 * finished — never on every keystroke, because every commit rewrites the table
 * block and builds a new widget, which would pull the ground out from under
 * the typing.
 *
 * In live preview the older behaviour stands: clicking drops the caret into
 * the pipe source, because revealing the syntax under the caret is what that
 * mode is for.
 */
export class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly from: number,
    readonly notePath: string,
    /**
     * Rich text: cells are typed into directly.
     *
     * Not called `editable`: CodeMirror's own WidgetType has a getter by that
     * name, and shadowing it with a constructor property throws on
     * construction — which takes the whole editor down with it.
     */
    readonly typeable = false,
  ) {
    super()
  }

  eq(other: TableWidget) {
    return (
      other.source === this.source &&
      other.notePath === this.notePath &&
      other.typeable === this.typeable &&
      other.from === this.from
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-table-wrap'
    wrap.setAttribute('contenteditable', 'false')

    const model = parseTable(this.source)
    const rows = this.source.split('\n')
    const delimIndex = rows.findIndex(isDelimiterRow)

    const table = document.createElement('table')
    table.className = 'cm-table-render'
    const thead = document.createElement('thead')
    const tbody = document.createElement('tbody')

    if (!model) {
      // Not a table after all — show the source rather than eat it.
      const pre = document.createElement('pre')
      pre.textContent = this.source
      wrap.appendChild(pre)
      return wrap
    }

    model.rows.forEach((cells, r) => {
      const tr = document.createElement('tr')
      for (let c = 0; c < model.align.length; c++) {
        const cell = document.createElement(r === 0 ? 'th' : 'td')
        const stored = cells[c] ?? ''
        cell.className = 'cm-table-cell'
        cell.dataset.row = String(r)
        cell.dataset.col = String(c)
        if (stored) cell.appendChild(renderInline(cellText(stored), this.notePath))
        if (model.align[c]) cell.style.textAlign = model.align[c]
        if (this.typeable) this.wireCell(view, cell, r, c, stored)
        tr.appendChild(cell)
      }
      ;(r === 0 ? thead : tbody).appendChild(tr)
    })

    table.appendChild(thead)
    table.appendChild(tbody)
    wrap.appendChild(table)

    if (!this.typeable) wrap.addEventListener('mousedown', (e) => this.caretIntoSource(view, wrap, e, rows, delimIndex))

    // Carry on where the last edit left off, once this DOM is on screen.
    const pending = takeCellFocus(this.from)
    if (pending?.focus) {
      queueMicrotask(() => {
        const el = wrap.querySelector<HTMLElement>(
          `[data-row="${pending.row}"][data-col="${pending.col}"]`,
        )
        if (el?.isConnected) {
          el.focus()
          placeCaretAtEnd(el)
        }
      })
    } else if (this.typeable) {
      /*
       * Nothing to focus, but the toolbar may still be aimed at a cell in this
       * table: an edit made from the phone's Format sheet, or the commit that
       * happens when a cell blurs to open it. The new DOM has to show which
       * cell that is, or the buttons act on something invisible.
       */
      const armed = pending ?? cellOf(focusedCell.value, this.from, model)
      if (armed) this.arm(wrap, armed.row, armed.col)
    }

    return wrap
  }

  /**
   * Mark a cell as the one the toolbar is acting on, without focusing it.
   *
   * The styling only shows while the editor believes a cell is its editing
   * target, so it goes away by itself the moment the note takes focus back.
   */
  private arm(wrap: HTMLElement, row: number, col: number) {
    clearArmed(wrap)
    const el = wrap.querySelector<HTMLElement>(`[data-row="${row}"][data-col="${col}"]`)
    if (!el) return
    el.dataset.armed = '1'
    focusedCell.value = { from: this.from, source: this.source, row, col }
  }

  /**
   * Make one cell editable.
   *
   * Focus swaps the rendered markdown for its source, but only when the two
   * differ — for the ordinary cell of plain words they are the same string, and
   * leaving the DOM alone is what lets a click land the caret exactly where it
   * was aimed instead of at the end of the text.
   */
  private wireCell(view: EditorView, cell: HTMLElement, row: number, col: number, stored: string) {
    const raw = cellText(stored)
    cell.setAttribute('contenteditable', PLAINTEXT_ONLY ? 'plaintext-only' : 'true')
    cell.setAttribute('role', 'textbox')

    /*
     * A link in a cell is still a link.
     *
     * Browsers do not follow links inside editable content, and CodeMirror's
     * own handlers are deliberately kept out of this widget, so the cell has to
     * answer for them itself — taps included, which is what a phone gives it.
     * Touching anywhere else in the cell edits it, so a cell that is nothing
     * but a link is reached with Tab.
     */
    wireLinkTaps(view, cell)

    cell.addEventListener('focus', () => {
      focusedCell.value = { from: this.from, source: this.source, row, col }
      // Typing here again: the mark that said "the toolbar is aimed at this
      // cell" has done its job, wherever in the table it was.
      clearArmed(cell.closest('.cm-table-wrap'))
      if (cell.textContent !== raw) {
        cell.textContent = raw
        placeCaretAtEnd(cell)
      }
    })

    cell.addEventListener('blur', () => {
      // `focusedCell` is deliberately not cleared here. Tapping a toolbar
      // button blurs the cell *before* the button's own handler runs, and that
      // handler needs to know which cell it is acting on. It is cleared when
      // the editor itself takes focus, and overwritten the moment another cell
      // is entered.
      if (!this.commit(view, row, col, cell.textContent ?? '')) {
        // Nothing changed: put the rendering back, since focus took it away.
        cell.textContent = ''
        if (stored) cell.appendChild(renderInline(raw, this.notePath))
        // No rewrite means no new DOM to carry the mark, so it is set here —
        // unless focus has already moved on to another cell of the same table.
        const cur = focusedCell.value
        if (cur && cur.from === this.from && cur.row === row && cur.col === col)
          cell.dataset.armed = '1'
      }
    })

    cell.addEventListener('keydown', (e) => {
      const cols = () => (parseTable(this.source)?.align.length ?? 1)
      const rows = () => (parseTable(this.source)?.rows.length ?? 1)

      /*
       * Select-all means this cell.
       *
       * Left to the browser it walks out to the outer editing host — the whole
       * note — takes focus with it, and the next keystroke lands in the
       * document instead of the cell. "Everything in the box I am typing in"
       * is also what anyone pressing it here meant.
       */
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        const range = document.createRange()
        range.selectNodeContents(cell)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        cell.textContent = raw
        cell.blur()
        view.focus()
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        const back = e.shiftKey
        let r = row
        let c = col + (back ? -1 : 1)
        if (c >= cols()) {
          c = 0
          r++
        } else if (c < 0) {
          c = cols() - 1
          r--
        }
        if (r < 0) return
        // Tab off the end adds a row, the way every table editor does.
        this.moveTo(view, cell, row, col, r, c, r >= rows())
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        this.moveTo(view, cell, row, col, row + 1, col, row + 1 >= rows())
      }
    })
  }

  /** Commit this cell, then carry on in another one. */
  private moveTo(
    view: EditorView,
    cell: HTMLElement,
    row: number,
    col: number,
    nextRow: number,
    nextCol: number,
    addRow: boolean,
  ) {
    const text = cell.textContent ?? ''
    const model = parseTable(this.source)
    if (!model) return
    model.rows[row][col] = cellSource(text)
    const grown = addRow ? insertRow(model, model.rows.length) : model
    const row2 = Math.min(nextRow, grown.rows.length - 1)
    const col2 = Math.min(nextCol, grown.align.length - 1)
    requestCellFocus(this.from, row2, col2)
    if (!this.write(view, grown)) {
      // Nothing to write — the move is still worth making.
      const target = cell
        .closest('table')
        ?.querySelector<HTMLElement>(`[data-row="${row2}"][data-col="${col2}"]`)
      if (target) {
        target.focus()
        placeCaretAtEnd(target)
      }
    }
  }

  /** Write one cell back into the note. Returns false when nothing changed. */
  private commit(view: EditorView, row: number, col: number, text: string): boolean {
    const model = parseTable(this.source)
    if (!model) return false
    const next = cellSource(text)
    if ((model.rows[row]?.[col] ?? '') === next) return false
    model.rows[row][col] = next
    return this.write(view, model)
  }

  private write(view: EditorView, model: TableModel): boolean {
    const insert = renderTable(model)
    if (insert === this.source) return false
    const to = this.from + this.source.length
    // The widget can be one render behind an edit made elsewhere in the note;
    // rewriting a range that has moved would corrupt it.
    if (to > view.state.doc.length || view.state.doc.sliceString(this.from, to) !== this.source)
      return false
    view.dispatch({ changes: { from: this.from, to, insert }, userEvent: 'input.table' })
    // Keep the published cell pointing at text that still matches the note, so
    // a toolbar button pressed straight after this still knows where it is.
    const cur = focusedCell.value
    if (cur && cur.from === this.from) focusedCell.value = { ...cur, source: insert }
    return true
  }

  /** Live preview: a click puts the caret in the markdown behind the table. */
  private caretIntoSource(
    view: EditorView,
    wrap: HTMLElement,
    e: MouseEvent,
    rows: string[],
    delimIndex: number,
  ) {
    // Links, tags and images inside a cell keep their own behaviour; only a
    // click on the table itself moves the caret into the source.
    const target = e.target as HTMLElement | null
    if (target?.closest('[data-wikilink], [data-tag], [data-href], a, img')) return

    e.preventDefault()
    const tr = target?.closest('tr')
    let offset = 0
    if (tr) {
      const all = [...wrap.querySelectorAll('tr')]
      const visualRow = all.indexOf(tr)
      const sourceRow = delimIndex >= 0 && visualRow >= delimIndex ? visualRow + 1 : visualRow
      for (let i = 0; i < sourceRow && i < rows.length; i++) offset += rows[i].length + 1
    }
    const pos = Math.min(this.from + offset, view.state.doc.length)
    // Tagged as a pointer selection so live preview counts it as the user
    // choosing to edit — an untagged dispatch would leave the table rendered
    // and the caret invisible behind it.
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: false, userEvent: 'select.pointer' })
    view.focus()
  }

  /**
   * Keep the editor's hands off events inside an editable cell.
   *
   * CodeMirror walks up from an event's target and, unless a widget claims it,
   * runs its own handlers — so ⌘A inside a cell would select the whole note
   * and the next keystroke would replace it. A cell is its own editing host
   * and answers for everything that happens in it.
   */
  ignoreEvent(event: Event) {
    if (!this.typeable) return false
    const target = event.target as HTMLElement | null
    return !!target?.closest?.('.cm-table-cell')
  }
}

/** Take the toolbar's mark off every cell of a table. */
function clearArmed(root: Element | null) {
  if (!root) return
  for (const el of root.querySelectorAll<HTMLElement>('[data-armed]')) delete el.dataset.armed
}

/**
 * The published cell as coordinates into a table that may have just changed
 * shape — a deleted row leaves the toolbar aimed one row past the end.
 */
function cellOf(
  cell: { from: number; row: number; col: number } | null,
  from: number,
  model: TableModel,
): { row: number; col: number } | null {
  if (!cell || cell.from !== from) return null
  return {
    row: Math.min(cell.row, model.rows.length - 1),
    col: Math.min(cell.col, model.align.length - 1),
  }
}

function placeCaretAtEnd(el: HTMLElement) {
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

/* ------------------------------------------------------------------ embed */

export interface EmbedSpec {
  /** Resolved vault path, or undefined when the target is missing. */
  path?: string
  /** External URL, when the embed points off-vault. */
  href?: string
  label: string
  width?: number
  /** Doc offsets of the width token, so a resize can rewrite it. */
  alt: string
}

export class EmbedWidget extends WidgetType {
  constructor(readonly spec: EmbedSpec) {
    super()
  }

  eq(other: EmbedWidget) {
    const a = this.spec
    const b = other.spec
    return a.path === b.path && a.href === b.href && a.width === b.width && a.label === b.label
  }

  /** Height is unknown until the image loads; let CM re-measure when it does. */
  get estimatedHeight() {
    return this.spec.path || this.spec.href ? 240 : 24
  }

  toDOM(view: EditorView): HTMLElement {
    const { path, href, label, width, alt } = this.spec
    const wrap = document.createElement('div')
    wrap.className = 'cm-embed'
    wrap.setAttribute('contenteditable', 'false')

    if (!path && !href) {
      const missing = document.createElement('span')
      missing.className = 'cm-embed-missing'
      missing.textContent = `Missing: ${label}`
      wrap.appendChild(missing)
      return wrap
    }

    const src = href ?? attachmentUrl(path!) ?? ''
    const kind = href ? 'image' : mediaClass(path!)

    if (kind === 'image') {
      const img = document.createElement('img')
      img.src = src
      img.alt = alt || label
      img.loading = 'lazy'
      img.draggable = false
      if (width) img.style.width = `${width}px`
      img.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        if (path) requestLightbox(path)
        else window.open(href, '_blank', 'noopener')
      })
      // The intrinsic size arrives late; tell CM so the scroll position is right.
      img.addEventListener('load', () => view.requestMeasure())
      img.addEventListener('error', () => {
        img.replaceWith(card('Could not load', label, () => {}))
      })
      wrap.appendChild(img)
      if (path) wrap.appendChild(this.resizeHandle(view, img))
      return wrap
    }

    if (kind === 'video') {
      const v = document.createElement('video')
      v.src = src
      v.controls = true
      v.preload = 'metadata'
      if (width) v.style.width = `${width}px`
      v.addEventListener('loadedmetadata', () => view.requestMeasure())
      wrap.appendChild(v)
      if (path) wrap.appendChild(this.resizeHandle(view, v))
      return wrap
    }

    if (kind === 'audio') {
      const a = document.createElement('audio')
      a.src = src
      a.controls = true
      a.preload = 'metadata'
      a.style.width = '100%'
      a.style.maxWidth = '420px'
      wrap.appendChild(a)
      return wrap
    }

    // PDFs and everything else get a card that opens the viewer.
    const f = path ? getRaw(path) : undefined
    wrap.appendChild(
      card(label, f ? `${kind.toUpperCase()} · ${formatBytes(f.size)}` : kind.toUpperCase(), () => {
        if (path) requestLightbox(path)
        else window.open(href, '_blank', 'noopener')
      }),
    )
    return wrap
  }

  /**
   * Drag-to-resize. The live width is applied to the element during the drag
   * for immediate feedback, then written back into the markdown once on
   * release — so a resize is one undoable edit, not one per mouse move.
   */
  private resizeHandle(view: EditorView, target: HTMLElement): HTMLElement {
    const handle = document.createElement('div')
    handle.className = 'cm-embed-resize'
    handle.setAttribute('role', 'separator')
    handle.setAttribute('aria-label', 'Resize')

    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const startX = e.clientX
      const startW = target.getBoundingClientRect().width
      const maxW = (target.parentElement?.parentElement?.clientWidth ?? 900) - 8
      handle.setPointerCapture(e.pointerId)
      let next = Math.round(startW)

      const move = (ev: PointerEvent) => {
        next = Math.round(Math.min(maxW, Math.max(80, startW + (ev.clientX - startX))))
        target.style.width = `${next}px`
      }
      const up = () => {
        handle.releasePointerCapture(e.pointerId)
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', up)
        // Snap back to "natural" when dragged close to full width, so the
        // common case stays free of a hard-coded pixel value.
        const natural = next >= maxW - 12
        applyWidth(view, handle, natural ? undefined : next)
      }
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', up)
    })
    return handle
  }

  ignoreEvent() {
    return true
  }
}

function card(title: string, sub: string, onClick: () => void): HTMLElement {
  const el = document.createElement('div')
  el.className = 'cm-embed-card'
  el.innerHTML =
    `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`
  const text = document.createElement('div')
  const t = document.createElement('div')
  t.textContent = title
  t.style.fontWeight = '500'
  const s = document.createElement('div')
  s.textContent = sub
  s.style.color = 'var(--text-faint)'
  s.style.fontSize = '0.85em'
  text.append(t, s)
  el.appendChild(text)
  el.addEventListener('click', onClick)
  return el
}

/**
 * Rewrite the width in the markdown that produced this widget.
 *
 * Both syntaxes are supported: `![[img.png|400]]` (Obsidian) and
 * `![alt](img.png#w=400)` (a plain-markdown URL fragment that other renderers
 * simply ignore). The position is re-derived from the DOM at write time so a
 * concurrent edit above the image can't corrupt the wrong range.
 */
function applyWidth(view: EditorView, dom: HTMLElement, width: number | undefined) {
  const pos = view.posAtDOM(dom)
  const line = view.state.doc.lineAt(pos)
  const text = line.text
  const rel = pos - line.from

  const wiki = /!\[\[([^\]\n|]+)(?:\|([^\]\n]*))?\]\]/g
  let m: RegExpExecArray | null
  while ((m = wiki.exec(text))) {
    if (rel < m.index || rel > m.index + m[0].length) continue
    const target = m[1]
    const inner = width ? `${target}|${width}` : target
    view.dispatch({
      changes: { from: line.from + m.index, to: line.from + m.index + m[0].length, insert: `![[${inner}]]` },
    })
    return
  }

  const md = /!\[([^\]\n]*)\]\(([^)\s]*)\)/g
  while ((m = md.exec(text))) {
    if (rel < m.index || rel > m.index + m[0].length) continue
    const url = m[2].replace(/#w=\d+$/, '')
    const next = width ? `${url}#w=${width}` : url
    view.dispatch({
      changes: {
        from: line.from + m.index,
        to: line.from + m.index + m[0].length,
        insert: `![${m[1]}](${next})`,
      },
    })
    return
  }
}
