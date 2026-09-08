/**
 * Inline widgets rendered into the editor by the live-preview plugin.
 *
 * Widgets are compared with `eq()` rather than rebuilt on every update — that
 * is what keeps an image from flickering (and losing an in-progress resize
 * drag) each time a character is typed elsewhere in the note.
 */

import { EditorView, WidgetType } from '@codemirror/view'
import { attachmentUrl, getRaw } from '../core/vault'
import { fencedBody } from './codeblock'
import { ICONS, withCalloutFold } from './callout'
import { renderInline } from './inline'
import { basename, dueLabel, dueTone, formatBytes, mediaClass, startOfDay } from '../core/util'
import { resolveVars, type FrontmatterValue } from '../core/markdown'
import { frontmatterOf } from './vars'
import { MD_URL } from './links'
import { familyIconSvg, fileIconSvg, fileTypeLabel } from '../core/filetypes'
import { pdfAsset, pdfLibrary } from '../core/pdfjs'
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

/* ---------------------------------------------------------------- callout */

/**
 * The `[!WARNING]` marker at the head of a callout, as an icon.
 *
 * This *replaces* the marker rather than sitting beside it, so the first line
 * reads as a heading — an icon, then whatever title the author wrote. When they
 * wrote none, the widget supplies the type's own name, which is what GitHub
 * shows and what makes an untitled callout still announce itself.
 */
export class CalloutWidget extends WidgetType {
  constructor(
    readonly icon: string,
    /** The fallback title, or "" when the author wrote their own. */
    readonly label: string,
    /** True when the callout's body is collapsed behind this line. */
    readonly folded: boolean,
    /** False for a one-line callout: there is nothing under it to fold. */
    readonly foldable: boolean,
  ) {
    super()
  }

  eq(other: CalloutWidget) {
    return (
      other.icon === this.icon &&
      other.label === this.label &&
      other.folded === this.folded &&
      other.foldable === this.foldable
    )
  }

  toDOM(view: EditorView) {
    const el = document.createElement('span')
    el.className = 'cm-callout-mark'
    el.setAttribute('contenteditable', 'false')
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '1.8')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    svg.setAttribute('aria-hidden', 'true')
    // App-authored constants from callout.ts, never note content.
    svg.innerHTML = ICONS[this.icon] ?? ICONS.note
    el.appendChild(svg)
    if (this.label) {
      const text = document.createElement('span')
      text.className = 'cm-callout-label'
      text.textContent = this.label
      el.appendChild(text)
    }
    if (this.foldable) el.appendChild(this.chevron(view))
    return el
  }

  /**
   * The fold control: a chevron after the icon, which is the whole of the
   * gesture.
   *
   * It writes Obsidian's `-` into the marker rather than holding a fold in the
   * editor — so the state travels with the note, and a folded callout opened in
   * Obsidian is folded there too. The line is rewritten as one change, which
   * also means undo puts it straight back.
   *
   * Kept out of the tab order and hidden until hover, except when the callout
   * is folded — then it is the only sign there is anything underneath, and has
   * to be visible on its own.
   */
  private chevron(view: EditorView): HTMLElement {
    /*
     * A real `<button>`, not a span with a role. Inside a contenteditable a
     * button takes the click's focus itself, which is what stops the press from
     * also landing a caret on the line — and a caret on the line reveals the
     * raw marker, taking this chevron with it. Preventing the default is not
     * enough on its own; the element type is.
     */
    const btn = document.createElement('button')
    btn.className = 'cm-callout-fold'
    btn.type = 'button'
    btn.dataset.folded = this.folded ? '1' : '0'
    // Chrome on the button, not the note: tabbing through a note moves through
    // the note, the same rule the code block's copy button follows.
    btn.tabIndex = -1
    btn.title = this.folded ? 'Unfold callout' : 'Fold callout'
    btn.setAttribute('aria-label', btn.title)
    btn.appendChild(glyph('cm-callout-chevron', '<path d="m9 5 7 7-7 7"/>'))
    /*
     * Cancelled on the way down, acted on the way up — the copy button's
     * split, and for a sharper reason here. The press must not place a caret,
     * because a caret on this line reveals the raw `[!warning]` and takes this
     * widget with it. And the fold cannot happen *during* the press either:
     * folding rebuilds the widget, so the button would be destroyed out from
     * under the click and the editor would take the focus the button had.
     */
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const line = view.state.doc.lineAt(view.posAtDOM(btn))
      const next = withCalloutFold(line.text, this.folded ? '' : '-')
      if (next === line.text) return
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: next },
        // Keep the caret where it was, exactly as the checkbox does: folding
        // is not editing the line, and a caret landing on it would reveal the
        // marker the chevron is attached to — taking the chevron with it.
        selection: view.state.selection,
        scrollIntoView: false,
      })
    })
    return btn
  }

  ignoreEvent() {
    return false
  }
}

/**
 * What a folded callout shows where its body was: how many lines are hidden.
 *
 * A count rather than an ellipsis, because the one question a collapsed thing
 * has to answer is how much of it there is.
 */
export class CalloutFoldWidget extends WidgetType {
  constructor(readonly lines: number) {
    super()
  }
  eq(other: CalloutFoldWidget) {
    return other.lines === this.lines
  }
  toDOM() {
    const el = document.createElement('span')
    el.className = 'cm-callout-folded'
    el.setAttribute('contenteditable', 'false')
    el.textContent = `${this.lines} more line${this.lines === 1 ? '' : 's'}`
    el.title = 'Folded — use the chevron to open'
    return el
  }
  ignoreEvent() {
    return true
  }
}

/* -------------------------------------------------------------- copy code */

const COPY_ICON =
  '<rect x="9" y="9" width="11.5" height="11.5" rx="2.2"/><path d="M5.5 15H4.6A1.6 1.6 0 0 1 3 13.4V4.6A1.6 1.6 0 0 1 4.6 3h8.8A1.6 1.6 0 0 1 15 4.6v.9"/>'
const DONE_ICON = '<path d="m5 12.5 4.5 4.5L19 7"/>'

function glyph(cls: string, paths: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', cls)
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.9')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.innerHTML = paths
  return svg
}

/**
 * Copy a fenced code block, from a button in its top right corner.
 *
 * The code is read out of the document when the button is *pressed*, not when
 * it was drawn. That keeps `eq()` unconditionally true — so typing inside the
 * block doesn't rebuild the button on every keystroke — and means the button
 * can never hand over a stale copy of a block that has since been edited.
 *
 * Both glyphs are in the DOM from the start and CSS shows one of them, so the
 * "copied" flash never rebuilds the button and never has to be undone if the
 * widget goes away while the timer is still running.
 */
export class CopyCodeWidget extends WidgetType {
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    /**
     * Rich text: the block goes to the clipboard the way the page shows it,
     * `$(host)` and all resolved. Which is most of why a property in a fenced
     * block is worth having — a command you fill in at the top of the note and
     * copy out of the middle of it.
     */
    readonly resolve = false,
  ) {
    super()
  }

  eq(other: CopyCodeWidget) {
    return other.resolve === this.resolve
  }

  toDOM(view: EditorView) {
    const btn = document.createElement('button')
    btn.className = 'cm-code-copy'
    btn.type = 'button'
    // Not in the tab order: it is chrome on a block of text, and tabbing
    // through a note should move through the note.
    btn.tabIndex = -1
    btn.setAttribute('contenteditable', 'false')
    btn.title = 'Copy code'
    btn.setAttribute('aria-label', 'Copy code')
    btn.append(glyph('cm-code-copy-idle', COPY_ICON), glyph('cm-code-copy-done', DONE_ICON))

    // Act on mousedown like the checkbox and the due chip do, so the press
    // never also lands as a caret placement inside the block.
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const pos = view.posAtDOM(btn)
      const body = fencedBody(view.state.doc.toString().split('\n'), view.state.doc.lineAt(pos).number - 1)
      if (body === undefined) return
      const text = this.resolve ? resolveVars(body, frontmatterOf(view.state)) : body
      void copyText(text).then((ok) => {
        if (!ok) return
        btn.dataset.copied = '1'
        btn.title = 'Copied'
        clearTimeout(this.timer)
        this.timer = setTimeout(() => {
          delete btn.dataset.copied
          btn.title = 'Copy code'
        }, 1400)
      })
    })
    return btn
  }

  destroy() {
    clearTimeout(this.timer)
  }

  ignoreEvent() {
    return false
  }
}

/**
 * Clipboard write with the old path behind it.
 *
 * `navigator.clipboard` needs a secure context, and the README's own LAN
 * instructions put people on plain `http://` where it is simply absent — so the
 * button would do nothing at all on exactly the setup the docs describe.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through: denied permission lands here as readily as no API at all.
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

/* --------------------------------------------------------------- checkbox */

export class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    /** A note locked by its own properties: the box shows, and does not tick. */
    readonly locked = false,
  ) {
    super()
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.locked === this.locked
  }
  toDOM(view: EditorView) {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-task-checkbox'
    box.checked = this.checked
    box.disabled = this.locked
    box.setAttribute('aria-label', this.checked ? 'Completed task' : 'Incomplete task')
    box.addEventListener('mousedown', (e) => {
      // Toggle on mousedown so the click never lands as a caret placement.
      e.preventDefault()
      e.stopPropagation()
      if (view.state.readOnly) return
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
      // A date is an edit like any other, and a locked note takes none.
      if (view.state.readOnly) return
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

/** Are two sets of properties the same, as far as anything drawn from them cares? */
function sameVars(
  a: Record<string, FrontmatterValue>,
  b: Record<string, FrontmatterValue>,
): boolean {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((k) => k in b && String(a[k]) === String(b[k]))
}

/* --------------------------------------------------------------- variable */

/**
 * A property standing in for the `$(key)` that asked for it.
 *
 * Deliberately not a chip when it has a value: the whole point is a note that
 * reads as finished prose, so the value sits in the sentence looking like the
 * text somebody would have typed. What marks it is a tooltip, and — in rich
 * text, where the properties form exists — a click that opens the form at the
 * property it came from.
 *
 * A declared property with nothing in it is the other half of the same idea. A
 * template is mostly blanks when it is new, and a blank that shows its own
 * name is a to-do list for filling the note in.
 */
export class VarWidget extends WidgetType {
  constructor(
    readonly key: string,
    /** The value, or undefined for a property declared and left empty. */
    readonly value: string | undefined,
    /** Rich text only: the click that opens the properties form. */
    readonly clickable: boolean,
  ) {
    super()
  }

  eq(other: VarWidget) {
    return other.key === this.key && other.value === this.value && other.clickable === this.clickable
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span')
    const filled = this.value !== undefined
    el.className = filled ? 'cm-var' : 'cm-var cm-var-blank'
    el.textContent = filled ? this.value! : this.key
    el.title = filled
      ? `${this.key} — from this note's properties${this.clickable ? ', click to edit' : ''}`
      : `${this.key} has no value yet${this.clickable ? ' — click to fill it in' : ''}`
    /*
     * A value is text to be selected, not an object to be dragged.
     *
     * A widget is `contenteditable="false"` inside editable content, which is
     * enough for a browser to answer a press-and-sweep starting on it by
     * dragging the element instead of selecting through it — so a selection
     * begun on a value selected nothing, and the drag it became handed the
     * clipboard the token. The picture widget says the same thing for the same
     * reason.
     */
    el.draggable = false
    // What `linkClicks` looks for. Only in rich text: in live preview there is
    // no properties form to open, and a click there should land the caret and
    // reveal the token, which is what that mode is for.
    if (this.clickable) el.dataset.var = this.key
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
    /**
     * The note's properties, for a `$(client)` written into a cell.
     *
     * Carried rather than looked up so the widget can tell whether it is out
     * of date: a table's own source does not change when a property does, so
     * without this the cell would keep showing yesterday's value.
     */
    readonly vars: Record<string, FrontmatterValue> = {},
  ) {
    super()
  }

  eq(other: TableWidget) {
    return (
      other.source === this.source &&
      other.notePath === this.notePath &&
      other.typeable === this.typeable &&
      other.from === this.from &&
      sameVars(other.vars, this.vars)
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
        if (stored)
          cell.appendChild(renderInline(cellText(stored), this.notePath, this.vars, this.typeable))
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
        if (stored) cell.appendChild(renderInline(raw, this.notePath, this.vars, this.typeable))
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

/**
 * What a PDF preview is drawn at when the markdown names no width — a fallback
 * for the rare case of drawing before layout. `.cm-embed-pdf` in the theme
 * carries the same number, and is what actually decides the width on screen.
 */
const PDF_WIDTH = 420

export class EmbedWidget extends WidgetType {
  /** Work to undo when CodeMirror throws this widget's DOM away. */
  private cleanups: Array<() => void> = []
  /** True once that has happened: nothing in flight should touch the DOM after. */
  private gone = false

  constructor(readonly spec: EmbedSpec) {
    super()
  }

  destroy() {
    this.gone = true
    for (const c of this.cleanups) c()
    this.cleanups = []
  }

  /** Register cleanup, or run it now if the widget is already gone. */
  private onGone(undo: () => void) {
    if (this.gone) undo()
    else this.cleanups.push(undo)
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
        this.open()
      })
      // The intrinsic size arrives late; tell CM so the scroll position is right.
      img.addEventListener('load', () => view.requestMeasure())
      /*
       * A picture this browser cannot decode — a TIFF outside Safari, a HEIC
       * outside Apple's — is not a broken embed, it is a file with no preview
       * on this device. It gets the card every other unshowable file gets, so
       * it can still be named, sized and opened.
       */
      img.addEventListener('error', () => this.replaceWithCard(wrap, view))
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
      // A container the browser has no codec for — .avi, .mkv on most of them.
      v.addEventListener('error', () => this.replaceWithCard(wrap, view))
      wrap.appendChild(v)
      if (path) wrap.appendChild(this.resizeHandle(view, v))
      return wrap
    }

    if (kind === 'audio') {
      const a = document.createElement('audio')
      a.src = src
      a.controls = true
      a.preload = 'metadata'
      // A player is as wide as it is told to be — the width in the markdown, or
      // the default in the theme. It resizes like everything else: a transcript
      // beside a note is worth narrowing, and a set of takes is worth widening.
      if (width) a.style.width = `${width}px`
      a.addEventListener('error', () => this.replaceWithCard(wrap, view))
      wrap.appendChild(a)
      // Below the minimum the controls start dropping buttons, so the drag
      // stops where the player is still a player.
      if (path) wrap.appendChild(this.resizeHandle(view, a, 180))
      return wrap
    }

    if (kind === 'pdf' && src) {
      wrap.appendChild(this.pdfPreview(view, wrap, src))
      if (path) wrap.appendChild(this.resizeHandle(view, wrap.firstElementChild as HTMLElement))
      return wrap
    }

    // Everything else — a spreadsheet, an archive, a font — is a card wearing
    // its own kind's mark, which opens the file.
    wrap.appendChild(this.fileCard())
    return wrap
  }

  /** Open what this embed points at: the viewer for a vault file, a tab for a URL. */
  private open() {
    const { path, href } = this.spec
    if (path) requestLightbox(path)
    else if (href) window.open(href, '_blank', 'noopener')
  }

  /** The card an unshowable file gets: its mark, its name, its type and size. */
  private fileCard(): HTMLElement {
    const { path, label } = this.spec
    const f = path ? getRaw(path) : undefined
    const type = path ? fileTypeLabel(path) : 'LINK'
    return card(
      label,
      f ? `${type} · ${formatBytes(f.size)}` : type,
      path ? fileIconSvg(path) : familyIconSvg('other'),
      () => this.open(),
    )
  }

  /**
   * Swap a player, a picture or a page the browser could not draw for the card
   * it would have had. The height changes, so CodeMirror is told to re-measure.
   */
  private replaceWithCard(wrap: HTMLElement, view: EditorView) {
    wrap.textContent = ''
    wrap.appendChild(this.fileCard())
    view.requestMeasure()
  }

  /**
   * The first page of a PDF, drawn into the note.
   *
   * A PDF used to be a card here, which is the one attachment where that hurt:
   * a note pointing at four scanned invoices showed four identical rectangles,
   * and the only way to tell them apart was to open each one. So the page is
   * drawn — by pdf.js, the same library the full viewer uses and the same
   * reasoning behind it (see `ui/PdfView.tsx`: an `<iframe>` gives a still
   * picture on iOS and nothing at all on Android Chrome).
   *
   * Only the first page, only once it is near the screen, and only at the width
   * it is shown at: a note is a page of contents, not a reader. Clicking it
   * opens the real viewer, where all of the pages are.
   */
  private pdfPreview(view: EditorView, wrap: HTMLElement, src: string): HTMLElement {
    const { label, width } = this.spec
    const box = document.createElement('div')
    box.className = 'cm-embed-pdf'
    if (width) box.style.width = `${width}px`

    const canvas = document.createElement('canvas')
    canvas.className = 'cm-embed-pdf-page'
    box.appendChild(canvas)

    const foot = document.createElement('div')
    foot.className = 'cm-embed-pdf-foot'
    foot.innerHTML = familyIconSvg('pdf', 15)
    const name = document.createElement('span')
    name.className = 'cm-embed-pdf-name'
    name.textContent = basename(label)
    const meta = document.createElement('span')
    meta.className = 'cm-embed-pdf-meta'
    const f = this.spec.path ? getRaw(this.spec.path) : undefined
    meta.textContent = f ? formatBytes(f.size) : 'PDF'
    foot.append(name, meta)
    box.appendChild(foot)
    box.addEventListener('click', () => this.open())

    const draw = async () => {
      const lib = await pdfLibrary()
      if (this.gone) return
      const task = lib.getDocument({ url: src, wasmUrl: pdfAsset() })
      // Takes the worker, the document and the page proxy with it when the
      // widget goes — a note scrolled past should not keep a PDF open.
      this.onGone(() => void task.destroy())
      const doc = await task.promise
      const page = await doc.getPage(1)
      if (this.gone) return
      const unit = page.getViewport({ scale: 1 })
      /*
       * Drawn at the width it is displayed at, times the screen's pixel ratio
       * and no more than twice — a full-page scan at 3x on a phone is fifteen
       * megabytes of canvas for a thumbnail nobody is reading yet.
       */
      const css = Math.min(900, box.clientWidth || width || PDF_WIDTH)
      const viewport = page.getViewport({
        scale: (css * Math.min(2, devicePixelRatio || 1)) / unit.width,
      })
      canvas.width = Math.max(1, Math.round(viewport.width))
      canvas.height = Math.max(1, Math.round(viewport.height))
      canvas.style.aspectRatio = `${unit.width} / ${unit.height}`
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no 2d context')
      await page.render({ canvas, canvasContext: ctx, viewport }).promise
      if (this.gone) return
      meta.textContent = `${doc.numPages} page${doc.numPages === 1 ? '' : 's'}${
        f ? ` · ${formatBytes(f.size)}` : ''
      }`
      // The page has a height now, so the lines below it are where they belong.
      view.requestMeasure()
    }

    const start = () => {
      void draw().catch((e) => {
        if (this.gone) return
        console.warn('PDF preview failed', e)
        this.replaceWithCard(wrap, view)
      })
    }

    // Near the screen, not merely in the note: a note holding a dozen PDFs
    // should cost one document, not a dozen.
    if (typeof IntersectionObserver === 'function') {
      const io = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return
          io.disconnect()
          start()
        },
        { rootMargin: '300px' },
      )
      io.observe(box)
      this.onGone(() => io.disconnect())
    } else {
      start()
    }
    return box
  }

  /**
   * Drag-to-resize. The live width is applied to the element during the drag
   * for immediate feedback, then written back into the markdown once on
   * release — so a resize is one undoable edit, not one per mouse move.
   */
  private resizeHandle(view: EditorView, target: HTMLElement, min = 80): HTMLElement {
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
        next = Math.round(Math.min(maxW, Math.max(min, startW + (ev.clientX - startX))))
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

/**
 * The card an embed falls back to. `icon` is markup from `core/filetypes.ts` —
 * static, and never built out of anything in the note.
 */
function card(title: string, sub: string, icon: string, onClick: () => void): HTMLElement {
  const el = document.createElement('div')
  el.className = 'cm-embed-card'
  el.innerHTML = icon
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

  // Balanced parentheses belong to the address — a `$(client)` in one included.
  const md = new RegExp(String.raw`!\[([^\]\n]*)\]\((${MD_URL})\)`, 'g')
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
