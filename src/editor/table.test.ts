/**
 * The table grid.
 *
 * The file always holds a plain GFM pipe table, so every one of these asserts
 * on the markdown that comes out — that is what another editor will open.
 */

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import {
  afterMove,
  blankTable,
  deleteColumn,
  deleteRow,
  insertColumn,
  insertRow,
  isDelimiterRow,
  moveColumn,
  moveRow,
  parseTable,
  renderTable,
  setAlign,
  tableAt,
} from './table'

const SRC = ['| Day | Plan   |', '| --- | ------ |', '| Fri | Arrive |', '| Sat | Belém  |'].join(
  '\n',
)

describe('parsing', () => {
  it('reads the header, the body and the alignment', () => {
    const t = parseTable(SRC)!
    expect(t.rows).toEqual([
      ['Day', 'Plan'],
      ['Fri', 'Arrive'],
      ['Sat', 'Belém'],
    ])
    expect(t.align).toEqual(['', ''])
  })

  it('keeps alignment through a round trip', () => {
    const t = parseTable('| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |')!
    expect(t.align).toEqual(['left', 'center', 'right'])
    const out = renderTable(t)
    expect(out.split('\n')[1]).toBe('| :-- | :-: | --: |')
    expect(parseTable(out)!.align).toEqual(['left', 'center', 'right'])
  })

  it('pads a short row and drops the overflow from a long one', () => {
    const t = parseTable('| a | b |\n| --- | --- |\n| 1 |\n| 1 | 2 | 3 |')!
    expect(t.rows).toEqual([
      ['a', 'b'],
      ['1', ''],
      ['1', '2'],
    ])
  })

  it('accepts a delimiter row with trailing whitespace, as GFM does', () => {
    expect(isDelimiterRow('| --- | --- |   ')).toBe(true)
    expect(isDelimiterRow('| not | a delimiter |')).toBe(false)
  })
})

describe('editing', () => {
  const t = parseTable(SRC)!

  it('adds a row without disturbing the header', () => {
    // Row 0 is the header; asking to insert "above" it puts the row below.
    expect(renderTable(insertRow(t, 0)).split('\n')[0]).toBe('| Day | Plan   |')
    const below = renderTable(insertRow(t, 2))
    expect(below.split('\n')).toEqual([
      '| Day | Plan   |',
      '| --- | ------ |',
      '| Fri | Arrive |',
      '|     |        |',
      '| Sat | Belém  |',
    ])
  })

  it('deletes a body row but never the header', () => {
    expect(parseTable(renderTable(deleteRow(t, 1)))!.rows).toEqual([
      ['Day', 'Plan'],
      ['Sat', 'Belém'],
    ])
    expect(deleteRow(t, 0)).toBe(t)
  })

  it('leaves somewhere to type when the last body row goes', () => {
    const one = parseTable('| a |\n| --- |\n| 1 |')!
    expect(parseTable(renderTable(deleteRow(one, 1)))!.rows).toEqual([['a'], ['']])
  })

  it('adds and removes columns across every row', () => {
    const wider = insertColumn(t, 1)
    expect(parseTable(renderTable(wider))!.rows).toEqual([
      ['Day', '', 'Plan'],
      ['Fri', '', 'Arrive'],
      ['Sat', '', 'Belém'],
    ])
    expect(parseTable(renderTable(deleteColumn(wider, 1)))!.rows).toEqual(parseTable(SRC)!.rows)
  })

  it('refuses to delete the only column', () => {
    const one = parseTable('| a |\n| --- |\n| 1 |')!
    expect(deleteColumn(one, 0)).toBe(one)
  })

  /*
   * Alignment is one character at each end of one delimiter cell, and it was
   * the last property of a table that could only be set by typing into a row
   * both rendered modes hide.
   */
  it('sets a column\'s alignment in the delimiter row', () => {
    const t = parseTable(SRC)!
    expect(renderTable(setAlign(t, 1, 'right')).split('\n')[1]).toBe('| --- | -----: |')
    expect(renderTable(setAlign(t, 0, 'center')).split('\n')[1]).toBe('| :-: | ------ |')
    expect(renderTable(setAlign(t, 0, 'left')).split('\n')[1]).toBe('| :-- | ------ |')
  })

  it('clears an alignment back to plain dashes', () => {
    const t = parseTable('| A | B |\n| :-: | --: |\n| 1 | 2 |')!
    expect(t.align).toEqual(['center', 'right'])
    const out = renderTable(setAlign(setAlign(t, 0, ''), 1, ''))
    expect(out.split('\n')[1]).toBe('| --- | --- |')
  })

  it('changes nothing but the alignment, and only for a column that exists', () => {
    const t = parseTable(SRC)!
    expect(renderTable(setAlign(t, 1, 'center')).split('\n')[0]).toBe('| Day | Plan   |')
    expect(setAlign(t, 5, 'right')).toBe(t)
    expect(setAlign(t, -1, 'right')).toBe(t)
  })

  /*
   * Reordering, which is what the handles on a rendered table drag. `to` is
   * where the band ends up in the finished grid — drop a row on the row it
   * should take the place of — so a move down and the same move back up are
   * the same two indices swapped.
   */
  it('moves a body row to where it was dropped', () => {
    expect(parseTable(renderTable(moveRow(t, 1, 2)))!.rows).toEqual([
      ['Day', 'Plan'],
      ['Sat', 'Belém'],
      ['Fri', 'Arrive'],
    ])
    expect(renderTable(moveRow(moveRow(t, 1, 2), 2, 1))).toBe(renderTable(t))
  })

  it('keeps the header out of it, whichever end the drag came from', () => {
    expect(moveRow(t, 0, 2)).toBe(t)
    // Dropped above the header, a row lands in the first body position.
    expect(parseTable(renderTable(moveRow(t, 2, 0)))!.rows[1]).toEqual(['Sat', 'Belém'])
    expect(moveRow(t, 1, 1)).toBe(t)
    expect(moveRow(t, 9, 1)).toBe(t)
  })

  it('moves a column with its alignment', () => {
    const a = parseTable('| A | B | C |\n| :-- | --: | :-: |\n| 1 | 2 | 3 |')!
    const moved = moveColumn(a, 0, 2)
    expect(moved.rows).toEqual([
      ['B', 'C', 'A'],
      ['2', '3', '1'],
    ])
    expect(moved.align).toEqual(['right', 'center', 'left'])
    expect(renderTable(moved).split('\n')[1]).toBe('| --: | :-: | :-- |')
    expect(moveColumn(a, 1, 1)).toBe(a)
    expect(moveColumn(a, 3, 0)).toBe(a)
  })

  it('follows an index through a move, so the cell in hand stays in hand', () => {
    // The thing moved, the ones it passed, and the ones it never reached.
    expect(afterMove(1, 1, 3)).toBe(3)
    expect(afterMove(2, 1, 3)).toBe(1)
    expect(afterMove(3, 1, 3)).toBe(2)
    expect(afterMove(4, 1, 3)).toBe(4)
    expect(afterMove(1, 3, 1)).toBe(2)
    expect(afterMove(0, 3, 1)).toBe(0)
  })

  it('renders a blank table that parses back', () => {
    const out = renderTable(blankTable(3, 2))
    expect(out.split('\n')).toHaveLength(4)
    expect(parseTable(out)!.align).toHaveLength(3)
  })
})

describe('finding the table under the caret', () => {
  const doc = `Notes\n\n${SRC}\n\nAfter`
  const at = (offset: number) => tableAt(EditorState.create({ doc }), offset)

  it('reports the row and column the caret is in', () => {
    const start = doc.indexOf('| Fri')
    const cur = at(start + 2)!
    expect(cur.row).toBe(1)
    expect(cur.col).toBe(0)
    expect(at(doc.indexOf('Arrive'))!.col).toBe(1)
    // The delimiter row belongs to the header as far as editing goes.
    expect(at(doc.indexOf('| ---') + 2)!.row).toBe(0)
  })

  it('finds nothing outside a table', () => {
    expect(at(1)).toBeUndefined()
    expect(at(doc.indexOf('After'))).toBeUndefined()
  })

  it('is not fooled by a paragraph containing a pipe', () => {
    const s = EditorState.create({ doc: 'a | b\nc | d' })
    expect(tableAt(s, 2)).toBeUndefined()
  })
})
