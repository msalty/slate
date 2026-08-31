/**
 * Layout modes.
 *
 * The old version let CSS media queries reposition panels on their own, which
 * is why resizing the window felt like things were rearranging underneath you:
 * a panel could silently change from inline to a floating overlay mid-drag.
 *
 * Here the mode is explicit state, and two rules keep resizing calm:
 *
 *   1. **The editor never yields.** It has a guaranteed minimum width. When
 *      space runs out, a side panel is dropped — never the writing surface.
 *   2. **Resizing never opens or closes anything.** Crossing a breakpoint only
 *      changes whether a panel *can* be inline. Anything floating is closed on
 *      the way past, so you never end up with a drawer you didn't ask for
 *      covering the note.
 */

import { signal, computed, effect } from '@preact/signals'
import { settings } from '../core/settings'

export type LayoutMode = 'compact' | 'medium' | 'wide'

/**
 * Breakpoints are derived from what the panes actually need, not from device
 * classes: list (300) + editor minimum (460) = 760, and adding the sidebar
 * (232) plus breathing room puts three inline panes at 1180.
 */
export const COMPACT_MAX = 760
export const WIDE_MIN = 1180
/** Below this, the calendar rail overlays instead of sitting inline. */
export const RAIL_INLINE_MIN = 1400

export const viewportWidth = signal(
  typeof window === 'undefined' ? 1440 : window.innerWidth,
)

export const layoutMode = computed<LayoutMode>(() =>
  viewportWidth.value < COMPACT_MAX ? 'compact' : viewportWidth.value < WIDE_MIN ? 'medium' : 'wide',
)

/** Which floating panel is open. Only meaningful outside `wide`. */
export const drawer = signal<'sidebar' | 'rail' | null>(null)

export function installLayoutWatcher(): () => void {
  const onResize = () => {
    viewportWidth.value = window.innerWidth
    /*
     * Nothing in this app ever scrolls the body — every list and the editor own
     * their own scroller — so a scrolled body is always iOS having done it to
     * us, usually on a rotation or when the keyboard closes. It drags the whole
     * shell up and leaves the floating tab bar somewhere in the middle of the
     * screen. Putting it back here is the cheap fix.
     */
    window.scrollTo(0, 0)
  }
  const onOrientation = () => {
    onResize()
    // Safari settles on the new viewport a beat after the event fires.
    setTimeout(onResize, 60)
  }
  addEventListener('resize', onResize, { passive: true })
  addEventListener('orientationchange', onOrientation)
  onResize()
  return () => {
    removeEventListener('resize', onResize)
    removeEventListener('orientationchange', onOrientation)
  }
}

// Close any floating panel when the mode changes, so a resize can never leave
// a drawer hanging over the editor.
let lastMode: LayoutMode | undefined
effect(() => {
  const m = layoutMode.value
  if (lastMode !== undefined && lastMode !== m) drawer.value = null
  lastMode = m
})

/* -------------------------------------------------------- derived visibility */

/** Is the sidebar showing, and is it inline or floating? */
export const sidebarState = computed<'hidden' | 'inline' | 'floating'>(() => {
  if (layoutMode.value === 'wide') return settings.value.showSidebar ? 'inline' : 'hidden'
  return drawer.value === 'sidebar' ? 'floating' : 'hidden'
})

export const railState = computed<'hidden' | 'inline' | 'floating'>(() => {
  if (layoutMode.value === 'wide' && viewportWidth.value >= RAIL_INLINE_MIN)
    return settings.value.showRightRail ? 'inline' : 'hidden'
  return drawer.value === 'rail' ? 'floating' : 'hidden'
})

/** The note list is inline everywhere except compact, where it's a whole tab. */
export const listInline = computed(() => layoutMode.value !== 'compact')

export function toggleSidebar() {
  if (layoutMode.value === 'wide') {
    settings.value = { ...settings.value, showSidebar: !settings.value.showSidebar }
  } else {
    drawer.value = drawer.value === 'sidebar' ? null : 'sidebar'
  }
}

export function toggleRail() {
  if (layoutMode.value === 'wide' && viewportWidth.value >= RAIL_INLINE_MIN) {
    settings.value = { ...settings.value, showRightRail: !settings.value.showRightRail }
  } else {
    drawer.value = drawer.value === 'rail' ? null : 'rail'
  }
}

export function closeDrawer() {
  drawer.value = null
}
