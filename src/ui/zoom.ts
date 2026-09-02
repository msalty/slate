/**
 * The arithmetic behind pinching, panning and zooming an image.
 *
 * Kept apart from the viewer that uses it because none of it needs a DOM: a
 * view is three numbers, every gesture is a function from one view to the next,
 * and that is the part worth testing directly. The viewer supplies the
 * measurements — where the image sits and how big the stage is — and does
 * nothing else with the numbers but write them into a transform.
 *
 * The transform this describes is `translate(x, y) scale(scale)` with the
 * origin at the image's centre, in that order. `x` and `y` are screen pixels
 * and are *not* scaled, which is what makes a drag track the finger exactly.
 */

export interface Point {
  x: number
  y: number
}

export interface Box {
  w: number
  h: number
}

/** Where the image is: how far it is zoomed, and how far it has been dragged. */
export interface View {
  scale: number
  x: number
  y: number
}

/** Fitted to the stage and centred — what a picture opens at. */
export const FIT: View = { scale: 1, x: 0, y: 0 }

/**
 * Zooming out past the fit would only add letterboxing to a picture that is
 * already fully visible, so 1 is the floor. 8× is far enough to read the fine
 * print on a photographed page.
 */
export const MIN_SCALE = 1
export const MAX_SCALE = 8

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/**
 * Hold the image against the stage.
 *
 * There is only as much room to drag as the picture has overflow, so a fitted
 * image cannot be dragged at all and a zoomed one stops with its edge at the
 * edge of the stage rather than sliding off into the dark.
 *
 * `base` is the image at scale 1 — the size the browser laid it out at — so
 * this stays right no matter how the gesture got here.
 */
export function clampView(view: View, base: Box, stage: Box): View {
  return {
    scale: view.scale,
    x: hold(view.x, (base.w * view.scale - stage.w) / 2),
    y: hold(view.y, (base.h * view.scale - stage.h) / 2),
  }
}

/**
 * One axis of the above. `|| 0` is there for negative zero, which is a real
 * number in JavaScript and would otherwise reach the transform as `-0px`.
 */
function hold(v: number, slack: number): number {
  const limit = Math.max(0, slack)
  return Math.min(limit, Math.max(-limit, v)) || 0
}

/**
 * Zoom to `scale` while keeping whatever is under `focus` exactly where it is.
 *
 * That fixed point is what makes a pinch feel attached to the fingers instead
 * of to the middle of the picture: the pixel between them is the one that must
 * not move. `centre` is the image's *untransformed* centre in screen
 * coordinates — the one thing the caller has to measure, because the transform
 * moves the visible centre around.
 */
export function zoomTo(view: View, scale: number, focus: Point, centre: Point): View {
  const next = clampScale(scale)
  const k = next / view.scale
  return {
    scale: next,
    x: (1 - k) * (focus.x - centre.x) + k * view.x,
    y: (1 - k) * (focus.y - centre.y) + k * view.y,
  }
}

/** Drag by a screen delta. */
export function pan(view: View, dx: number, dy: number): View {
  return { scale: view.scale, x: view.x + dx, y: view.y + dy }
}

/**
 * One step of a two-finger gesture, from where the fingers were to where they
 * are now.
 *
 * A pinch is two things at once and both matter: the fingers spread or close,
 * which zooms around the point between them, and that point itself travels,
 * which drags. Doing only the first makes a picture you can zoom but never
 * move; the pair together is what lets one gesture take you to a corner of a
 * photograph and blow it up.
 */
export function pinch(
  view: View,
  from: readonly [Point, Point],
  to: readonly [Point, Point],
  centre: Point,
): View {
  const spread = distance(from[0], from[1])
  const spreadNow = distance(to[0], to[1])
  if (!spread || !spreadNow) return view
  const was = midpoint(from[0], from[1])
  const now = midpoint(to[0], to[1])
  const zoomed = zoomTo(view, view.scale * (spreadNow / spread), was, centre)
  return pan(zoomed, now.x - was.x, now.y - was.y)
}

/**
 * Where a point of the image ends up on screen.
 *
 * Only the tests use this — it is the definition the gesture functions are
 * checked against, and writing it out once is cheaper than re-deriving the
 * transform in every assertion.
 */
export function project(view: View, centre: Point, offset: Point): Point {
  return {
    x: centre.x + view.x + view.scale * offset.x,
    y: centre.y + view.y + view.scale * offset.y,
  }
}
