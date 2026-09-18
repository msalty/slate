/**
 * The part of the layout that has to remember something.
 *
 * Everything else here is a pure function of the viewport and two settings, and
 * reads that way. The animation is not: a panel on its way out has to outlive
 * the state that says it is gone, and the movement has to be switched off for
 * changes nobody asked for. Both of those are timers and both are easy to break
 * by looking only at the open case, so they are pinned down here.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

/** A fresh module, since the mode-crossing watcher keeps state between calls. */
async function fresh(width = 1000) {
  vi.resetModules()
  const layout = await import('./layout')
  layout.viewportWidth.value = width
  return layout
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('a drawer leaving', () => {
  it('stays mounted for the length of its slide, then goes', async () => {
    const l = await fresh()
    expect(l.layoutMode.value).toBe('medium')

    l.toggleSidebar()
    expect(l.sidebarState.value).toBe('floating')
    expect(l.sidebarMounted.value).toBe(true)

    l.closeDrawer()
    // Closed as far as the rest of the app is concerned...
    expect(l.sidebarState.value).toBe('hidden')
    // ...but still there, and marked as leaving, so it has something to animate.
    expect(l.sidebarMounted.value).toBe(true)
    expect(l.leavingDrawer.value).toBe('sidebar')

    vi.advanceTimersByTime(l.PANEL_MS - 1)
    expect(l.sidebarMounted.value).toBe(true)

    vi.advanceTimersByTime(1)
    expect(l.sidebarMounted.value).toBe(false)
    expect(l.leavingDrawer.value).toBe(null)
  })

  it('is caught rather than crossed when the same panel is re-opened mid-exit', async () => {
    const l = await fresh()
    l.toggleSidebar()
    l.closeDrawer()
    vi.advanceTimersByTime(l.PANEL_MS / 2)

    l.toggleSidebar()
    expect(l.sidebarState.value).toBe('floating')
    expect(l.leavingDrawer.value).toBe(null)

    // The old exit timer must not fire into the re-opened panel.
    vi.advanceTimersByTime(l.PANEL_MS * 2)
    expect(l.sidebarState.value).toBe('floating')
    expect(l.sidebarMounted.value).toBe(true)
  })

  it('swaps with the other panel, one arriving while the other leaves', async () => {
    const l = await fresh()
    l.toggleSidebar()
    l.toggleRail()

    expect(l.railState.value).toBe('floating')
    expect(l.leavingDrawer.value).toBe('sidebar')
    expect(l.sidebarMounted.value).toBe(true)

    vi.advanceTimersByTime(l.PANEL_MS)
    expect(l.sidebarMounted.value).toBe(false)
    expect(l.railMounted.value).toBe(true)
  })
})

describe('what is allowed to move', () => {
  it('animates a toggle, and stops once the movement is over', async () => {
    const l = await fresh()
    expect(l.panelsAnimating.value).toBe(false)

    l.toggleSidebar()
    expect(l.panelsAnimating.value).toBe(true)

    vi.advanceTimersByTime(l.PANEL_MS)
    // Still on: the gate outlasts the transition rather than cutting it short.
    expect(l.panelsAnimating.value).toBe(true)

    vi.advanceTimersByTime(100)
    expect(l.panelsAnimating.value).toBe(false)
  })

  it('does not animate a resize that crosses a breakpoint', async () => {
    const l = await fresh(1000)
    l.toggleSidebar()
    vi.advanceTimersByTime(l.PANEL_MS + 100)
    expect(l.panelsAnimating.value).toBe(false)

    // Wide enough for the sidebar to be a column rather than a drawer.
    l.viewportWidth.value = 1440
    expect(l.layoutMode.value).toBe('wide')
    expect(l.panelsAnimating.value).toBe(false)
    // And the drawer is gone outright, not sliding: nothing to animate out of.
    expect(l.leavingDrawer.value).toBe(null)
    expect(l.drawer.value).toBe(null)
  })

  it('calls off a movement the crossing interrupts', async () => {
    const l = await fresh(1000)
    // A toggle and then a resize before it has finished: the crossing wins, or
    // the panels animate into their new arrangement on the way past.
    l.toggleSidebar()
    expect(l.panelsAnimating.value).toBe(true)

    l.viewportWidth.value = 1440
    expect(l.panelsAnimating.value).toBe(false)
  })

  it('drops an open drawer when the rail earns its own column', async () => {
    const l = await fresh(1300)
    expect(l.layoutMode.value).toBe('wide')

    l.toggleRail()
    expect(l.railState.value).toBe('floating')

    // Past RAIL_INLINE_MIN the rail is a column, so the drawer it was is moot.
    l.viewportWidth.value = l.RAIL_INLINE_MIN
    expect(l.drawer.value).toBe(null)
    expect(l.leavingDrawer.value).toBe(null)
  })
})

describe('what stays in the tree', () => {
  it('keeps a hidden sidebar mounted on wide, so its column can collapse', async () => {
    const l = await fresh(1440)
    // Whatever the setting says, on wide the element is there either way.
    expect(l.sidebarMounted.value).toBe(true)
  })

  it('never mounts the rail on a phone', async () => {
    const l = await fresh(600)
    expect(l.layoutMode.value).toBe('compact')
    l.toggleRail()
    expect(l.railMounted.value).toBe(false)
  })
})
