/**
 * Spreadsheet paste.
 *
 * The assertions are on the markdown that comes out, for the same reason
 * table.test.ts is: that text is the file, and it is what another editor opens.
 */

import { describe, expect, it } from 'vitest'
import { gridToHtml, looksLikeGrid, parseDelimited, tableFromGrid } from './tsv'
import { renderTable, tableRowsInSelection } from './table'
import { EditorState } from '@codemirror/state'

const md = (clipboard: string) => renderTable(tableFromGrid(parseDelimited(clipboard)))

describe('parsing the tab-separated flavour', () => {
  it('reads a plain grid', () => {
    expect(parseDelimited('a\tb\nc\td')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('handles the CRLF that Excel on Windows writes', () => {
    expect(parseDelimited('a\tb\r\nc\td\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('drops the empty row a trailing line break leaves behind', () => {
    expect(parseDelimited('a\tb\n')).toEqual([['a', 'b']])
  })

  it('keeps empty cells in the middle of a row', () => {
    expect(parseDelimited('a\t\tc')).toEqual([['a', '', 'c']])
  })

  /*
   * The quoting rules the spreadsheets actually emit: a cell holding a tab, a
   * line break or a quote comes across wrapped, with inner quotes doubled.
   */
  it('unwraps a quoted cell', () => {
    expect(parseDelimited('"plain"\tb')).toEqual([['plain', 'b']])
  })

  it('keeps a tab that was inside a quoted cell', () => {
    expect(parseDelimited('"a\tb"\tc')).toEqual([['a\tb', 'c']])
  })

  it('keeps a newline that was inside a quoted cell', () => {
    expect(parseDelimited('"line one\nline two"\tb')).toEqual([['line one\nline two', 'b']])
  })

  it('reads a doubled quote as one literal quote', () => {
    expect(parseDelimited('"she said ""no"""\tb')).toEqual([['she said "no"', 'b']])
  })

  it('leaves a quote in the middle of a cell alone', () => {
    // A 5" pipe is not the start of a quoted field.
    expect(parseDelimited('5" pipe\tb')).toEqual([['5" pipe', 'b']])
  })
})

describe('what counts as a grid', () => {
  it('takes anything two columns wide', () => {
    expect(looksLikeGrid(parseDelimited('a\tb'))).toBe(true)
  })

  /*
   * One column is a list of lines. Turning it into a one-column table would be
   * a worse guess than leaving the paste alone.
   */
  it('refuses a single column', () => {
    expect(looksLikeGrid(parseDelimited('a\nb\nc'))).toBe(false)
    expect(looksLikeGrid(parseDelimited(''))).toBe(false)
  })

  it('takes a ragged selection — the short rows get padded', () => {
    expect(looksLikeGrid(parseDelimited('a\tb\tc\nd'))).toBe(true)
    expect(tableFromGrid(parseDelimited('a\tb\tc\nd')).rows[1]).toEqual(['d', '', ''])
  })
})

describe('the markdown it produces', () => {
  it('makes the first row the header and lines the columns up', () => {
    expect(md('Region\tQ3\nEMEA\t1200\nAPAC\t980')).toBe(
      ['| Region | Q3   |', '| ------ | ---- |', '| EMEA   | 1200 |', '| APAC   | 980  |'].join('\n'),
    )
  })

  /*
   * Neither of these can survive in a pipe table, and both turn up in real
   * spreadsheets — a pipe would end the cell, and a row is one line.
   */
  it('escapes a literal pipe so it cannot end the cell', () => {
    expect(md('a|b\tc')).toContain('a\\|b')
  })

  it('flattens a multi-line cell into one line', () => {
    expect(md('"one\ntwo"\tc').split('\n')).toHaveLength(2)
    expect(md('"one\ntwo"\tc')).toContain('one two')
  })

  it('survives a header-only paste', () => {
    expect(md('a\tb')).toBe(['| a   | b   |', '| --- | --- |'].join('\n'))
  })
})

/* ------------------------------------------------------------ going back */

const TABLE = [
  '| Region | Q3   |',
  '| ------ | ---- |',
  '| EMEA   | 1200 |',
  '| APAC   | 980  |',
].join('\n')

/** A selection over `doc`, given the offsets of the text to select. */
function select(doc: string, from: number, to: number) {
  return EditorState.create({ doc, selection: { anchor: from, head: to } })
}

describe('what counts as copying a table', () => {
  const wholeTable = () => select(TABLE, 0, TABLE.length)

  it('reads the rows, and drops the delimiter markdown needs but Excel does not', () => {
    expect(tableRowsInSelection(wholeTable())?.rows).toEqual([
      ['Region', 'Q3'],
      ['EMEA', '1200'],
      ['APAC', '980'],
    ])
  })

  it('knows whether the header came with it', () => {
    expect(tableRowsInSelection(wholeTable())?.hasHeader).toBe(true)
    // From the start of the third line to the end: body rows only.
    const bodyOnly = select(TABLE, TABLE.indexOf('| EMEA'), TABLE.length)
    expect(tableRowsInSelection(bodyOnly)?.hasHeader).toBe(false)
    expect(tableRowsInSelection(bodyOnly)?.rows).toEqual([
      ['EMEA', '1200'],
      ['APAC', '980'],
    ])
  })

  /*
   * Selecting a word in a cell is a request for that word. Turning it into a
   * row of cells would make ordinary copying inside a table unpredictable.
   */
  it('leaves a word inside a cell alone', () => {
    const at = TABLE.indexOf('EMEA')
    expect(tableRowsInSelection(select(TABLE, at, at + 4))).toBeUndefined()
  })

  it('but takes a whole line, even on its own', () => {
    const line = TABLE.indexOf('| EMEA')
    const end = TABLE.indexOf('\n', line)
    expect(tableRowsInSelection(select(TABLE, line, end))?.rows).toEqual([['EMEA', '1200']])
  })

  it('refuses a selection that runs out of the table', () => {
    const doc = `${TABLE}\n\nA paragraph after it.\n`
    expect(tableRowsInSelection(select(doc, 0, doc.length))).toBeUndefined()
  })

  it('refuses text that is not a table at all', () => {
    const doc = 'just | some | prose\nwith pipes in it\n'
    expect(tableRowsInSelection(select(doc, 0, doc.length))).toBeUndefined()
  })

  it('unescapes a pipe that was escaped to survive the markdown', () => {
    const doc = ['| a    | b |', '| ---- | - |', '| x\\|y | z |'].join('\n')
    expect(tableRowsInSelection(select(doc, 0, doc.length))?.rows[1]).toEqual(['x|y', 'z'])
  })

  it('pads a ragged row rather than emitting a lopsided table', () => {
    const doc = ['| a | b |', '| - | - |', '| x |'].join('\n')
    expect(tableRowsInSelection(select(doc, 0, doc.length))?.rows[1]).toEqual(['x', ''])
  })
})

describe('the HTML a spreadsheet reads', () => {
  it('marks the header row up as one when it was included', () => {
    expect(gridToHtml([['A', 'B'], ['1', '2']], true)).toBe(
      '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>',
    )
  })

  it('uses plain cells when it was not', () => {
    expect(gridToHtml([['1', '2']], false)).toBe('<table><tr><td>1</td><td>2</td></tr></table>')
  })

  it('escapes cell text so a note cannot write markup into the clipboard', () => {
    expect(gridToHtml([['<b>&"x"</b>']], false)).toBe(
      '<table><tr><td>&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;</td></tr></table>',
    )
  })
})
