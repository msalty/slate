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

/**
 * Whether this window may fall back to the phone layout at all.
 *
 * A window holding one popped-out note is a desktop window however narrow it is
 * dragged: the compact layout's back button and action sheet exist to get you
 * back to a list, and this window has none — they would be dead ends. The
 * popout window clears this as it boots; nothing else touches it.
 */
export const compactAllowed = signal(true)

export const layoutMode = computed<LayoutMode>(() =>
  viewportWidth.value < COMPACT_MAX && compactAllowed.value
    ? 'compact'
    : viewportWidth.value < WIDE_MIN
      ? 'medium'
      : 'wide',
)

/** Which floating panel is open. Only meaningful outside `wide`. */
export const drawer = signal<'sidebar' | 'rail' | null>(null)

/**
 * The panel that is on its way out, held in the tree until it has finished
 * sliding. There is nothing to animate out of an element that has already been
 * removed, and a drawer that slides in and then simply vanishes on close reads
 * as a glitch rather than as the same movement reversed.
 */
const closingDrawer = signal<'sidebar' | 'rail' | null>(null)

/** Read-only view of the above, for the components that draw the exit. */
export const leavingDrawer = computed(() => closingDrawer.value)

/**
 * How long a panel takes to open or close.
 *
 * Shared with `--panel-dur` in shell.css, which is the half that actually moves
 * anything: this is only how long a leaving element has to stay mounted for. The
 * two have to agree, so they are commented at both ends.
 */
export const PANEL_MS = 180

let closeTimer: ReturnType<typeof setTimeout> | undefined
let animateTimer: ReturnType<typeof setTimeout> | undefined

/**
 * Panels move only when somebody toggled one.
 *
 * A window resize that crosses a breakpoint changes exactly the same attributes
 * a toggle does. Letting CSS animate that would put panels in motion while the
 * window edge is being dragged — the "things rearranging underneath you" this
 * file's header is about — so the transition is opt-in rather than always on: a
 * toggle turns it on for the length of the movement and everything else,
 * resizes included, changes instantly.
 */
export const panelsAnimating = signal(false)

function animatePanels() {
  clearTimeout(animateTimer)
  panelsAnimating.value = true
  // A little past the end, so a transition is never cut short by its own gate.
  animateTimer = setTimeout(() => {
    panelsAnimating.value = false
  }, PANEL_MS + 40)
}

/** Open, close or swap the floating panel, animating whatever leaves. */
function setDrawer(next: 'sidebar' | 'rail' | null) {
  const prev = drawer.peek()
  if (prev === next) return
  clearTimeout(closeTimer)
  animatePanels()
  // Whatever was open is leaving — unless it is also what is arriving, which is
  // how re-opening a panel mid-exit catches it rather than crossing it.
  closingDrawer.value = prev !== null && prev !== next ? prev : null
  drawer.value = next
  if (closingDrawer.value !== null) {
    closeTimer = setTimeout(() => {
      closingDrawer.value = null
    }, PANEL_MS)
  }
}

/**
 * Drop the floating panel outright, with no exit. For resizes, not for clicks.
 *
 * It calls off any movement still in flight too. A toggle a moment before a
 * breakpoint crossing would otherwise leave the gate open across it, and the
 * inline panels would animate to their new arrangement — the one thing this is
 * being called to prevent.
 */
function dismissDrawer() {
  clearTimeout(closeTimer)
  clearTimeout(animateTimer)
  closingDrawer.value = null
  drawer.value = null
  panelsAnimating.value = false
}

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

/* ------------------------------------------------------------ soft keyboard */

/**
 * How much of the screen the on-screen keyboard is covering.
 *
 * The layout viewport does not shrink when a phone keyboard opens — only the
 * visual viewport does — so anything anchored to the bottom of the app, the end
 * of the note and the caret with it, ends up underneath the keyboard. Tracking
 * the difference lets the shell simply be shorter while the keyboard is up,
 * which puts the caret back on screen without anyone having to scroll.
 */
export const keyboardInset = signal(0)

/**
 * Below this, a shrunken visual viewport is a browser chrome bar — Safari's
 * collapsing URL bar moves it by about 60px — and relaying out the app for that
 * would make scrolling jump. Keyboards are far taller.
 */
const KEYBOARD_MIN = 120

export function installKeyboardWatcher(): () => void {
  const vv = typeof window === 'undefined' ? undefined : window.visualViewport
  if (!vv) return () => {}
  const apply = () => {
    // A pinch-zoomed visual viewport is smaller for reasons that have nothing
    // to do with a keyboard, and reacting to it would shrink the app instead.
    const covered = vv.scale > 1.05 ? 0 : Math.round(window.innerHeight - vv.height - vv.offsetTop)
    const next = covered > KEYBOARD_MIN ? covered : 0
    if (next !== keyboardInset.peek()) keyboardInset.value = next
  }
  vv.addEventListener('resize', apply)
  vv.addEventListener('scroll', apply)
  apply()
  return () => {
    vv.removeEventListener('resize', apply)
    vv.removeEventListener('scroll', apply)
  }
}

// Published as a variable so layout can react in CSS rather than in components.
effect(() => {
  if (typeof document === 'undefined') return
  document.documentElement.style.setProperty('--kb-inset', `${keyboardInset.value}px`)
})

/* -------------------------------------------------------- derived visibility */

/** Is there room for the calendar rail to sit inline rather than overlay? */
const railMayBeInline = computed(
  () => layoutMode.value === 'wide' && viewportWidth.value >= RAIL_INLINE_MIN,
)

/*
 * Drop any floating panel when the layout crosses a boundary, so a resize can
 * never leave a drawer hanging over the editor. RAIL_INLINE_MIN counts as one of
 * those boundaries even though it doesn't change the mode: past it the rail
 * becomes an inline column, and the drawer it was a moment ago has no meaning.
 */
let lastMode: LayoutMode | undefined
let lastRailInline: boolean | undefined
effect(() => {
  const m = layoutMode.value
  const r = railMayBeInline.value
  const crossed =
    (lastMode !== undefined && lastMode !== m) ||
    (lastRailInline !== undefined && lastRailInline !== r)
  lastMode = m
  lastRailInline = r
  if (crossed) dismissDrawer()
})

/** Is the sidebar showing, and is it inline or floating? */
export const sidebarState = computed<'hidden' | 'inline' | 'floating'>(() => {
  if (layoutMode.value === 'wide') return settings.value.showSidebar ? 'inline' : 'hidden'
  return drawer.value === 'sidebar' ? 'floating' : 'hidden'
})

export const railState = computed<'hidden' | 'inline' | 'floating'>(() => {
  if (railMayBeInline.value) return settings.value.showRightRail ? 'inline' : 'hidden'
  return drawer.value === 'rail' ? 'floating' : 'hidden'
})

/**
 * Whether the panel is in the tree at all — which is not the same question as
 * whether it is showing, and is the reason both exist.
 *
 * In `wide` a collapsed panel stays mounted and its grid track is animated down
 * to zero width instead. That buys the animation something to run on, and it
 * keeps the panel's scroll position and its expanded folders across a hide —
 * the same bargain focus mode makes for the note list, and for the same reason
 * (see the comment on the focus-mode rules in shell.css). Elsewhere a closed
 * drawer really is gone, once it has finished leaving.
 */
export const sidebarMounted = computed(
  () =>
    layoutMode.value === 'wide' ||
    sidebarState.value !== 'hidden' ||
    closingDrawer.value === 'sidebar',
)

export const railMounted = computed(
  () =>
    layoutMode.value !== 'compact' &&
    (railMayBeInline.value || railState.value !== 'hidden' || closingDrawer.value === 'rail'),
)

/** The note list is inline everywhere except compact, where it's a whole tab. */
export const listInline = computed(() => layoutMode.value !== 'compact')

export function toggleSidebar() {
  if (layoutMode.value === 'wide') {
    animatePanels()
    settings.value = { ...settings.value, showSidebar: !settings.value.showSidebar }
  } else {
    setDrawer(drawer.value === 'sidebar' ? null : 'sidebar')
  }
}

export function toggleRail() {
  if (railMayBeInline.value) {
    animatePanels()
    settings.value = { ...settings.value, showRightRail: !settings.value.showRightRail }
  } else {
    setDrawer(drawer.value === 'rail' ? null : 'rail')
  }
}

export function closeDrawer() {
  setDrawer(null)
}
