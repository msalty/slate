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
import { formatBytes, mediaClass } from '../core/util'
import { requestLightbox } from './context'

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

/* ------------------------------------------------------------------ table */

/**
 * Renders a GFM pipe table as a real HTML table.
 *
 * Cell content goes through the inline renderer, so **bold**, `code`, links and
 * wikilinks inside a cell render like they do anywhere else — CodeMirror's own
 * decorations can't reach text that lives inside a widget, so without this a
 * cell would show its markdown literally.
 *
 * Editing happens in the source: clicking the widget drops the caret into the
 * markdown at roughly the cell that was clicked, which reveals the pipes again.
 * That keeps the round-trip exact — the file always holds the pipe table the
 * user typed — while the resting state looks like a table.
 */
export class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly from: number,
    readonly notePath: string,
  ) {
    super()
  }

  eq(other: TableWidget) {
    return other.source === this.source && other.notePath === this.notePath
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-table-wrap'
    wrap.setAttribute('contenteditable', 'false')

    const rows = this.source.split('\n')
    const cells = rows.map(splitRow)
    const delimIndex = rows.findIndex(isDelimiterRow)
    const align = delimIndex >= 0 ? cells[delimIndex].map(alignOf) : []
    // GFM pads or truncates every row to the header's column count.
    const columns = delimIndex >= 0 ? cells[delimIndex].length : (cells[0]?.length ?? 0)

    const table = document.createElement('table')
    table.className = 'cm-table-render'
    const thead = document.createElement('thead')
    const tbody = document.createElement('tbody')

    rows.forEach((_, r) => {
      if (r === delimIndex) return
      const tr = document.createElement('tr')
      for (let c = 0; c < columns; c++) {
        const cell = document.createElement(delimIndex >= 0 && r < delimIndex ? 'th' : 'td')
        const text = (cells[r][c] ?? '').trim()
        if (text) cell.appendChild(renderInline(text, this.notePath))
        if (align[c]) cell.style.textAlign = align[c]
        tr.appendChild(cell)
      }
      ;(delimIndex >= 0 && r < delimIndex ? thead : tbody).appendChild(tr)
    })

    if (thead.childNodes.length) table.appendChild(thead)
    table.appendChild(tbody)
    wrap.appendChild(table)

    wrap.addEventListener('mousedown', (e) => {
      // Links, tags and images inside a cell keep their own behaviour; only a
      // click on the table itself moves the caret into the source.
      const target = e.target as HTMLElement | null
      if (target?.closest('[data-wikilink], [data-tag], a, img')) return

      e.preventDefault()
      const tr = target?.closest('tr')
      let offset = 0
      if (tr) {
        const all = [...wrap.querySelectorAll('tr')]
        const visualRow = all.indexOf(tr)
        const sourceRow =
          delimIndex >= 0 && visualRow >= delimIndex ? visualRow + 1 : visualRow
        for (let i = 0; i < sourceRow && i < rows.length; i++) offset += rows[i].length + 1
      }
      const pos = Math.min(this.from + offset, view.state.doc.length)
      // Tagged as a pointer selection so live preview counts it as the user
      // choosing to edit — an untagged dispatch would leave the table rendered
      // and the caret invisible behind it.
      view.dispatch({
        selection: { anchor: pos },
        scrollIntoView: false,
        userEvent: 'select.pointer',
      })
      view.focus()
    })

    return wrap
  }

  ignoreEvent() {
    return false
  }
}

/**
 * Is this the `| --- | :--: |` row?
 *
 * Written by hand rather than taken from the markdown parser because
 * @lezer/markdown refuses a delimiter row with *any* trailing whitespace, which
 * silently makes the whole table parse as paragraph text. Trailing spaces are
 * legal per GFM and extremely common in real files, so table detection here
 * does not depend on that.
 */
export function isDelimiterRow(line: string): boolean {
  const t = line.trim()
  if (!t || !/^[|\s:-]+$/.test(t)) return false
  const cells = splitRow(line)
  if (!cells.length) return false
  return cells.every((c) => /^\s*:?-+:?\s*$/.test(c))
}

/** Split a pipe-table row, honouring `\|` escapes. */
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const out: string[] = []
  let cur = ''
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (ch === '\\' && trimmed[i + 1] === '|') {
      cur += '\\|'
      i++
    } else if (ch === '|') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

function alignOf(spec: string): 'left' | 'right' | 'center' | '' {
  const s = spec.trim()
  if (s.startsWith(':') && s.endsWith(':')) return 'center'
  if (s.endsWith(':')) return 'right'
  if (s.startsWith(':')) return 'left'
  return ''
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
