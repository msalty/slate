/**
 * Following a link from inside the editor.
 *
 * Two things make this more than an `onclick`. A link in the text is a
 * decoration rather than an anchor — CodeMirror owns that DOM, so the editor has
 * to recognise the span itself. And a tap is not a click: the mouse events a
 * phone synthesises from one arrive after the touch is already over, too late to
 * keep the caret from landing in the text, and the `click` trailing them lands
 * on the menu the tap just opened and dismisses it again. That is why a link on
 * a phone did nothing but summon the keyboard.
 *
 * So touch is handled as touch — remembered on `touchstart`, acted on at
 * `touchend`, and cancelled there, which is what stops the browser replaying the
 * whole gesture as a mouse.
 */

import { EditorView } from '@codemirror/view'
import { requestOpenLink, requestUri } from './context'

/**
 * Everything in a note that is worth a tap. Plain anchors are in the list
 * because a table cell's content is rendered by us into widget DOM, where a
 * link really is an `<a>` rather than a decorated span.
 */
const LINK_SELECTOR = '[data-href], [data-wikilink], [data-tag], a[href]'

/** The link-like element an event happened in, if it happened in one. */
export function linkElementAt(target: EventTarget | null): HTMLElement | null {
  const el = target as HTMLElement | null
  return (el?.closest?.(LINK_SELECTOR) as HTMLElement | null) ?? null
}

/** Widget DOM has no document position of its own; fall back to the caret. */
function posOf(view: EditorView, el: HTMLElement): number {
  try {
    return view.posAtDOM(el)
  } catch {
    return view.state.selection.main.head
  }
}

/**
 * Act on a link element. `via` says how it was reached; the shell decides what
 * that means, because opening outright is right for a pointer and a menu is the
 * only way to reach a link's own text on a touch screen.
 */
export function followLink(
  view: EditorView,
  el: HTMLElement,
  at: { x: number; y: number; via: 'click' | 'menu' },
): boolean {
  const wiki = el.dataset.wikilink
  if (wiki !== undefined) {
    requestOpenLink(wiki, el.dataset.exists === '1')
    return true
  }
  const tag = el.dataset.tag
  if (tag !== undefined) {
    dispatchEvent(new CustomEvent('slate:open-tag', { detail: { tag } }))
    return true
  }
  const href = el.dataset.href ?? el.getAttribute('href')
  if (!href) return false
  requestUri(href, { x: at.x, y: at.y, pos: posOf(view, el), via: at.via })
  return true
}

/** True when this element is a link the platform, not the note, would open. */
function isUriLink(el: HTMLElement): boolean {
  return el.dataset.wikilink === undefined && el.dataset.tag === undefined
}

/**
 * The link a pointer has already been acted on for, and when.
 *
 * Both halves of a click have to be handled. `mousedown` is the only place the
 * caret can be stopped from landing in the text, and the `click` that trails it
 * is where the browser follows a link of its own accord — a link in a rendered
 * table cell is a real `<a>`, so without this it opens once for us and once for
 * the browser. Handling both also means a browser that never delivers the
 * mousedown to us still opens the link.
 *
 * The timestamp is what keeps the flag from going stale: a mousedown that turns
 * into a drag produces no click at all, and the flag would otherwise swallow
 * whichever click came next.
 */
let acted: { el: HTMLElement; at: number } | null = null
const ACTED_MS = 1000

function remember(el: HTMLElement, handled: boolean): boolean {
  acted = handled ? { el, at: Date.now() } : null
  return handled
}

/** True when this element is the one the pointer has just been acted on for. */
function alreadyActed(el: HTMLElement): boolean {
  const last = acted
  acted = null
  return !!last && last.el === el && Date.now() - last.at < ACTED_MS
}

/**
 * The click half. It never lets the browser act on the link itself, and opens
 * it only when the mousedown before it did not.
 */
function onClick(view: EditorView, event: MouseEvent): boolean {
  const el = linkElementAt(event.target)
  if (!el) return false
  event.preventDefault()
  if (alreadyActed(el)) return true
  return followLink(view, el, { x: event.clientX, y: event.clientY, via: 'click' })
}

/**
 * The finger that went down on a link, and where. Module-level because there is
 * one finger doing one thing at a time, and because both the editor's own
 * handlers and a table cell's have to share it.
 */
let tap: { x: number; y: number; el: HTMLElement } | null = null

/** A drag is a scroll or a text selection, not a tap on what it started on. */
const TAP_SLOP = 10

function onTouchStart(event: TouchEvent) {
  const t = event.touches[0]
  const el = linkElementAt(event.target)
  tap = t && el ? { x: t.clientX, y: t.clientY, el } : null
}

function onTouchMove(event: TouchEvent) {
  const t = event.touches[0]
  if (!tap || !t) return
  if (Math.hypot(t.clientX - tap.x, t.clientY - tap.y) > TAP_SLOP) tap = null
}

function onTouchEnd(view: EditorView, event: TouchEvent): boolean {
  const hit = tap
  tap = null
  if (!hit) return false
  /*
   * Cancelling the tap is the whole point: it stops the browser synthesising
   * the mouse events and the click, which would otherwise put the caret in the
   * text and then close the menu this is about to open.
   */
  event.preventDefault()
  return remember(hit.el, followLink(view, hit.el, { x: hit.x, y: hit.y, via: 'click' }))
}

export const linkClicks = EditorView.domEventHandlers({
  mousedown(event, view) {
    const el = linkElementAt(event.target)
    if (!el) return false
    // Left button only for a URL: the right one belongs to the menu handler
    // below, and the middle one to whatever the platform does with it.
    if (isUriLink(el) && event.button !== 0) return false
    event.preventDefault()
    return remember(el, followLink(view, el, { x: event.clientX, y: event.clientY, via: 'click' }))
  },
  click(event, view) {
    return onClick(view, event)
  },
  /**
   * Right-click on a link is the desktop way to reach its text: opening is one
   * plain click, so the menu is where "edit this link" has to live.
   */
  contextmenu(event, view) {
    const el = linkElementAt(event.target)
    if (!el || !isUriLink(el)) return false
    event.preventDefault()
    return followLink(view, el, { x: event.clientX, y: event.clientY, via: 'menu' })
  },
  touchstart(event) {
    onTouchStart(event)
    return false
  },
  touchmove(event) {
    onTouchMove(event)
    return false
  },
  touchend(event, view) {
    return onTouchEnd(view, event)
  },
  touchcancel() {
    tap = null
    return false
  },
})

/**
 * The same handling, wired directly onto DOM the editor's own handlers never
 * see.
 *
 * A table cell in rich text is its own editing host — the widget claims every
 * event inside it, so the extension above never runs there — and a link in a
 * cell is still a link.
 */
export function wireLinkTaps(view: EditorView, host: HTMLElement): void {
  host.addEventListener('mousedown', (event) => {
    const el = linkElementAt(event.target)
    if (!el) return
    event.preventDefault()
    remember(
      el,
      followLink(view, el, {
        x: event.clientX,
        y: event.clientY,
        via: event.button === 2 ? 'menu' : 'click',
      }),
    )
  })
  // A cell's links really are anchors, so the browser would follow this one
  // itself, on top of whatever the mousedown above already did with it.
  host.addEventListener('click', (event) => {
    onClick(view, event)
  })
  host.addEventListener('touchstart', onTouchStart)
  host.addEventListener('touchmove', onTouchMove)
  host.addEventListener('touchend', (event) => {
    onTouchEnd(view, event)
  })
  host.addEventListener('touchcancel', () => {
    tap = null
  })
}
