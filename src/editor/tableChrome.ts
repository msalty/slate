/**
 * The handles on a rendered table: pick a row or a column, or drag it somewhere
 * else, without going anywhere near a menu.
 *
 * Everything a table can do was already reachable — from the toolbar's ⊞, from
 * the Format sheet on a phone — but all of it through a menu, aimed at whatever
 * cell you happened to be in. That is a lot of steps for "this row goes above
 * that one", and reordering was not offered at all: you retyped both rows.
 *
 * So a cell being worked in grows two handles, the way the platform's own notes
 * app does it: a "⋯" over its column and one beside its row. They work in three
 * steps, and the steps are deliberately the same on a mouse and a finger:
 *
 *   press once   the band is outlined, and the keyboard goes away
 *   press again  that band's menu opens, already aimed at it
 *   drag         the band follows the pointer and is dropped where it lands
 *
 * The drag reorders the DOM as it goes, which is what makes it legible: you are
 * looking at the table as it will be, not at a line between two rows. Only on
 * release is any of it written to the note, so a reorder is one undoable edit
 * rather than one per row crossed.
 *
 * The handles are drawn into the widget's own DOM rather than floated over the
 * editor: a table scrolls sideways inside its wrapper, and anything positioned
 * outside it would drift off the column it belongs to at the first scroll.
 */

import { effect } from '@preact/signals'
import type { EditorView } from '@codemirror/view'
import { requestTableBandMenu } from './context'
import { applyTableMove, bandIs, focusedCell, selectBand, tableBand, type TableAxis } from './table'

/** Movement that counts as a drag rather than a press. */
const SLOP = 5

export function wireTableChrome(view: EditorView, wrap: HTMLElement, from: number): () => void {
  const table = wrap.querySelector('table')
  if (!table) return () => {}

  const box = document.createElement('div')
  box.className = 'cm-table-band'
  box.setAttribute('aria-hidden', 'true')
  box.hidden = true

  const handles: Record<TableAxis, HTMLButtonElement> = { row: handle('row'), col: handle('col') }
  wrap.append(box, handles.row, handles.col)

  const cellAt = (row: number, col: number) =>
    wrap.querySelector<HTMLElement>(`[data-row="${row}"][data-col="${col}"]`)

  /** The cells of a band, in the order they are laid out. */
  const cellsOf = (kind: TableAxis, index: number) => [
    ...wrap.querySelectorAll<HTMLElement>(
      kind === 'row' ? `[data-row="${index}"]` : `[data-col="${index}"]`,
    ),
  ]

  const counts = () => ({
    rows: wrap.querySelectorAll('tr').length,
    cols: wrap.querySelectorAll('thead th').length,
  })

  /** What a band may be dragged between: never onto or above the header row. */
  const limits = (kind: TableAxis): [number, number] => {
    const n = counts()
    return kind === 'row' ? [1, n.rows - 1] : [0, n.cols - 1]
  }

  /**
   * Where something inside the table sits, in the wrapper's own coordinates.
   *
   * Measured rather than read off `offsetTop`, which for a cell is relative to
   * the *table* — the CSSOM makes a `<table>` an offsetParent whether or not it
   * is positioned — and so would put every handle a gutter's width out. The
   * scroll offsets are added because these coordinates are what an absolutely
   * positioned child of a scrolling box is placed at, and a table wide enough
   * to scroll must not leave its handles behind.
   */
  const at = (el: HTMLElement) => {
    const box = el.getBoundingClientRect()
    const edge = wrap.getBoundingClientRect()
    return {
      x: box.left - edge.left + wrap.scrollLeft,
      y: box.top - edge.top + wrap.scrollTop,
      w: box.width,
      h: box.height,
    }
  }

  const place = (el: HTMLElement, x: number, y: number) => {
    el.style.left = `${x}px`
    el.style.top = `${y}px`
  }

  /** Draw the handles for a cell, and the outline round a band if there is one. */
  const layout = (
    cell: { row: number; col: number } | null,
    band: { kind: TableAxis; index: number } | null,
  ) => {
    for (const el of wrap.querySelectorAll<HTMLElement>('[data-band]')) delete el.dataset.band
    const target = cell && cellAt(cell.row, cell.col)
    if (!cell || !target) {
      handles.row.hidden = true
      handles.col.hidden = true
      box.hidden = true
      return
    }

    /*
     * Centred in the gutter the theme holds open, rather than set a fixed
     * distance out from the table. The gutter is wider on a touch screen — a
     * handle there has to be big enough for a thumb — and half of whatever it
     * is keeps the dots in the middle of their own target on both.
     */
    const cellBox = at(target)
    const tableBox = at(table)
    place(handles.col, cellBox.x + cellBox.w / 2, tableBox.y / 2)
    place(handles.row, tableBox.x / 2, cellBox.y + cellBox.h / 2)
    handles.col.hidden = false
    handles.row.hidden = false
    // Row 0 is the header, which is a row you can pick but not move.
    describe(
      handles.row,
      cell.row === 0 ? 'Header row' : `Row ${cell.row + 1}`,
      band?.kind === 'row',
    )
    describe(handles.col, `Column ${cell.col + 1}`, band?.kind === 'col')

    const cells = band ? cellsOf(band.kind, band.index) : []
    const first = cells[0]
    const last = cells[cells.length - 1]
    box.hidden = !first
    if (!first || !last) return
    const head = at(first)
    const tail = at(last)
    place(box, head.x, head.y)
    box.style.width = `${tail.x + tail.w - head.x}px`
    box.style.height = `${tail.y + tail.h - head.y}px`
    for (const c of cells) c.dataset.band = '1'
  }

  /**
   * True while a drag is running, when the DOM is ahead of the note on purpose
   * and the signals must not be allowed to redraw over it.
   */
  let dragging = false

  const redraw = () => {
    if (dragging) return
    const cell = focusedCell.value
    const band = tableBand.value
    const here = cell && cell.from === from ? { row: cell.row, col: cell.col } : null
    layout(here, here && band && band.from === from ? { kind: band.kind, index: band.index } : null)
  }

  const watching = effect(() => {
    // Read both signals here, synchronously, or the effect subscribes to
    // nothing; the drawing itself can wait until this DOM is on screen, since
    // an element that is not yet in the document measures as zero.
    focusedCell.value
    tableBand.value
    if (wrap.isConnected) redraw()
    else queueMicrotask(redraw)
  })

  /* --------------------------------------------------------------- gestures */

  /** Commit whatever is being typed in this table, before acting on it. */
  const settle = () => {
    const active = document.activeElement
    if (active instanceof HTMLElement && wrap.contains(active)) active.blur()
  }

  /** Which row or column the pointer is over, read from the DOM as it stands. */
  const indexAt = (kind: TableAxis, x: number, y: number): number => {
    const bands =
      kind === 'row'
        ? [...wrap.querySelectorAll<HTMLElement>('tbody tr')]
        : [...wrap.querySelectorAll<HTMLElement>('thead th')]
    for (const el of bands) {
      const r = el.getBoundingClientRect()
      if (kind === 'row' ? y < r.bottom : x < r.right) {
        const cell = kind === 'row' ? (el as HTMLTableRowElement).cells[0] : el
        return Number(kind === 'row' ? cell?.dataset.row : cell?.dataset.col)
      }
    }
    const [, max] = limits(kind)
    return max
  }

  /**
   * Show the move in the table itself, and renumber what moved.
   *
   * The coordinates on the cells are what everything else here reads, so they
   * have to keep describing the table on screen — otherwise the outline would
   * be drawn round the row the dragged one used to be.
   */
  const shift = (kind: TableAxis, at: number, to: number) => {
    if (kind === 'row') {
      const body = wrap.querySelector('tbody')
      if (!body) return
      const rows = [...body.rows]
      // Body row r is model row r + 1: the header lives in its own section.
      const [moved] = rows.splice(at - 1, 1)
      rows.splice(to - 1, 0, moved)
      for (const tr of rows) body.appendChild(tr)
      rows.forEach((tr, i) => {
        for (const cell of tr.cells) (cell as HTMLElement).dataset.row = String(i + 1)
      })
      return
    }
    for (const tr of wrap.querySelectorAll('tr')) {
      const cells = [...tr.cells]
      const [moved] = cells.splice(at, 1)
      cells.splice(to, 0, moved)
      for (const cell of cells) tr.appendChild(cell)
      cells.forEach((cell, i) => ((cell as HTMLElement).dataset.col = String(i)))
    }
  }

  /**
   * One gesture on a handle, from the press to whatever it turns out to be.
   *
   * Written once and driven by either kind of input, because the gesture is the
   * same either way — only the events that describe it differ. Returns null
   * when there is nothing to act on, in which case the input handler has
   * nothing left to wire up.
   */
  const begin = (kind: TableAxis, x0: number, y0: number) => {
    const cell = focusedCell.value
    if (!cell || cell.from !== from) return null

    settle()
    if (!wrap.isConnected) {
      // Typing was committed, which rebuilt the table. The band is state rather
      // than DOM, so the new one picks it up; the drag is not worth chasing.
      selectBand(from, kind, kind === 'row' ? cell.row : cell.col)
      return null
    }

    const start = kind === 'row' ? cell.row : cell.col
    const [min, max] = limits(kind)
    let index = start
    let moved = false

    return {
      move(x: number, y: number) {
        if (!moved) {
          if (Math.hypot(x - x0, y - y0) < SLOP) return
          // The header is not draggable, and neither is the only row there is.
          if (start < min || max <= min) return
          moved = true
          dragging = true
          wrap.dataset.dragging = kind
          selectBand(from, kind, start)
        }
        const under = indexAt(kind, x, y)
        const to = Number.isFinite(under) ? Math.min(Math.max(under, min), max) : index
        if (to !== index) {
          shift(kind, index, to)
          index = to
        }
        layout(
          kind === 'row' ? { row: index, col: cell.col } : { row: cell.row, col: index },
          { kind, index },
        )
      },

      end(x: number, y: number, cancelled: boolean) {
        const dragged = moved
        dragging = false
        delete wrap.dataset.dragging
        if (dragged) {
          const keep = !cancelled && index !== start && applyTableMove(view, kind, start, index)
          if (!keep) {
            /*
             * Cancelled, dropped where it started, or refused because the note
             * moved under it. Nothing was written, so the table on screen has to
             * be put back — the same move in reverse, which is exact however
             * many bands the drag crossed on the way.
             */
            shift(kind, index, start)
            redraw()
          }
          return
        }
        if (cancelled) return
        /*
         * A press, then. The first one picks the band out — that is worth
         * having on its own, since it is also how you see which row a menu
         * would act on once the keyboard is down over half the table. The
         * second opens it.
         */
        if (bandIs(from, kind, start)) requestTableBandMenu({ x, y }, kind, start)
        else selectBand(from, kind, start)
      },
    }
  }

  /**
   * A mouse or a pen, which is the straightforward half.
   *
   * Touch is deliberately not handled here — see below — so anything arriving
   * with a touch pointer is left for the touch listeners rather than served
   * twice.
   */
  const onPointerDown = (kind: TableAxis) => (e: PointerEvent) => {
    if (e.pointerType === 'touch' || e.button > 0) return
    /*
     * The press must not move focus: a handle is a button, and letting it take
     * focus would blur the cell on the way in — committing, rewriting the table
     * and pulling this very DOM out from under the gesture. The cell is blurred
     * deliberately instead, inside `begin`, where there is somewhere to put the
     * result.
     */
    e.preventDefault()
    e.stopPropagation()
    const gesture = begin(kind, e.clientX, e.clientY)
    if (!gesture) return

    const el = handles[kind]
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => gesture.move(ev.clientX, ev.clientY)
    const done = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', done)
      el.removeEventListener('pointercancel', done)
      if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId)
      gesture.end(ev.clientX, ev.clientY, ev.type === 'pointercancel')
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', done)
    el.addEventListener('pointercancel', done)
  }

  /**
   * Touch, handled as touch.
   *
   * A pointer gesture is not enough here, and iPhones are where that shows. A
   * handle sits inside an editing host, and on iOS a finger put down in one is
   * first of all a request for a caret, a selection or the magnifying glass —
   * so the gesture is taken over before `pointermove` ever arrives, and the
   * handle looks broken while behaving perfectly on every desktop browser.
   * Cancelling `touchstart` is what says otherwise, and it can only be said on
   * a touch event.
   *
   * It buys the other half too: a touch is implicitly captured by the element
   * it started on, so the moves keep coming without asking, and the click iOS
   * would synthesise afterwards never happens — which is what would otherwise
   * run this whole gesture a second time.
   */
  const onTouchStart = (kind: TableAxis) => (e: TouchEvent) => {
    const touch = e.touches[0]
    if (!touch || e.touches.length > 1) return
    e.preventDefault()
    e.stopPropagation()
    const gesture = begin(kind, touch.clientX, touch.clientY)
    if (!gesture) return

    const el = handles[kind]
    const id = touch.identifier
    const mine = (ev: TouchEvent) => [...ev.changedTouches].find((t) => t.identifier === id)
    const move = (ev: TouchEvent) => {
      const t = mine(ev)
      if (!t) return
      // Said again on every move: iOS re-reads the gesture as it goes, and a
      // move left to the browser is a scroll of whatever is behind the table.
      ev.preventDefault()
      gesture.move(t.clientX, t.clientY)
    }
    const done = (ev: TouchEvent) => {
      const t = mine(ev)
      if (!t) return
      el.removeEventListener('touchmove', move)
      el.removeEventListener('touchend', done)
      el.removeEventListener('touchcancel', done)
      gesture.end(t.clientX, t.clientY, ev.type === 'touchcancel')
    }
    el.addEventListener('touchmove', move, { passive: false })
    el.addEventListener('touchend', done)
    el.addEventListener('touchcancel', done)
  }

  for (const kind of ['row', 'col'] as TableAxis[]) {
    handles[kind].addEventListener('pointerdown', onPointerDown(kind))
    handles[kind].addEventListener('touchstart', onTouchStart(kind), { passive: false })
  }

  return () => {
    watching()
    if (dragging) {
      dragging = false
      delete wrap.dataset.dragging
    }
  }
}

/** One handle: three dots, a real button, and no part of the note's text. */
function handle(kind: TableAxis): HTMLButtonElement {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = 'cm-table-handle'
  el.dataset.axis = kind
  el.setAttribute('contenteditable', 'false')
  el.setAttribute('aria-haspopup', 'menu')
  /*
   * Out of the tab order on purpose. Tab inside a table moves to the next cell
   * — that is what makes typing one bearable — and a stop between every pair of
   * cells would wreck it. Everything the handles do has a keyboard route
   * already: the toolbar's table menu offers the same operations, moving a row
   * or column included.
   */
  el.tabIndex = -1
  el.hidden = true
  for (let i = 0; i < 3; i++) el.appendChild(document.createElement('i'))
  return el
}

/** Name a handle for a screen reader, and say whether its band is picked out. */
function describe(el: HTMLElement, label: string, on: boolean) {
  el.setAttribute('aria-label', `${label} options`)
  el.setAttribute('aria-pressed', String(on))
  el.dataset.on = on ? '1' : '0'
}
