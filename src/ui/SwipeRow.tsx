/**
 * Swipe a row to the left to reveal its actions — the gesture every phone mail
 * app has taught people, and the only one that puts a delete button on a list
 * row without spending a permanent 44 pixels of width on it.
 *
 * Two rules keep it from fighting the list:
 *
 *   1. The gesture only claims the touch once it is clearly horizontal. Until
 *      then the list scrolls normally, so a fast flick down the page never
 *      leaves a row hanging half-open.
 *   2. Only one row is open at a time, and opening one closes the last. A list
 *      with three rows open is a list you have to tidy up before you can read
 *      it.
 *
 * The offset lives on the DOM node rather than in component state: a finger
 * dragging produces a move event every frame, and re-rendering a list row that
 * often — while deciding, on the last event, what the *current* offset is —
 * is both slower and a race. Here the element is the source of truth and the
 * signal only records which row is open.
 *
 * With a pointer this renders as a plain wrapper: swiping is not a mouse
 * gesture, and those layouts have a right-click menu instead.
 */

import { useEffect, useRef } from 'preact/hooks'
import { signal } from '@preact/signals'
import { layoutMode } from './layout'

export interface SwipeAction {
  label: string
  onSelect: () => void | Promise<void>
  danger?: boolean
}

/** The row currently swiped open, so opening another closes it. */
const openRow = signal<string | null>(null)

/** How far a row has to travel before letting go leaves it open. */
const OPEN_AT = 56
/** Beyond this the gesture is a scroll, not a swipe. */
const SLOP = 10

export function SwipeRow({
  id,
  actions,
  children,
}: {
  /** Stable identity, so the open row survives a re-render of the list. */
  id: string
  actions: SwipeAction[]
  children: preact.ComponentChildren
}) {
  const compact = layoutMode.value === 'compact'
  const rowRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const railRef = useRef<HTMLDivElement>(null)
  const offset = useRef(0)
  const drag = useRef<{ x: number; y: number; locked: 'none' | 'swipe' | 'scroll' }>({
    x: 0,
    y: 0,
    locked: 'none',
  })
  const claimed = openRow.value === id

  const setX = (x: number, animate: boolean) => {
    offset.current = x
    const el = contentRef.current
    if (!el) return
    el.style.transition = animate ? 'transform 160ms ease' : 'none'
    el.style.transform = x ? `translateX(${x}px)` : ''
    rowRef.current?.setAttribute('data-open', x < 0 ? '1' : '0')
  }

  // Another row taking over closes this one, and so does a fresh mount.
  useEffect(() => {
    if (!claimed && offset.current !== 0) setX(0, true)
  }, [claimed])

  if (!compact || !actions.length) return <>{children}</>

  const width = () => railRef.current?.offsetWidth || 150

  const close = () => {
    if (openRow.value === id) openRow.value = null
    setX(0, true)
  }

  const onTouchStart = (e: TouchEvent) => {
    const t = e.touches[0]
    if (!t) return
    drag.current = { x: t.clientX, y: t.clientY, locked: 'none' }
  }

  const onTouchMove = (e: TouchEvent) => {
    const t = e.touches[0]
    if (!t) return
    const moveX = t.clientX - drag.current.x
    const moveY = t.clientY - drag.current.y
    if (drag.current.locked === 'none') {
      if (Math.abs(moveY) > SLOP && Math.abs(moveY) > Math.abs(moveX)) {
        drag.current.locked = 'scroll'
        return
      }
      if (Math.abs(moveX) > SLOP) {
        drag.current.locked = 'swipe'
        openRow.value = id
        drag.current.x = t.clientX - (offset.current ? moveX : 0)
      } else return
    }
    if (drag.current.locked !== 'swipe') return
    // Vertical scrolling is off the table now the row has claimed the touch.
    if (e.cancelable) e.preventDefault()
    const base = claimed && offset.current < 0 ? -width() : 0
    setX(Math.max(-width() - 24, Math.min(0, base + (t.clientX - drag.current.x))), false)
  }

  const onTouchEnd = () => {
    if (drag.current.locked !== 'swipe') return
    drag.current.locked = 'none'
    if (offset.current <= -OPEN_AT) {
      openRow.value = id
      setX(-width(), true)
    } else close()
  }

  return (
    <div class="swipe-row" ref={rowRef} data-open="0">
      <div class="swipe-actions" ref={railRef}>
        {actions.map((a) => (
          <button
            key={a.label}
            class="swipe-action"
            data-danger={a.danger ? '1' : '0'}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              close()
              void a.onSelect()
            }}
          >
            {a.label}
          </button>
        ))}
      </div>
      <div
        class="swipe-content"
        ref={contentRef}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        // An open row eats the next tap: closing it is what that tap meant.
        onClickCapture={(e) => {
          if (offset.current === 0) return
          e.preventDefault()
          e.stopPropagation()
          close()
        }}
      >
        {children}
      </div>
    </div>
  )
}
