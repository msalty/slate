/** Full-screen viewer for any embedded file: image, video, audio, PDF or text. */

import { useEffect, useRef, useState } from 'preact/hooks'
import { attachmentUrl, getRaw } from '../core/vault'
import { basename, formatBytes, mediaClass } from '../core/util'
import { lightboxPath } from './state'
import { IconClose, IconDownload } from './Icons'
import { clampView, FIT, pan, pinch, zoomTo, type Box, type Point, type View } from './zoom'

/** A finger or the mouse pointer, and where it was when we last heard from it. */
type Pointers = Map<number, Point>

/**
 * What a gesture needs to know about the picture, measured once when it starts.
 *
 * All three are transform-independent — the untransformed centre, the laid-out
 * size, the stage — so they stay true for the whole gesture no matter how far
 * the pinch travels, and nothing has to re-measure a moving element mid-drag.
 */
interface Frame {
  centre: Point
  base: Box
  stage: Box
}

/** A press this short that travels this little was someone tapping the picture. */
const TAP_MS = 400
const TAP_SLOP = 8

export function Lightbox() {
  const path = lightboxPath.value
  const [view, setView] = useState<View>(FIT)
  const [gesturing, setGesturing] = useState(false)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const pointers = useRef<Pointers>(new Map())
  const frame = useRef<Frame | null>(null)
  const press = useRef<{ at: number; from: Point; moved: boolean } | null>(null)

  /**
   * Measure the picture as it would be with no transform at all.
   *
   * `getBoundingClientRect` reports the transformed box, so both readings have
   * to be undone: scaling about the centre leaves the centre where the drag put
   * it, and the rendered size is the laid-out size times the scale.
   */
  const measure = (v: View): Frame | null => {
    const img = imgRef.current
    const stage = stageRef.current
    if (!img || !stage) return null
    const r = img.getBoundingClientRect()
    const s = stage.getBoundingClientRect()
    return {
      centre: { x: r.left + r.width / 2 - v.x, y: r.top + r.height / 2 - v.y },
      base: { w: r.width / v.scale, h: r.height / v.scale },
      stage: { w: s.width, h: s.height },
    }
  }

  /** Zoom about a point on screen, or about the middle of the stage. */
  const zoomBy = (factor: number, at?: Point) => {
    setView((v) => {
      const f = measure(v)
      if (!f) return v
      const focus = at ?? { x: f.centre.x, y: f.centre.y }
      return clampView(zoomTo(v, v.scale * factor, focus, f.centre), f.base, f.stage)
    })
  }

  useEffect(() => {
    if (!path) return
    setView(FIT)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        lightboxPath.value = undefined
      }
      if (e.key === '0') setView(FIT)
      if (e.key === '+' || e.key === '=') zoomBy(1.25)
      if (e.key === '-') zoomBy(1 / 1.25)
    }
    addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [path])

  /*
   * Safari's own pinch, kept off the viewer.
   *
   * iOS ignores `user-scalable=no` in a browser tab, so a two-finger gesture
   * over the picture would zoom the whole page — the app's chrome and all —
   * instead of the photograph. `touch-action: none` settles it everywhere else;
   * these non-standard gesture events are the only way to say it to Safari, and
   * they have to be non-passive to be refusable.
   */
  useEffect(() => {
    const stage = stageRef.current
    if (!stage || !path) return
    const stop = (e: Event) => e.preventDefault()
    const kinds = ['gesturestart', 'gesturechange', 'gestureend']
    for (const k of kinds) stage.addEventListener(k, stop, { passive: false })
    return () => {
      for (const k of kinds) stage.removeEventListener(k, stop)
    }
  }, [path])

  if (!path) return null
  const file = getRaw(path)
  const url = attachmentUrl(path)
  const kind = mediaClass(path)
  const zoomable = kind === 'image' && !!url

  const download = () => {
    if (!url) return
    const a = document.createElement('a')
    a.href = url
    a.download = basename(path)
    a.click()
  }

  const at = (e: PointerEvent): Point => ({ x: e.clientX, y: e.clientY })

  const onPointerDown = (e: PointerEvent) => {
    if (!zoomable) return
    const stage = stageRef.current
    // Capture keeps a finger that slides off the picture — or off the screen —
    // reporting to the stage that started the gesture. A pointer that is
    // already gone is not an error worth having: a synthesised event has no
    // capture to take.
    try {
      stage?.setPointerCapture(e.pointerId)
    } catch {
      /* not capturable; the gesture still tracks through the document */
    }
    // The first finger down is what fixes the frame; a second one joining an
    // ongoing pinch must not re-measure, or the picture jumps as it lands.
    if (!pointers.current.size) frame.current = measure(view)
    pointers.current.set(e.pointerId, at(e))
    press.current = { at: Date.now(), from: at(e), moved: false }
    setGesturing(true)
  }

  const onPointerMove = (e: PointerEvent) => {
    const f = frame.current
    if (!zoomable || !f || !pointers.current.has(e.pointerId)) return
    const now = at(e)
    const held = [...pointers.current.entries()]
    const p = press.current
    if (p && Math.hypot(now.x - p.from.x, now.y - p.from.y) > TAP_SLOP) p.moved = true

    if (held.length >= 2) {
      const [[idA, a], [idB, b]] = held
      const to: [Point, Point] = [idA === e.pointerId ? now : a, idB === e.pointerId ? now : b]
      setView((v) => clampView(pinch(v, [a, b], to, f.centre), f.base, f.stage))
    } else {
      const was = held[0][1]
      setView((v) => clampView(pan(v, now.x - was.x, now.y - was.y), f.base, f.stage))
    }
    pointers.current.set(e.pointerId, now)
  }

  const onPointerUp = (e: PointerEvent) => {
    if (!zoomable) return
    stageRef.current?.releasePointerCapture?.(e.pointerId)
    pointers.current.delete(e.pointerId)
    if (pointers.current.size) return

    setGesturing(false)
    const p = press.current
    press.current = null
    // A tap toggles: into the picture at the point touched, or back to the fit.
    if (p && !p.moved && Date.now() - p.at < TAP_MS) {
      setView((v) => {
        if (v.scale > 1) return FIT
        const f = frame.current
        return f ? clampView(zoomTo(v, 2, at(e), f.centre), f.base, f.stage) : v
      })
    }
  }

  return (
    <div
      class="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={basename(path)}
      onClick={() => (lightboxPath.value = undefined)}
    >
      <div class="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span class="lightbox-name">{basename(path)}</span>
        <span class="lightbox-meta">
          {file ? formatBytes(file.size) : ''}
          {kind === 'image' && view.scale !== 1 ? ` · ${Math.round(view.scale * 100)}%` : ''}
        </span>
        <span class="spacer" style={{ flex: 1 }} />
        {/*
          * Hidden on a phone, where fingers do this better: pinch to zoom, drag
          * to move, tap to go back to the fit. A row of 30px buttons is a poor
          * substitute for that, and the space is worth more to the file name.
          */}
        {kind === 'image' && (
          <>
            <button class="icon-btn lightbox-zoom" onClick={() => zoomBy(1 / 1.25)} title="Zoom out (−)">
              −
            </button>
            <button class="icon-btn lightbox-zoom" onClick={() => setView(FIT)} title="Fit (0)">
              1:1
            </button>
            <button class="icon-btn lightbox-zoom" onClick={() => zoomBy(1.25)} title="Zoom in (+)">
              +
            </button>
          </>
        )}
        <button class="icon-btn" onClick={download} title="Download">
          <IconDownload />
        </button>
        <button
          class="icon-btn"
          onClick={() => (lightboxPath.value = undefined)}
          title="Close (Esc)"
        >
          <IconClose />
        </button>
      </div>

      <div
        class="lightbox-stage"
        ref={stageRef}
        data-zoomable={zoomable ? '1' : '0'}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {!url ? (
          <div style={{ color: '#bbb' }}>This file isn’t available on this device yet.</div>
        ) : kind === 'image' ? (
          <img
            ref={imgRef}
            src={url}
            alt={basename(path)}
            draggable={false}
            style={{
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
              transformOrigin: 'center',
              // A transition would lag a finger it is meant to be stuck to.
              transition: gesturing ? 'none' : 'transform 120ms',
              cursor: view.scale > 1 ? (gesturing ? 'grabbing' : 'grab') : 'zoom-in',
            }}
          />
        ) : kind === 'video' ? (
          <video src={url} controls autoplay style={{ maxHeight: '100%' }} />
        ) : kind === 'audio' ? (
          <audio src={url} controls autoplay style={{ width: 'min(600px, 90%)' }} />
        ) : kind === 'pdf' ? (
          <iframe src={url} title={basename(path)} />
        ) : kind === 'text' ? (
          <TextPreview path={path} />
        ) : (
          <div style={{ color: '#bbb', textAlign: 'center' }}>
            No preview for this file type.
            <br />
            <button class="btn" style={{ marginTop: 12 }} onClick={download}>
              Download
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function TextPreview({ path }: { path: string }) {
  const [text, setText] = useState<string | undefined>()
  useEffect(() => {
    const f = getRaw(path)
    if (f?.text !== undefined) setText(f.text)
    else if (f?.blob) void f.blob.text().then(setText)
  }, [path])
  return <pre>{text ?? 'Loading…'}</pre>
}
