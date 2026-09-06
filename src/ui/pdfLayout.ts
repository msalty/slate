/**
 * The arithmetic behind laying a PDF out and zooming it.
 *
 * Kept apart from the viewer for the same reason `zoom.ts` is: none of it needs
 * a DOM, so it is the part that can be checked directly. The viewer supplies
 * the measurements — the size of the stage, the size of each page in PDF units,
 * where the fingers are — and does nothing with the numbers but write them into
 * a width, a canvas and a scroll offset.
 *
 * A picture and a document want different things from a gesture, which is why
 * this is not `zoom.ts`. A picture is one fixed thing that is panned around
 * inside a frame; a document is a column of pages taller than any screen, so
 * the browser's own scroller has to keep it — with its momentum, its
 * scrollbars, and its ability to fling through two hundred pages — and zooming
 * is a change of *width*, not a transform. That makes the pages themselves
 * re-render sharp at the new size instead of turning into a magnified blur.
 */

/** A page, or anything else measured in two dimensions. */
export interface Box {
  w: number
  h: number
}

export interface Point {
  x: number
  y: number
}

/** The part of a `DOMRect` this needs, so tests don't have to build one. */
export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Zoom 1 is the document fitted to the width of the stage, which is where it
 * opens: on a phone that is the reading size, and zooming out from it would
 * only shrink the words. 8× is far enough to read a footnote on a scan.
 */
export const MIN_ZOOM = 1
export const MAX_ZOOM = 8

/**
 * A page is never laid out wider than this, however wide the window is.
 *
 * A letter page is about 816 CSS pixels at its natural size, and on a 27-inch
 * monitor "fit the width" would otherwise mean a page two feet across. The cap
 * is what makes the fit a *reading* width rather than a literal one.
 */
export const MAX_COLUMN = 900

/**
 * How many device pixels one page may be drawn into.
 *
 * Every canvas is a real allocation — four bytes a pixel, and several pages are
 * live at once — and both iOS and Android quietly stop honouring canvas sizes
 * past a limit rather than telling you they have, which is a blank page rather
 * than an error. Six megapixels is 24MB a page: comfortably more than a fitted
 * page needs on a 3× phone screen, enough that ordinary zooming stays pixel-
 * for-pixel sharp, and low enough that the two or three pages around the one
 * being read fit in what a phone will give a tab. Past it a page goes slightly
 * soft, which is the failure worth having.
 */
export const MAX_CANVAS_PIXELS = 6_000_000

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

/**
 * The widest page in the document. Everything is laid out against it, so a
 * document that mixes portrait and landscape puts its landscape pages at the
 * full column width and indents the portrait ones, rather than cropping either.
 */
export function widest(pages: readonly Box[]): number {
  return pages.reduce((w, p) => Math.max(w, p.w), 0)
}

/** The column's width at zoom 1: the stage, up to the reading cap. */
export function fitColumn(stage: number, cap = MAX_COLUMN): number {
  return Math.max(1, Math.min(stage, cap))
}

/**
 * The scale to render one page at, in device pixels per PDF unit.
 *
 * `css` is what the layout asked for and `dpr` is what the screen deserves;
 * the product is what is wanted and the cap is what is affordable. Shrinking
 * by the square root of the overshoot is what keeps the aspect ratio while
 * bringing the *area* back under the limit.
 */
export function renderScale(
  page: Box,
  css: number,
  dpr: number,
  cap = MAX_CANVAS_PIXELS,
): number {
  const want = css * Math.max(1, dpr)
  const area = page.w * page.h * want * want
  return area <= cap ? want : want * Math.sqrt(cap / area)
}

/**
 * Where to scroll so that whatever was under the fingers stays under them.
 *
 * This is the pinch equivalent of `zoomTo` in `zoom.ts`, done against a
 * scroller instead of a transform. The focus is held as a *fraction* of the
 * content rather than a pixel offset, which is what makes it survive the
 * things that do not scale with the zoom — the gaps between pages, the padding
 * at the top, a column that is centred at one width and not at the next.
 *
 * `before` is the content box as it was, `after` the same box measured once the
 * new width is in but before anything has been scrolled.
 */
export function focalScroll(
  before: Rect,
  after: Rect,
  focus: Point,
  scroll: Point,
): Point {
  const fx = before.width ? (focus.x - before.left) / before.width : 0
  const fy = before.height ? (focus.y - before.top) / before.height : 0
  return {
    x: scroll.x + (after.left + fx * after.width - focus.x),
    y: scroll.y + (after.top + fy * after.height - focus.y),
  }
}

/** The gap between two fingers, and the point between them. */
export function spread(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}
