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
import { IconCheck } from './Icons'

export interface MenuItem {
  label: string
  icon?: preact.ComponentChildren
  onSelect: () => void | Promise<void>
  danger?: boolean
  /** Renders a separator above this item. */
  separated?: boolean
  disabled?: boolean
  /**
   * A toggle that is currently on — bold text under the caret, say. Drawn as a
   * tick and in the accent colour, matching how the same control looks when it
   * is a pressed button rather than a menu row.
   */
  checked?: boolean
}

interface MenuState {
  x: number
  y: number
  title?: string
  items: MenuItem[]
  /** A body of its own, in place of the item list. */
  render?: (close: () => void) => preact.ComponentChildren
  /** Extra class on the menu box, for a body that needs different room. */
  cls?: string
}

const menu = signal<MenuState | null>(null)

/**
 * Where the last menu was anchored.
 *
 * An item whose job is to open a *second* menu has no event of its own to open
 * it at — `onSelect` is called after the first has closed. Opening the second
 * one where the first was is both the obvious place and a stable one, so a
 * submenu does not appear under wherever the pointer happened to drift.
 */
let anchor = { clientX: 0, clientY: 0 }

export function menuAnchor(): { clientX: number; clientY: number } {
  return anchor
}

export function openMenu(e: { clientX: number; clientY: number }, items: MenuItem[], title?: string) {
  anchor = { clientX: e.clientX, clientY: e.clientY }
  menu.value = { x: e.clientX, y: e.clientY, items, title }
}

/**
 * The same menu, hosting something that isn't a list of items.
 *
 * Everything that makes a menu behave like one — the scrim, popover-here or
 * sheet-from-the-bottom, flipping back on screen, Escape, dismiss-on-scroll —
 * is worth having exactly once. A picker that needs a grid rather than rows
 * borrows all of it and supplies only the middle.
 */
export function openMenuWith(
  e: { clientX: number; clientY: number },
  render: (close: () => void) => preact.ComponentChildren,
  opts: { title?: string; cls?: string } = {},
) {
  anchor = { clientX: e.clientX, clientY: e.clientY }
  menu.value = { x: e.clientX, y: e.clientY, items: [], render, ...opts }
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
    /*
     * A menu is anchored to a point on screen, so anything scrolling out from
     * under it should dismiss it — but not the menu's own contents. A body tall
     * enough to scroll (the due-date picker on a short phone) would otherwise
     * shut itself the moment you dragged it.
     */
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return
      closeMenu()
    }
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
      class={`${sheet ? 'menu menu-sheet' : 'menu'}${state.cls ? ` ${state.cls}` : ''}`}
      style={sheet ? undefined : { left: `${pos?.left ?? state.x}px`, top: `${pos?.top ?? state.y}px`, visibility: pos ? 'visible' : 'hidden' }}
      // A custom body is not a list of commands, and calling it one would
      // promise a screen reader menu semantics its contents don't have.
      role={state.render ? 'group' : 'menu'}
      aria-label={state.render ? state.title : undefined}
      onClick={(e) => e.stopPropagation()}
    >
      {state.title && <div class="menu-title">{state.title}</div>}
      {state.render?.(closeMenu)}
      {state.items.map((item, i) => (
        <button
          key={i}
          class="menu-item"
          role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
          data-danger={item.danger ? '1' : '0'}
          data-sep={item.separated ? '1' : '0'}
          data-checked={item.checked ? '1' : undefined}
          aria-checked={item.checked === undefined ? undefined : item.checked}
          disabled={item.disabled}
          onClick={async () => {
            closeMenu()
            await item.onSelect()
          }}
        >
          {item.icon && <span class="menu-icon">{item.icon}</span>}
          <span>{item.label}</span>
          {item.checked && (
            <span class="menu-check">
              <IconCheck size={15} />
            </span>
          )}
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
