/**
 * Laying out and zooming a PDF.
 *
 * The failure worth guarding against here is the same one `zoom.test.ts`
 * guards for a picture — the document zooms around the wrong point and the
 * paragraph you were reading slides off the screen — but reached differently:
 * a document zooms by getting wider inside a scroller, so the check is that
 * the *scroll* lands where it has to for the pinched point to stay put.
 *
 * The rest is arithmetic with real consequences on a phone: a canvas that is
 * allowed to grow without limit comes back blank rather than large.
 */

import { describe, expect, it } from 'vitest'
import {
  clampZoom,
  fitColumn,
  focalScroll,
  MAX_CANVAS_PIXELS,
  MAX_COLUMN,
  MAX_ZOOM,
  renderScale,
  widest,
  type Point,
  type Rect,
} from './pdfLayout'

/** A US Letter page, in PDF units. */
const LETTER = { w: 612, h: 792 }

describe('zoom limits', () => {
  it('never zooms out past the fitted width, which is where reading starts', () => {
    expect(clampZoom(0.25)).toBe(1)
  })

  it('stops at 8×', () => {
    expect(clampZoom(99)).toBe(MAX_ZOOM)
  })
})

describe('the column', () => {
  it('fits the stage on a phone', () => {
    expect(fitColumn(390)).toBe(390)
  })

  it('stops at a reading width on a monitor, rather than a page two feet across', () => {
    expect(fitColumn(2400)).toBe(MAX_COLUMN)
  })

  it('lays every page out against the widest one, so a landscape page is not cropped', () => {
    expect(widest([LETTER, { w: 792, h: 612 }])).toBe(792)
  })
})

describe('render scale', () => {
  it('draws at the screen’s own pixel density', () => {
    // Fitted to a 390px phone: 390/612 CSS px per unit, times a 3× screen.
    const css = 390 / LETTER.w
    expect(renderScale(LETTER, css, 3)).toBeCloseTo(css * 3, 10)
  })

  it('never asks for a canvas bigger than the cap', () => {
    const scale = renderScale(LETTER, 8, 3)
    expect(LETTER.w * scale * (LETTER.h * scale)).toBeLessThanOrEqual(MAX_CANVAS_PIXELS + 1)
  })

  it('gives up sharpness rather than the shape of the page', () => {
    const scale = renderScale(LETTER, 8, 3)
    const capped = { w: LETTER.w * scale, h: LETTER.h * scale }
    expect(capped.w / capped.h).toBeCloseTo(LETTER.w / LETTER.h, 10)
  })

  it('treats a screen that reports no pixel ratio as an ordinary one', () => {
    expect(renderScale(LETTER, 1, 0)).toBe(1)
  })
})

describe('pinching a document', () => {
  /** A column 400 wide and 3000 tall, scrolled 500px down inside a 400×800 stage. */
  const before: Rect = { left: 0, top: -500, width: 400, height: 3000 }
  const scroll: Point = { x: 0, y: 500 }

  /** Where a fraction of the content ends up once the scroll is applied. */
  function land(after: Rect, at: Point, fraction: Point): Point {
    const next = focalScroll(before, after, at, scroll)
    return {
      x: after.left + fraction.x * after.width - (next.x - scroll.x),
      y: after.top + fraction.y * after.height - (next.y - scroll.y),
    }
  }

  it('keeps the point between the fingers under the fingers', () => {
    const focus: Point = { x: 120, y: 300 }
    const fraction = {
      x: (focus.x - before.left) / before.width,
      y: (focus.y - before.top) / before.height,
    }
    // Doubled: twice as wide, and — the pages keeping their shape — twice as tall.
    const after: Rect = { left: -200, top: -1500, width: 800, height: 6000 }
    const at = land(after, focus, fraction)
    expect(at.x).toBeCloseTo(focus.x, 6)
    expect(at.y).toBeCloseTo(focus.y, 6)
  })

  it('holds the same point when the fingers close again', () => {
    const focus: Point = { x: 300, y: 700 }
    const fraction = {
      x: (focus.x - before.left) / before.width,
      y: (focus.y - before.top) / before.height,
    }
    const after: Rect = { left: 100, top: -250, width: 200, height: 1500 }
    const at = land(after, focus, fraction)
    expect(at.x).toBeCloseTo(focus.x, 6)
    expect(at.y).toBeCloseTo(focus.y, 6)
  })

  it('leaves the scroll alone when nothing has changed size', () => {
    expect(focalScroll(before, before, { x: 200, y: 400 }, scroll)).toEqual(scroll)
  })

  it('survives a document that has not been measured yet', () => {
    const empty: Rect = { left: 0, top: 0, width: 0, height: 0 }
    expect(focalScroll(empty, empty, { x: 10, y: 10 }, scroll)).toEqual({ x: -10, y: 490 })
  })
})
