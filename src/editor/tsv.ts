/**
 * Spreadsheet cells on the clipboard, turned into a markdown table.
 *
 * Copying a range in Excel, Numbers, Google Sheets or LibreOffice Calc puts two
 * flavours on the clipboard: a full `<table>` under `text/html`, and the same
 * grid tab-separated under `text/plain`. This uses both, for different jobs:
 *
 *   - The **HTML flavour is only a discriminator.** Its presence is what says
 *     "this came out of a grid" rather than "this is prose that happens to
 *     contain tabs" — a distinction nothing in the plain text can make, and
 *     getting it wrong would turn every tab-indented paste into a table.
 *   - The **plain flavour is what gets parsed.** Excel's HTML is a wall of
 *     `mso-` styles and conditional comments, and parsing it would mean
 *     trusting markup from outside the app; the tab-separated form carries the
 *     same cells with none of that.
 *
 * Quoting follows the RFC 4180 rules the spreadsheets actually emit: a cell
 * containing a tab, a newline or a quote is wrapped in double quotes, and a
 * literal quote inside one is doubled.
 */

import { type Align, cellSource, type TableModel } from './table'

/**
 * Split delimited text into a grid, honouring quoted cells.
 *
 * Quoting only starts at the beginning of a cell — that is what the writers
 * produce, and it means a stray quote mid-cell (`5" pipe`) stays literal
 * instead of swallowing the rest of the row.
 */
export function parseDelimited(src: string, delim = '\t'): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let i = 0

  const endCell = () => {
    row.push(cell)
    cell = ''
  }
  const endRow = () => {
    endCell()
    rows.push(row)
    row = []
  }

  while (i < src.length) {
    const ch = src[i]

    if (quoted) {
      if (ch === '"') {
        // A doubled quote is one literal quote; a lone one ends the cell.
        if (src[i + 1] === '"') {
          cell += '"'
          i += 2
        } else {
          quoted = false
          i++
        }
        continue
      }
      cell += ch
      i++
      continue
    }

    if (ch === '"' && cell === '') {
      quoted = true
      i++
      continue
    }
    if (ch === delim) {
      endCell()
      i++
      continue
    }
    if (ch === '\n' || ch === '\r') {
      endRow()
      i += ch === '\r' && src[i + 1] === '\n' ? 2 : 1
      continue
    }
    cell += ch
    i++
  }
  if (cell !== '' || row.length) endRow()

  // Writers end the last row with a line break; drop the empty row it leaves.
  while (rows.length && rows[rows.length - 1].every((c) => c === '')) rows.pop()
  return rows
}

/**
 * Is this grid worth turning into a table?
 *
 * One column is a list of lines, not a table, and the paste is better left
 * alone. Everything else is let through and padded — a spreadsheet selection
 * with a ragged right edge is still a table.
 */
export function looksLikeGrid(grid: string[][]): boolean {
  return grid.length >= 1 && Math.max(0, ...grid.map((r) => r.length)) >= 2
}

/**
 * Grid to table model. Row 0 becomes the header, because a GFM table has one
 * whether or not the spreadsheet thought of its first row that way.
 *
 * Every cell goes through `cellSource`, which is what escapes a literal pipe
 * and flattens the newlines a multi-line Excel cell carries — neither can
 * survive in a pipe table, and both turn up in real spreadsheets.
 */
export function tableFromGrid(grid: string[][]): TableModel {
  const columns = Math.max(0, ...grid.map((r) => r.length))
  const rows = grid.map((r) => {
    const cells = r.map(cellSource)
    while (cells.length < columns) cells.push('')
    return cells
  })
  return { rows, align: Array.from({ length: columns }, () => '' as Align) }
}
