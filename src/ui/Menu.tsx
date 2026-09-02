/**
 * Context menu.
 *
 * One component, two presentations: an anchored popover on a pointer device,
 * and a bottom sheet on a phone — where a popover pinned to a fingertip is
 * both hard to hit and usually half off-screen.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { signal } from '@preact/signals'
import { layoutMode } from './layout'

export interface MenuItem {
  label: string
  icon?: preact.ComponentChildren
  onSelect: () => void | Promise<void>
  danger?: boolean
  /** Renders a separator above this item. */
  separated?: boolean
  disabled?: boolean
}

interface MenuState {
  x: number
  y: number
  title?: string
  items: MenuItem[]
}

const menu = signal<MenuState | null>(null)

export function openMenu(e: { clientX: number; clientY: number }, items: MenuItem[], title?: string) {
  menu.value = { x: e.clientX, y: e.clientY, items, title }
}

export function closeMenu() {
  menu.value = null
}

/**
 * Long-press to open a menu on touch, without breaking scrolling: the timer is
 * cancelled as soon as the finger moves more than a few pixels.
 */
export function useLongPress(getItems: () => MenuItem[], title?: () => string) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const start = useRef({ x: 0, y: 0 })

  const cancel = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }

  return {
    onTouchStart: (e: TouchEvent) => {
      const t = e.touches[0]
      if (!t) return
      start.current = { x: t.clientX, y: t.clientY }
      cancel()
      timer.current = setTimeout(() => {
        timer.current = null
        navigator.vibrate?.(8)
        openMenu({ clientX: t.clientX, clientY: t.clientY }, getItems(), title?.())
      }, 480)
    },
    onTouchMove: (e: TouchEvent) => {
      const t = e.touches[0]
      if (!t) return
      if (Math.hypot(t.clientX - start.current.x, t.clientY - start.current.y) > 8) cancel()
    },
    onTouchEnd: cancel,
    onTouchCancel: cancel,
  }
}

export function ContextMenu() {
  const state = menu.value
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const sheet = layoutMode.value === 'compact'

  // Flip the popover back on-screen once its real size is known.
  useLayoutEffect(() => {
    if (!state || sheet || !ref.current) {
      setPos(null)
      return
    }
    const r = ref.current.getBoundingClientRect()
    const pad = 8
    setPos({
      left: Math.min(state.x, window.innerWidth - r.width - pad),
      top: Math.min(state.y, window.innerHeight - r.height - pad),
    })
  }, [state, sheet])

  useEffect(() => {
    if (!state) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu()
    }
    // A menu is anchored to a point on screen, so anything scrolling out from
    // under it should dismiss it.
    const onScroll = () => closeMenu()
    addEventListener('keydown', onKey)
    /*
     * ...but not the scroll the opening click itself caused. A toolbar that
     * scrolls sideways emits one when a button in it is pressed, and that
     * arrived just after the menu opened and closed it again — the button
     * looked dead. Arming a frame later skips it and still catches every
     * scroll a person makes.
     */
    const armed = requestAnimationFrame(() =>
      requestAnimationFrame(() => addEventListener('scroll', onScroll, true)),
    )
    return () => {
      cancelAnimationFrame(armed)
      removeEventListener('keydown', onKey)
      removeEventListener('scroll', onScroll, true)
    }
  }, [state])

  if (!state) return null

  const body = (
    <div
      ref={ref}
      class={sheet ? 'menu menu-sheet' : 'menu'}
      style={sheet ? undefined : { left: `${pos?.left ?? state.x}px`, top: `${pos?.top ?? state.y}px`, visibility: pos ? 'visible' : 'hidden' }}
      role="menu"
      onClick={(e) => e.stopPropagation()}
    >
      {state.title && <div class="menu-title">{state.title}</div>}
      {state.items.map((item, i) => (
        <button
          key={i}
          class="menu-item"
          role="menuitem"
          data-danger={item.danger ? '1' : '0'}
          data-sep={item.separated ? '1' : '0'}
          disabled={item.disabled}
          onClick={async () => {
            closeMenu()
            await item.onSelect()
          }}
        >
          {item.icon && <span class="menu-icon">{item.icon}</span>}
          <span>{item.label}</span>
        </button>
      ))}
      {sheet && (
        <button class="menu-item menu-cancel" onClick={closeMenu}>
          Cancel
        </button>
      )}
    </div>
  )

  return (
    <div class={sheet ? 'menu-scrim menu-scrim-sheet' : 'menu-scrim'} onClick={closeMenu} onContextMenu={(e) => { e.preventDefault(); closeMenu() }}>
      {body}
    </div>
  )
}
