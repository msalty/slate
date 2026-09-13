// @vitest-environment jsdom
/**
 * The handles on a rendered table: press to pick a band out, press again for
 * its menu, drag to move it.
 *
 * Everything here is asserted against the markdown in the note, because that is
 * what another editor will open — and against the coordinates on the cells,
 * because a drag rearranges the DOM before anything is written and every other
 * part of this reads the table from those.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { createEditorState } from './setup'
import { focusedCell, tableBand } from './table'

const SRC = [
  '| Day | Plan   |',
  '| --- | ------ |',
  '| Fri | Arrive |',
  '| Sat | Belém  |',
  '| Sun | Home   |',
].join('\n')

/** A mounted, focused rich-text editor — the mode switch is the headless route. */
async function editor(doc = SRC): Promise<EditorView> {
  const state = () =>
    createEditorState({ doc, path: 'note.md', mode: 'rich', fontSize: 16, onChange: () => {} })
  const parent = document.body.appendChild(document.createElement('div'))
  const view = new EditorView({ parent, state: state() })
  view.focus()
  view.setState(state())
  await new Promise((r) => setTimeout(r, 0))
  return view
}

const cell = (view: EditorView, row: number, col: number) =>
  view.contentDOM.querySelector<HTMLElement>(`[data-row="${row}"][data-col="${col}"]`)!

const handle = (view: EditorView, axis: 'row' | 'col') =>
  view.contentDOM.querySelector<HTMLButtonElement>(`.cm-table-handle[data-axis="${axis}"]`)!

/** The table as the DOM has it, header first — what the eye sees mid-drag. */
const grid = (view: EditorView) =>
  [...view.contentDOM.querySelectorAll('tr')].map((tr) =>
    [...tr.cells].map((c) => (c.textContent ?? '').trim()),
  )

/** The coordinates the cells carry, which have to keep describing that grid. */
const coords = (view: EditorView) =>
  [...view.contentDOM.querySelectorAll('tr')].map((tr) =>
    [...tr.cells].map((c) => `${(c as HTMLElement).dataset.row},${(c as HTMLElement).dataset.col}`),
  )

/** Focus a cell the way a click would, and let the widget publish it. */
async function enter(view: EditorView, row: number, col: number) {
  cell(view, row, col).focus()
  await new Promise((r) => setTimeout(r, 0))
}

let pointer = 0
function press(el: HTMLElement, type: string, x: number, y: number) {
  const e = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y })
  Object.defineProperty(e, 'pointerId', { value: ++pointer })
  el.dispatchEvent(e)
}

/** A press and release on the same spot: no movement, so not a drag. */
function tap(el: HTMLElement, x = 0, y = 0) {
  press(el, 'pointerdown', x, y)
  press(el, 'pointerup', x, y)
}

beforeEach(() => {
  document.body.innerHTML = ''
  tableBand.value = null
  focusedCell.value = null
  /*
   * jsdom has neither pointer capture nor layout. Both are supplied here rather
   * than guarded against in the source: a browser has them, and code that
   * pretends otherwise would be untested in the shape that actually ships.
   */
  const noop = () => {}
  Object.assign(HTMLElement.prototype, {
    setPointerCapture: noop,
    releasePointerCapture: noop,
    hasPointerCapture: () => false,
  })
  // 20px rows, 60px columns, laid out from the origin — enough for the widget
  // to answer "which band is the pointer over".
  const rows = (el: Element) => [...(el.closest('table')?.querySelectorAll('tr') ?? [])]
  HTMLTableRowElement.prototype.getBoundingClientRect = function () {
    const i = rows(this).indexOf(this)
    return { top: i * 20, bottom: (i + 1) * 20, left: 0, right: 120 } as DOMRect
  }
  HTMLTableCellElement.prototype.getBoundingClientRect = function () {
    const i = [...(this.parentElement as HTMLTableRowElement).cells].indexOf(this)
    return { top: 0, bottom: 20, left: i * 60, right: (i + 1) * 60 } as DOMRect
  }
})

afterEach(() => {
  tableBand.value = null
  focusedCell.value = null
})

describe('the handles beside the cell being worked in', () => {
  it('appear on the row and column of that cell, and name them', async () => {
    const view = await editor()
    expect(handle(view, 'row').hidden).toBe(true)

    await enter(view, 2, 1)
    expect(handle(view, 'row').hidden).toBe(false)
    expect(handle(view, 'row').getAttribute('aria-label')).toBe('Row 3 options')
    expect(handle(view, 'col').getAttribute('aria-label')).toBe('Column 2 options')

    await enter(view, 0, 0)
    expect(handle(view, 'row').getAttribute('aria-label')).toBe('Header row options')
    view.destroy()
  })

  it('picks the band out on the first press and asks for its menu on the second', async () => {
    const view = await editor()
    const asked = vi.fn()
    addEventListener('slate:table-band', asked)
    await enter(view, 2, 0)

    tap(handle(view, 'row'))
    expect(tableBand.value).toEqual({ from: 0, kind: 'row', index: 2 })
    expect(asked).not.toHaveBeenCalled()
    // The whole row is marked, and nothing outside it.
    expect(cell(view, 2, 1).dataset.band).toBe('1')
    expect(cell(view, 1, 1).dataset.band).toBeUndefined()
    expect(handle(view, 'row').getAttribute('aria-pressed')).toBe('true')
    expect(handle(view, 'col').getAttribute('aria-pressed')).toBe('false')

    tap(handle(view, 'row'))
    expect(asked).toHaveBeenCalledTimes(1)
    expect((asked.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ kind: 'row', index: 2 })
    // Asking for the menu does not put the row back: it is what the menu acts on.
    expect(tableBand.value).toEqual({ from: 0, kind: 'row', index: 2 })

    removeEventListener('slate:table-band', asked)
    view.destroy()
  })

  it('picks a column out the same way, on its own handle', async () => {
    const view = await editor()
    await enter(view, 1, 1)
    tap(handle(view, 'col'))
    expect(tableBand.value).toEqual({ from: 0, kind: 'col', index: 1 })
    expect(cell(view, 0, 1).dataset.band).toBe('1')
    expect(cell(view, 0, 0).dataset.band).toBeUndefined()
    view.destroy()
  })

  it('goes away when the note takes the caret back', async () => {
    const view = await editor()
    await enter(view, 1, 0)
    tap(handle(view, 'row'))
    expect(handle(view, 'row').hidden).toBe(false)

    // What the editor publishes when the note itself is typed in again.
    focusedCell.value = null
    tableBand.value = null
    await new Promise((r) => setTimeout(r, 0))
    expect(handle(view, 'row').hidden).toBe(true)
    expect(handle(view, 'col').hidden).toBe(true)
    expect(view.contentDOM.querySelectorAll('[data-band]')).toHaveLength(0)
    view.destroy()
  })

  it('lets go of the band as soon as a cell is typed in again', async () => {
    const view = await editor()
    await enter(view, 1, 0)
    tap(handle(view, 'row'))
    expect(tableBand.value).not.toBeNull()
    await enter(view, 3, 1)
    expect(tableBand.value).toBeNull()
    view.destroy()
  })
})

describe('dragging a handle', () => {
  it('moves the row to where it was dropped, and writes it once', async () => {
    const view = await editor()
    await enter(view, 1, 0)
    const el = handle(view, 'row')

    press(el, 'pointerdown', 0, 30)
    press(el, 'pointermove', 0, 70)
    // The table already shows the answer, and the note has not been touched.
    expect(grid(view)[3]).toEqual(['Fri', 'Arrive'])
    expect(coords(view)[3][0]).toBe('3,0')
    expect(view.state.doc.toString()).toBe(SRC)

    press(el, 'pointerup', 0, 70)
    expect(view.state.doc.toString().split('\n')).toEqual([
      '| Day | Plan   |',
      '| --- | ------ |',
      '| Sat | Belém  |',
      '| Sun | Home   |',
      '| Fri | Arrive |',
    ])
    // The cell being worked in went with the row, and the band with it.
    expect(focusedCell.value).toMatchObject({ row: 3, col: 0 })
    expect(tableBand.value).toMatchObject({ kind: 'row', index: 3 })
    view.destroy()
  })

  it('moves a column, alignment and all', async () => {
    const view = await editor('| A | B |\n| :-- | --: |\n| 1 | 2 |')
    await enter(view, 0, 0)
    const el = handle(view, 'col')
    press(el, 'pointerdown', 10, 0)
    press(el, 'pointermove', 90, 0)
    press(el, 'pointerup', 90, 0)
    expect(view.state.doc.toString().split('\n')).toEqual([
      '| B   | A   |',
      '| --: | :-- |',
      '| 2   | 1   |',
    ])
    expect(focusedCell.value).toMatchObject({ row: 0, col: 1 })
    view.destroy()
  })

  it('leaves the header where it is', async () => {
    const view = await editor()
    await enter(view, 0, 0)
    const el = handle(view, 'row')
    press(el, 'pointerdown', 0, 10)
    press(el, 'pointermove', 0, 70)
    press(el, 'pointerup', 0, 70)
    expect(view.state.doc.toString()).toBe(SRC)
    view.destroy()
  })

  it('writes nothing when the row is dropped where it started', async () => {
    const view = await editor()
    await enter(view, 2, 0)
    const el = handle(view, 'row')
    press(el, 'pointerdown', 0, 50)
    press(el, 'pointermove', 0, 70)
    press(el, 'pointermove', 0, 50)
    press(el, 'pointerup', 0, 50)
    expect(view.state.doc.toString()).toBe(SRC)
    expect(grid(view)[2]).toEqual(['Sat', 'Belém'])
    view.destroy()
  })

  it('puts the table back when the drag is cancelled', async () => {
    const view = await editor()
    await enter(view, 1, 0)
    const el = handle(view, 'row')
    press(el, 'pointerdown', 0, 30)
    press(el, 'pointermove', 0, 70)
    expect(grid(view)[3]).toEqual(['Fri', 'Arrive'])
    press(el, 'pointercancel', 0, 70)
    expect(view.state.doc.toString()).toBe(SRC)
    expect(grid(view)[1]).toEqual(['Fri', 'Arrive'])
    expect(coords(view)[1][0]).toBe('1,0')
    view.destroy()
  })

  it('is a press rather than a drag until the pointer really moves', async () => {
    const view = await editor()
    await enter(view, 1, 0)
    const el = handle(view, 'row')
    press(el, 'pointerdown', 0, 30)
    press(el, 'pointermove', 2, 32)
    press(el, 'pointerup', 2, 32)
    expect(view.state.doc.toString()).toBe(SRC)
    expect(tableBand.value).toEqual({ from: 0, kind: 'row', index: 1 })
    view.destroy()
  })
})
