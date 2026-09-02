/**
 * Tables, as an editable structure rather than a wall of pipes.
 *
 * The file still holds an ordinary GFM pipe table — nothing here changes what
 * gets written — but "add a column" should not mean retyping every row by
 * hand, on a phone least of all. So the table under the caret is parsed into a
 * grid, the operation is applied to the grid, and the grid is written back with
 * its columns lined up.
 *
 * The parsing rules deliberately match the ones the renderer uses: a header
 * row, a delimiter row with the same number of cells, then every following line
 * that still contains a pipe. @lezer/markdown is stricter than GFM about
 * trailing whitespace and drops tables that are perfectly legal, which is why
 * neither this nor the renderer asks it.
 */

import { computed, signal } from '@preact/signals'
import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

export type Align = '' | 'left' | 'center' | 'right'

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

export interface TableModel {
  /** Row 0 is the header; the delimiter row is not stored, it is derived. */
  rows: string[][]
  align: Align[]
}

/* ------------------------------------------------------------ parse/print */

/** Split a pipe-table row, honouring `\|` escapes. */
export function splitRow(line: string): string[] {
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

export function alignOf(spec: string): Align {
  const s = spec.trim()
  if (s.startsWith(':') && s.endsWith(':')) return 'center'
  if (s.endsWith(':')) return 'right'
  if (s.startsWith(':')) return 'left'
  return ''
}

function delimCell(a: Align, width: number): string {
  const bar = '-'.repeat(Math.max(3, width))
  if (a === 'center') return `:${bar.slice(2)}:`
  if (a === 'right') return `${bar.slice(1)}:`
  if (a === 'left') return `:${bar.slice(1)}`
  return bar
}

export function parseTable(src: string): TableModel | undefined {
  const lines = src.split('\n')
  const delimIndex = lines.findIndex(isDelimiterRow)
  if (delimIndex < 1) return undefined
  const align = splitRow(lines[delimIndex]).map(alignOf)
  const columns = align.length
  const rows = lines
    .filter((_, i) => i !== delimIndex)
    .map((l) => {
      const cells = splitRow(l).map((c) => c.trim())
      // GFM pads short rows and drops the overflow from long ones.
      while (cells.length < columns) cells.push('')
      return cells.slice(0, columns)
    })
  return { rows, align }
}

/**
 * Print the grid back as markdown, padding every column to its widest cell.
 *
 * The padding is not decoration: a table you may end up editing as text should
 * be readable as text, and a column that lines up is the difference between
 * "I can fix this by hand" and "I have to count pipes".
 */
export function renderTable(t: TableModel): string {
  const columns = t.align.length
  const width: number[] = []
  for (let c = 0; c < columns; c++) {
    width[c] = Math.max(3, ...t.rows.map((r) => (r[c] ?? '').length))
  }
  const line = (cells: string[]) =>
    `| ${cells.map((cell, c) => cell.padEnd(width[c])).join(' | ')} |`

  const out = [line(t.rows[0] ?? [])]
  out.push(`| ${t.align.map((a, c) => delimCell(a, width[c])).join(' | ')} |`)
  for (let r = 1; r < t.rows.length; r++) out.push(line(t.rows[r]))
  return out.join('\n')
}

/* ---------------------------------------------------------------- editing */

const empty = (n: number) => Array.from({ length: n }, () => '')

/** Insert a blank row. `at` is a row index; row 0 is the header. */
export function insertRow(t: TableModel, at: number): TableModel {
  // Nothing goes above the header — a table without one is not a GFM table.
  const index = Math.min(Math.max(at, 1), t.rows.length)
  const rows = [...t.rows]
  rows.splice(index, 0, empty(t.align.length))
  return { ...t, rows }
}

/**
 * Delete a row. The header stays: deleting it would silently promote a data
 * row into a header, which is never what "delete this row" meant.
 */
export function deleteRow(t: TableModel, at: number): TableModel {
  if (at < 1 || at >= t.rows.length) return t
  const rows = [...t.rows]
  rows.splice(at, 1)
  // A header and nothing else is a legal table; keep one empty body row so
  // there is somewhere to type.
  if (rows.length === 1) rows.push(empty(t.align.length))
  return { ...t, rows }
}

export function insertColumn(t: TableModel, at: number): TableModel {
  const index = Math.min(Math.max(at, 0), t.align.length)
  const align = [...t.align]
  align.splice(index, 0, '')
  return {
    align,
    rows: t.rows.map((r) => {
      const next = [...r]
      next.splice(index, 0, '')
      return next
    }),
  }
}

export function deleteColumn(t: TableModel, at: number): TableModel {
  if (t.align.length <= 1 || at < 0 || at >= t.align.length) return t
  const align = [...t.align]
  align.splice(at, 1)
  return {
    align,
    rows: t.rows.map((r) => {
      const next = [...r]
      next.splice(at, 1)
      return next
    }),
  }
}

/**
 * A cell as it reads, and as it is stored.
 *
 * The only difference is the pipe: a literal one has to be escaped in the
 * source or it would end the cell, and nobody wants to type `\|` by hand.
 */
export function cellText(stored: string): string {
  return stored.replace(/\\\|/g, '|')
}

export function cellSource(text: string): string {
  // Newlines cannot survive in a pipe table; a pasted one becomes a space.
  return text.replace(/\s*\n+\s*/g, ' ').replace(/\|/g, '\\|').trim()
}

/** A fresh table, sized in *body* rows — the header is always there. */
export function blankTable(columns = 3, bodyRows = 2): TableModel {
  return {
    align: empty(columns).map(() => '' as Align),
    rows: [empty(columns), ...Array.from({ length: bodyRows }, () => empty(columns))],
  }
}

/* ------------------------------------------------------- editor integration */

/**
 * The cell being typed in, when a rendered table has focus.
 *
 * A cell is a contenteditable inside a widget, so the editor's own selection is
 * nowhere near the table — CodeMirror does not even consider itself focused.
 * The toolbar still has to know which row and column its buttons would act on,
 * so the widget publishes it here.
 */
export const focusedCell = signal<{
  from: number
  source: string
  row: number
  col: number
} | null>(null)

/**
 * Which cell the next render of a table should focus.
 *
 * Every edit rewrites the whole table block, which throws the widget's DOM away
 * and builds a new one — so "keep typing in the next cell" has to be a request
 * the new DOM picks up, not a DOM reference held across the change.
 */
let pendingFocus: { from: number; row: number; col: number } | null = null

export function requestCellFocus(from: number, row: number, col: number): void {
  pendingFocus = { from, row, col }
}

export function takeCellFocus(from: number): { row: number; col: number } | null {
  if (!pendingFocus || pendingFocus.from !== from) return null
  const { row, col } = pendingFocus
  pendingFocus = null
  return { row, col }
}

export interface TableCursor {
  /** Document offsets of the whole table block. */
  from: number
  to: number
  fromLine: number
  toLine: number
  model: TableModel
  /** Row index in the model (0 = header), and column index. */
  row: number
  col: number
}

/**
 * The table the caret is in, with where in it the caret is.
 *
 * Scans outward from the caret's line rather than over the whole document:
 * this runs on every selection change to drive the toolbar.
 */
export function tableAt(state: EditorState, pos: number): TableCursor | undefined {
  const caretLine = state.doc.lineAt(pos).number
  const total = state.doc.lines
  const has = (n: number) => n >= 1 && n <= total && state.doc.line(n).text.includes('|')
  if (!has(caretLine)) return undefined

  let first = caretLine
  while (first > 1 && has(first - 1)) first--
  let last = caretLine
  while (last < total && has(last + 1)) last++
  if (last - first < 1) return undefined

  const lines: string[] = []
  for (let n = first; n <= last; n++) lines.push(state.doc.line(n).text)
  const delimIndex = lines.findIndex(isDelimiterRow)
  // The delimiter has to be the second line of the block for this to be a
  // table at all; anything else is prose that happens to contain pipes.
  if (delimIndex !== 1) return undefined

  const model = parseTable(lines.join('\n'))
  if (!model) return undefined

  const visualRow = caretLine - first
  const row = visualRow === delimIndex ? 0 : visualRow > delimIndex ? visualRow - 1 : visualRow
  const line = state.doc.line(caretLine)
  const before = line.text.slice(0, Math.max(0, pos - line.from))
  // Column = pipes to the left of the caret, minus the leading one.
  let pipes = 0
  for (let i = 0; i < before.length; i++) {
    if (before[i] === '\\') {
      i++
      continue
    }
    if (before[i] === '|') pipes++
  }
  const col = Math.min(Math.max(pipes - 1, 0), model.align.length - 1)

  return {
    from: state.doc.line(first).from,
    to: state.doc.line(last).to,
    fromLine: first,
    toLine: last,
    model,
    row,
    col,
  }
}

/**
 * The same cursor, derived from the focused cell rather than the caret.
 *
 * Verified against the document before it is trusted: the widget could be a
 * render behind an edit made somewhere else, and rewriting a stale range would
 * corrupt the note.
 */
export function focusedCellCursor(state: EditorState): TableCursor | undefined {
  const c = focusedCell.value
  if (!c) return undefined
  const to = c.from + c.source.length
  if (to > state.doc.length || state.doc.sliceString(c.from, to) !== c.source) return undefined
  const model = parseTable(c.source)
  if (!model) return undefined
  const fromLine = state.doc.lineAt(c.from).number
  return {
    from: c.from,
    to,
    fromLine,
    toLine: fromLine + c.source.split('\n').length - 1,
    model,
    row: Math.min(c.row, model.rows.length - 1),
    col: Math.min(c.col, model.align.length - 1),
  }
}

/** What the toolbar shows when the caret is nowhere near the table's source. */
export const tableContext = computed(() => {
  const c = focusedCell.value
  if (!c) return null
  const m = parseTable(c.source)
  if (!m) return null
  return {
    row: Math.min(c.row, m.rows.length - 1),
    col: Math.min(c.col, m.align.length - 1),
    rows: m.rows.length,
    cols: m.align.length,
  }
})

/** Replace the table under the caret with a transformed one. */
function rewrite(next: TableModel, cur: TableCursor): TransactionSpec {
  const insert = renderTable(next)
  return {
    changes: { from: cur.from, to: cur.to, insert },
    // Land the caret in the first cell so typing continues in the table
    // rather than somewhere unpredictable in the rewritten text.
    selection: EditorSelection.cursor(Math.min(cur.from + 2, cur.from + insert.length)),
    userEvent: 'input.format',
  }
}

export type TableOp =
  | 'row-above'
  | 'row-below'
  | 'row-delete'
  | 'col-left'
  | 'col-right'
  | 'col-delete'
  | 'delete'

export function applyTableOp(view: EditorView, op: TableOp): boolean {
  // The caret first, then the cell the user is typing in: in rich text the
  // table never shows its source, so the caret is never inside it.
  const inCell = !!focusedCell.value
  const cur = tableAt(view.state, view.state.selection.main.head) ?? focusedCellCursor(view.state)
  if (!cur) return false

  /*
   * A cell that still has focus has text the note has not seen yet — pressing
   * a toolbar button is not the same as leaving the cell. Take it now, or the
   * rewrite would quietly discard whatever was just typed.
   */
  const active = typeof document !== 'undefined' ? document.activeElement : null
  if (inCell && active instanceof HTMLElement && active.classList.contains('cm-table-cell')) {
    const r = Number(active.dataset.row)
    const c = Number(active.dataset.col)
    if (r === cur.row && c === cur.col && cur.model.rows[r]) {
      cur.model.rows[r][c] = cellSource(active.textContent ?? '')
    }
  }

  if (op === 'delete') {
    // Take the newline with it, so deleting a table doesn't leave a hole.
    const to = Math.min(cur.to + 1, view.state.doc.length)
    view.dispatch({
      changes: { from: cur.from, to, insert: '' },
      selection: EditorSelection.cursor(cur.from),
      userEvent: 'delete',
    })
    view.focus()
    return true
  }

  const next =
    op === 'row-above'
      ? insertRow(cur.model, cur.row)
      : op === 'row-below'
        ? insertRow(cur.model, cur.row + 1)
        : op === 'row-delete'
          ? deleteRow(cur.model, cur.row)
          : op === 'col-left'
            ? insertColumn(cur.model, cur.col)
            : op === 'col-right'
              ? insertColumn(cur.model, cur.col + 1)
              : deleteColumn(cur.model, cur.col)

  // Where typing should carry on once the table is rewritten.
  if (inCell) {
    const rows = next.rows.length
    const cols = next.align.length
    const at: Record<Exclude<TableOp, 'delete'>, [number, number]> = {
      'row-above': [Math.max(cur.row, 1), cur.col],
      'row-below': [cur.row + 1, cur.col],
      'row-delete': [Math.min(cur.row, rows - 1), cur.col],
      'col-left': [cur.row, cur.col],
      'col-right': [cur.row, cur.col + 1],
      'col-delete': [cur.row, Math.min(cur.col, cols - 1)],
    }
    const [row, col] = at[op]
    requestCellFocus(cur.from, Math.min(row, rows - 1), Math.min(col, cols - 1))
  }

  view.dispatch(rewrite(next, cur))
  if (!inCell) view.focus()
  return true
}

/**
 * Drop a new table in at the caret.
 *
 * It goes on its own lines: a pipe table inside a paragraph is not a table in
 * any renderer, so inserting one mid-line would produce literal pipes.
 */
export function insertTable(view: EditorView, columns = 3, bodyRows = 2): boolean {
  const { state } = view
  const range = state.selection.main
  const line = state.doc.lineAt(range.from)
  const before = line.text.slice(0, range.from - line.from).trim()
  const after = line.text.slice(range.from - line.from).trim()

  const table = renderTable(blankTable(columns, bodyRows))
  const lead = before ? '\n\n' : line.from === range.from ? '' : '\n'
  const trail = after ? '\n\n' : '\n'
  const insert = `${lead}${table}${trail}`
  // Caret into the first header cell.
  const caret = range.from + lead.length + 2

  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: EditorSelection.cursor(caret),
    userEvent: 'input.format',
    scrollIntoView: true,
  })
  view.focus()
  return true
}
