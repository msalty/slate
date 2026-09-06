/**
 * The PDF viewer.
 *
 * The obvious way to show a PDF on the web is to point an `<iframe>` at it and
 * let the browser do the work, which is what this used to do. It is fine on a
 * desktop and it fails on both phones, in two different ways:
 *
 *   - **iOS** draws the *first page* into the frame and stops. There is no
 *     scrolling on to page two, no pinch, no controls — WebKit treats a framed
 *     PDF as a thumbnail, and no attribute, sandbox flag or `#page=` fragment
 *     talks it out of that. `<object>` and `<embed>` do the same thing there.
 *   - **Android Chrome** has no PDF plugin for frames at all. The frame stays
 *     empty, which is what "the viewer doesn't work" looks like from the
 *     outside: not an error, just nothing.
 *
 * Neither is a bug that can be worked around from the page, so the app draws
 * the pages itself with pdf.js: every page in one scrolling column, each one
 * rendered to a canvas while it is near the screen and thrown away when it is
 * not, with a transparent text layer over it so the words can still be
 * selected, copied and found with the browser's own search. That costs about
 * two megabytes of library, worker and decoders, precached with the rest of the
 * app so that a PDF opens offline like everything else — and it buys one
 * viewer that behaves the same on all five platforms this app runs on.
 *
 * Zooming is deliberately *not* the transform that `zoom.ts` applies to a
 * picture. A document is a column taller than any screen, so the browser's
 * scroller has to keep it — with its momentum and its flick through two
 * hundred pages — and a zoom is a change of width, after which the visible
 * pages redraw sharp at their new size instead of magnifying into a blur.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import type { PDFDocumentLoadingTask, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  clampZoom,
  fitColumn,
  focalScroll,
  midpoint,
  renderScale,
  spread,
  widest,
  type Box,
  type Point,
} from './pdfLayout'

type Pdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
type TextLayer = InstanceType<Pdfjs['TextLayer']>

/**
 * pdf.js, fetched the first time a PDF is opened and never again.
 *
 * A dynamic import is what keeps it out of the bundle everybody downloads to
 * write a note. The worker and the decoders it needs alongside it are emitted
 * by the build under a fixed path of their own (see vite.config.ts), because
 * pdf.js asks for those by name rather than importing them.
 *
 * The `legacy` build, not the default one, and the difference is not cosmetic:
 * the default build is compiled for whatever the newest browser can do this
 * month — it calls `Map.prototype.getOrInsertComputed`, which is a 2025
 * proposal — and on a phone a year old every page fails to draw with a
 * `not a function` in the console. `legacy` is the same library carrying the
 * polyfills for that, about 60KB more, and it is the one that works on the
 * devices this had to be fixed for in the first place.
 */
let loading: Promise<Pdfjs> | undefined
function library(): Promise<Pdfjs> {
  return (loading ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = asset('pdf.worker.js')
    return lib
  }))
}

/**
 * Where the worker and the decoders live.
 *
 * Resolved against `document.baseURI` rather than written absolute, because the
 * whole app is built to run from whatever subdirectory it is dropped into — the
 * domain root, `~/Sites/slate/`, a Pages subpath — with no rebuild.
 */
const asset = (name = '') => new URL(`pdfjs/${name}`, document.baseURI).href

/** The gap between pages, and the room left above and below the document. */
const GAP = 10

interface Loading {
  status: 'loading'
}
interface Failed {
  status: 'error'
  message: string
}
interface Ready {
  status: 'ready'
  pages: PDFPageProxy[]
  boxes: Box[]
}
type State = Loading | Failed | Ready

export function PdfView({
  url,
  zoom,
  onZoom,
  onDownload,
}: {
  url: string
  /** 1 is the fitted width. Owned by the lightbox, so its buttons and keys work. */
  zoom: number
  onZoom: (zoom: number) => void
  onDownload: () => void
}) {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [base, setBase] = useState(0)
  const [shown, setShown] = useState<boolean[]>([])
  const scroller = useRef<HTMLDivElement | null>(null)
  const column = useRef<HTMLDivElement | null>(null)
  /**
   * The zoom the DOM is currently drawn at, and the document it was drawn for.
   *
   * During a pinch this runs ahead of the zoom in state: the gesture writes a
   * width straight into the column sixty times a second and only tells the rest
   * of the app once the fingers are up. Without it the committed value would
   * arrive looking like a change from outside and re-zoom about the middle of
   * the screen. The URL is here so that opening a second PDF starts at the top
   * of page one rather than inheriting the scroll correction owed to the first.
   */
  const applied = useRef({ url, zoom })
  const commit = useRef(onZoom)
  commit.current = onZoom

  /* ---- the document -------------------------------------------------- */

  useEffect(() => {
    let live = true
    let task: PDFDocumentLoadingTask | undefined
    setState({ status: 'loading' })
    setShown([])
    void (async () => {
      try {
        const lib = await library()
        if (!live) return
        task = lib.getDocument({ url, wasmUrl: asset() })
        const doc = await task.promise
        if (!live) return
        // Every page up front, because the column cannot be the right height —
        // and therefore the scrollbar cannot be honest — until each page's
        // shape is known. They are proxies, not pictures; nothing is drawn yet.
        const pages = await Promise.all(
          Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)),
        )
        if (!live) return
        setState({
          status: 'ready',
          pages,
          boxes: pages.map((p) => {
            const v = p.getViewport({ scale: 1 })
            return { w: v.width, h: v.height }
          }),
        })
      } catch (e) {
        console.warn('PDF failed to open', e)
        if (live) setState({ status: 'error', message: describe(e) })
      }
    })()
    return () => {
      live = false
      // Takes the worker, the document and every page proxy with it.
      void task?.destroy()
    }
  }, [url])

  /* ---- the fitted width ---------------------------------------------- */

  useEffect(() => {
    const sc = scroller.current
    if (!sc) return
    const measure = () => setBase(fitColumn(sc.clientWidth))
    const ro = new ResizeObserver(measure)
    ro.observe(sc)
    measure()
    return () => ro.disconnect()
  }, [state.status])

  /**
   * Write a zoom into the DOM.
   *
   * Only two things carry it: the column's width, which every page follows
   * because each one is a percentage of it, and the scale factor the text
   * layer positions itself with. That is what lets a pinch stay smooth — no
   * canvas is touched until the gesture ends — and what keeps the words sharp
   * and in place the whole way through, since the text layer is real text
   * scaled by a CSS variable rather than pixels being stretched.
   */
  const paint = (z: number) => {
    const el = column.current
    if (!el || !base || state.status !== 'ready') return
    const width = base * z
    el.style.width = `${width}px`
    el.style.setProperty('--total-scale-factor', String(width / widest(state.boxes)))
  }

  /** Zoom about a point on screen, holding whatever is under it still. */
  const zoomAbout = (z: number, focus: Point) => {
    const el = column.current
    const sc = scroller.current
    if (!el || !sc) return
    const before = el.getBoundingClientRect()
    paint(z)
    // Reading the box back is what flushes the new width into layout, so the
    // scroll below is computed against the column as it now is.
    const next = focalScroll(before, el.getBoundingClientRect(), focus, {
      x: sc.scrollLeft,
      y: sc.scrollTop,
    })
    sc.scrollLeft = next.x
    sc.scrollTop = next.y
    applied.current = { url, zoom: z }
  }

  useLayoutEffect(() => {
    const sc = scroller.current
    if (!column.current || !sc || !base || state.status !== 'ready') return
    if (applied.current.zoom === zoom || applied.current.url !== url) {
      // Either the gesture already drew this, or the window changed size under
      // a zoom that did not, or this is a different document entirely: in all
      // three there is nothing on screen that has to be held still.
      paint(zoom)
      applied.current = { url, zoom }
      return
    }
    // A zoom from somewhere else — the toolbar, a key — has nothing under a
    // finger to hold, so it holds the middle of the view instead.
    const r = sc.getBoundingClientRect()
    zoomAbout(zoom, { x: r.left + r.width / 2, y: r.top + r.height / 2 })
  }, [url, zoom, base, state])

  /* ---- pinch, and the trackpad ---------------------------------------- */

  useEffect(() => {
    const sc = scroller.current
    if (!sc || state.status !== 'ready' || !base) return

    let start: { gap: number; zoom: number } | null = null
    const fingers = (t: TouchList): [Point, Point] => [
      { x: t[0].clientX, y: t[0].clientY },
      { x: t[1].clientX, y: t[1].clientY },
    ]

    /*
     * Touch events rather than pointer events, and only ever for the second
     * finger.
     *
     * One finger stays the browser's — native scrolling is what gives a long
     * document its momentum, and re-implementing that would be a downgrade —
     * which is what `touch-action: pan-x pan-y` on the scroller says. That
     * takes pinch-zoom away from the browser but does not hand it to anyone,
     * so this is where the gesture is actually read; the `preventDefault` is
     * for the pan half of it, which the browser would otherwise scroll with at
     * the same time as this is scrolling to hold the pinched point still.
     */
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) {
        start = null
        return
      }
      const [a, b] = fingers(e.touches)
      start = { gap: spread(a, b), zoom: applied.current.zoom }
    }
    const onMove = (e: TouchEvent) => {
      if (!start || e.touches.length !== 2) return
      e.preventDefault()
      const [a, b] = fingers(e.touches)
      const gap = spread(a, b)
      if (!gap || !start.gap) return
      // The midpoint travels as well as spreading, so one gesture both zooms
      // and drags — which is how you get to a corner of a page and enlarge it.
      zoomAbout(clampZoom(start.zoom * (gap / start.gap)), midpoint(a, b))
    }
    const onEnd = () => {
      if (!start) return
      start = null
      // Only now do the pages redraw, at the size the fingers left them.
      commit.current(applied.current.zoom)
    }

    /*
     * A trackpad pinch and ctrl+wheel arrive as the same event, and the browser
     * would otherwise zoom the whole app with it. A plain wheel is left alone
     * to scroll.
     */
    let settle = 0
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      zoomAbout(clampZoom(applied.current.zoom * Math.exp(-e.deltaY / 300)), {
        x: e.clientX,
        y: e.clientY,
      })
      clearTimeout(settle)
      settle = setTimeout(() => commit.current(applied.current.zoom), 150)
    }

    sc.addEventListener('touchstart', onStart, { passive: true })
    sc.addEventListener('touchmove', onMove, { passive: false })
    sc.addEventListener('touchend', onEnd, { passive: true })
    sc.addEventListener('touchcancel', onEnd, { passive: true })
    sc.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      clearTimeout(settle)
      sc.removeEventListener('touchstart', onStart)
      sc.removeEventListener('touchmove', onMove)
      sc.removeEventListener('touchend', onEnd)
      sc.removeEventListener('touchcancel', onEnd)
      sc.removeEventListener('wheel', onWheel)
    }
  }, [state, base])

  /* ---- what is worth drawing ------------------------------------------ */

  /*
   * A canvas per page is a real allocation, and a scanned report can be three
   * hundred pages, so only the ones near the screen hold one. The margin is
   * generous — a screenful either way — so that scrolling at a normal speed
   * always meets a page that is already drawn.
   */
  useEffect(() => {
    const sc = scroller.current
    if (!sc || state.status !== 'ready') return
    const io = new IntersectionObserver(
      (entries) => {
        setShown((prev) => {
          const next = prev.slice()
          let changed = false
          for (const e of entries) {
            const i = Number((e.target as HTMLElement).dataset.page)
            if (next[i] !== e.isIntersecting) {
              next[i] = e.isIntersecting
              changed = true
            }
          }
          return changed ? next : prev
        })
      },
      { root: sc, rootMargin: '100% 0px' },
    )
    for (const el of sc.querySelectorAll('.pdf-page')) io.observe(el)
    return () => io.disconnect()
  }, [state])

  if (state.status === 'loading') return <div class="pdf-note">Opening…</div>
  if (state.status === 'error') {
    return (
      <div class="pdf-note">
        {state.message}
        <button class="btn" style={{ marginTop: 12 }} onClick={onDownload}>
          Download
        </button>
      </div>
    )
  }

  const full = widest(state.boxes)
  return (
    <div class="pdf-doc" ref={scroller}>
      <div class="pdf-column" ref={column} style={{ gap: GAP, padding: `${GAP}px 0 ${GAP * 2}px` }}>
        {state.pages.map((page, i) => (
          <PdfPage
            key={page.pageNumber}
            page={page}
            box={state.boxes[i]}
            index={i}
            share={state.boxes[i].w / full}
            css={base && full ? (base * zoom) / full : 0}
            shown={!!shown[i]}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * One page: a picture of it, and the words on it.
 *
 * The two are drawn from the same page but on different schedules. The canvas
 * has to be redrawn every time the zoom settles, because pixels do not survive
 * being enlarged; the text layer is built once and rescaled by a CSS variable,
 * because it is real text and does.
 */
function PdfPage({
  page,
  box,
  index,
  share,
  css,
  shown,
}: {
  page: PDFPageProxy
  box: Box
  index: number
  /** This page's width as a fraction of the widest page in the document. */
  share: number
  /** CSS pixels per PDF unit at the current zoom. */
  css: number
  shown: boolean
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const text = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = canvas.current
    if (!el) return
    if (!shown || !css) {
      // Zero out rather than merely clear: the width is what holds the memory.
      el.width = el.height = 0
      return
    }
    const scale = renderScale(box, css, devicePixelRatio || 1)
    const viewport = page.getViewport({ scale })
    /*
     * Drawn off to the side and swapped in whole.
     *
     * Sizing a canvas wipes it, so rendering straight into the visible one
     * would blank every page on screen for as long as the redraw takes — a
     * white flash on every zoom step. This way the old picture stays up,
     * stretched, until the new one is ready to replace it.
     */
    const off = document.createElement('canvas')
    off.width = Math.max(1, Math.round(viewport.width))
    off.height = Math.max(1, Math.round(viewport.height))
    const ctx = off.getContext('2d')
    if (!ctx) return
    const task = page.render({ canvas: off, canvasContext: ctx, viewport })
    void task.promise
      .then(() => {
        el.width = off.width
        el.height = off.height
        el.getContext('2d')?.drawImage(off, 0, 0)
      })
      .catch(() => {
        /* cancelled by a newer zoom, or a page pdf.js could not draw */
      })
    return () => task.cancel()
  }, [page, box, css, shown])

  useEffect(() => {
    const host = text.current
    if (!host) return
    if (!shown) {
      host.textContent = ''
      return
    }
    let live = true
    let layer: TextLayer | undefined
    void (async () => {
      try {
        const lib = await library()
        if (!live) return
        host.textContent = ''
        // Built at scale 1 on purpose: pdf.js positions the words as
        // percentages of the page and sizes them from `--total-scale-factor`,
        // so a layer built once is correct at every zoom the column reaches.
        layer = new lib.TextLayer({
          textContentSource: page.streamTextContent(),
          container: host,
          viewport: page.getViewport({ scale: 1 }),
        })
        await layer.render()
      } catch {
        /* Selection is a bonus. A page that draws is the point. */
      }
    })()
    return () => {
      live = false
      layer?.cancel()
      host.textContent = ''
    }
  }, [page, shown])

  return (
    <div
      class="pdf-page"
      data-page={index}
      style={{ width: `${share * 100}%`, aspectRatio: `${box.w} / ${box.h}` }}
    >
      <canvas ref={canvas} />
      <div class="pdf-text" ref={text} />
    </div>
  )
}

/** What to tell someone whose PDF did not open. */
function describe(e: unknown): string {
  const name = e instanceof Error ? e.name : ''
  if (name === 'PasswordException') return 'This PDF is password-protected.'
  if (name === 'InvalidPDFException') return 'This file isn’t a readable PDF.'
  return 'This PDF could not be opened.'
}
