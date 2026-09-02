/**
 * Pinch, pan and zoom arithmetic.
 *
 * The thing that goes wrong with a pinch is subtle and hard to see in a
 * screenshot: the picture zooms, but around the wrong point, so the detail you
 * put your fingers on slides away while you enlarge it. Every zoom case here is
 * therefore stated the same way — the content under the fingers must still be
 * under the fingers afterwards — checked through `project`, which is the
 * transform written out.
 */

import { describe, expect, it } from 'vitest'
import {
  clampScale,
  clampView,
  FIT,
  MAX_SCALE,
  pan,
  pinch,
  project,
  zoomTo,
  type Point,
  type View,
} from './zoom'

/** A 400×300 image sitting in the middle of an 800×600 stage. */
const CENTRE: Point = { x: 400, y: 300 }
const BASE = { w: 400, h: 300 }
const STAGE = { w: 800, h: 600 }

/** The image offset (from its own centre) that is under a screen point. */
function offsetUnder(view: View, centre: Point, at: Point): Point {
  return {
    x: (at.x - centre.x - view.x) / view.scale,
    y: (at.y - centre.y - view.y) / view.scale,
  }
}

function expectClose(a: Point, b: Point) {
  expect(a.x).toBeCloseTo(b.x, 6)
  expect(a.y).toBeCloseTo(b.y, 6)
}

describe('scale limits', () => {
  it('never zooms out past the fit, where the whole picture is already visible', () => {
    expect(clampScale(0.2)).toBe(1)
  })

  it('stops at 8×', () => {
    expect(clampScale(50)).toBe(MAX_SCALE)
  })
})

describe('zooming to a point', () => {
  it('leaves the content under that point exactly where it was', () => {
    const focus: Point = { x: 520, y: 240 }
    const before = offsetUnder(FIT, CENTRE, focus)
    const after = zoomTo(FIT, 3, focus, CENTRE)
    expectClose(project(after, CENTRE, before), focus)
  })

  it('does the same from an already zoomed and dragged view', () => {
    const view: View = { scale: 2.5, x: -80, y: 40 }
    const focus: Point = { x: 300, y: 500 }
    const before = offsetUnder(view, CENTRE, focus)
    const after = zoomTo(view, 5, focus, CENTRE)
    expectClose(project(after, CENTRE, before), focus)
  })

  it('holds the point still even when the scale is clamped away', () => {
    const view: View = { scale: 6, x: 10, y: -10 }
    const focus: Point = { x: 700, y: 100 }
    const before = offsetUnder(view, CENTRE, focus)
    const after = zoomTo(view, 100, focus, CENTRE)
    expect(after.scale).toBe(MAX_SCALE)
    expectClose(project(after, CENTRE, before), focus)
  })
})

describe('pinching', () => {
  it('spreading the fingers apart zooms by how far they spread', () => {
    const from = [
      { x: 300, y: 300 },
      { x: 500, y: 300 },
    ] as const
    const to = [
      { x: 200, y: 300 },
      { x: 600, y: 300 },
    ] as const
    expect(pinch(FIT, from, to, CENTRE).scale).toBeCloseTo(2, 6)
  })

  it('keeps what is between the fingers between the fingers', () => {
    const from = [
      { x: 340, y: 260 },
      { x: 460, y: 340 },
    ] as const
    // Spread and moved: the midpoint travels from (400,300) to (450,280).
    const to = [
      { x: 360, y: 200 },
      { x: 540, y: 360 },
    ] as const
    const was = { x: 400, y: 300 }
    const held = offsetUnder(FIT, CENTRE, was)
    const after = pinch(FIT, from, to, CENTRE)
    expectClose(project(after, CENTRE, held), { x: 450, y: 280 })
  })

  it('two fingers that only travel drag without zooming', () => {
    const from = [
      { x: 300, y: 300 },
      { x: 500, y: 300 },
    ] as const
    const to = [
      { x: 340, y: 260 },
      { x: 540, y: 260 },
    ] as const
    const after = pinch({ scale: 2, x: 0, y: 0 }, from, to, CENTRE)
    expect(after.scale).toBeCloseTo(2, 6)
    expect(after.x).toBeCloseTo(40, 6)
    expect(after.y).toBeCloseTo(-40, 6)
  })

  it('ignores a step where two fingers land on the same spot', () => {
    const same = [
      { x: 100, y: 100 },
      { x: 100, y: 100 },
    ] as const
    const view: View = { scale: 2, x: 5, y: 5 }
    expect(pinch(view, same, same, CENTRE)).toEqual(view)
  })
})

describe('holding the picture against the stage', () => {
  it('gives a fitted image nowhere to go', () => {
    expect(clampView(pan(FIT, 120, -90), BASE, STAGE)).toEqual(FIT)
  })

  it('lets a zoomed image move by exactly its overflow', () => {
    // 400×300 at 4× is 1600×1200 in an 800×600 stage: 400 and 300 of slack.
    const dragged = clampView(pan({ scale: 4, x: 0, y: 0 }, 5000, 5000), BASE, STAGE)
    expect(dragged.x).toBe(400)
    expect(dragged.y).toBe(300)
  })

  it('clamps each axis on its own, since a picture overflows one before the other', () => {
    // 2× is 800×600: exactly the stage width, still short vertically.
    const view = clampView({ scale: 2, x: 30, y: 30 }, BASE, STAGE)
    expect(view.x).toBe(0)
    expect(view.y).toBe(0)
  })

  it('keeps a drag that stays inside the overflow untouched', () => {
    const view = { scale: 3, x: -100, y: 60 }
    expect(clampView(view, BASE, STAGE)).toEqual(view)
  })
})
