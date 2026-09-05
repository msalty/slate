/**
 * A note in a window of its own.
 *
 * Gmail's compose window is the model: the note you are working on can step out
 * of the app into its own small window, next to whatever you are writing about,
 * and step back in when you are done. Hold Shift over the focus-mode button and
 * that is what it becomes — the same gesture, and the same "you have to know it
 * is there" discretion, so nothing about the ordinary app changes.
 *
 * Three things make it safe rather than a way to lose an afternoon's typing:
 *
 *   1. **One window owns a note at a time.** Popping out hands the note over:
 *      the pane it came from flushes its buffer, destroys its editor and shows
 *      a card in its place, so there is never a second caret — or a second
 *      autosave — in the same file. Closing the window hands it straight back.
 *   2. **The windows tell each other what they wrote.** Each window is a whole
 *      separate copy of the app over one IndexedDB, so a write next door is
 *      invisible until someone says so. `onVaultWrite` → BroadcastChannel →
 *      `adoptFromStorage` is that sentence, and it is what keeps the note list,
 *      the search index and the sync engine current in the window that has the
 *      backend connected.
 *   3. **Only the main window syncs.** A popout is an editor, not a second
 *      copy of the app: it saves locally and lets the window that opened it
 *      push. Two sync engines reconciling one vault against one remote is a
 *      race nobody needs.
 *
 * None of this machinery exists until a note is actually popped out: no
 * channel, no interval, no listener.
 */

import { signal } from '@preact/signals'
import { adoptFromStorage, onVaultWrite } from '../core/vault'

/** The URL a popout window opens with: `#note=<path>&w=<window id>`. */
const HASH = /^#note=([^&]*)(?:&w=([\w-]+))?$/

const CHANNEL = 'slate:windows'

/** Big enough for a comfortable measure, small enough to sit beside something. */
const FEATURES = 'popup=yes,width=900,height=940'

interface Popout {
  /**
   * The window itself — absent for one this session did not open, which means
   * a window that survived a reload of this one and answered its `hello`. There
   * is no way to get a handle back for it, so it is asked over the channel
   * rather than told directly.
   */
  win?: Window
  /** The note it is currently holding — a link followed inside it moves this. */
  path: string
}

/**
 * Set for the lifetime of a tab that has popped something out, so that a
 * reload of the main window knows to go looking for windows it can no longer
 * see. Session storage is per-tab and goes when the tab does, which is exactly
 * the lifetime of the thing it is remembering.
 */
const SEEN = 'slate:popout-opened'

function remember() {
  try {
    sessionStorage.setItem(SEEN, '1')
  } catch {
    /* Private mode, or storage refused. Only reload recovery is lost. */
  }
}

function wasUsed(): boolean {
  try {
    return sessionStorage.getItem(SEEN) === '1'
  } catch {
    return false
  }
}

/** What this window asked for in its URL, if it is a popout at all. */
function request(): { path: string; id?: string } | undefined {
  if (typeof location === 'undefined') return undefined
  const m = HASH.exec(location.hash)
  if (!m) return undefined
  try {
    const path = decodeURIComponent(m[1])
    return path ? { path, id: m[2] } : undefined
  } catch {
    return undefined
  }
}

/**
 * Read once, at module load, and never again: whether a window is a popout is
 * decided by the URL it opened with, and changing the hash afterwards must not
 * turn the main window into one halfway through a session.
 */
const self = request()

/** The note this window was opened to hold, for the popout shell to render. */
export function popoutRequest(): string | undefined {
  return self?.path
}

export function isPopoutWindow(): boolean {
  return self !== undefined
}

/**
 * Whether this device can pop a note out at all.
 *
 * BroadcastChannel is the load-bearing half: without it the two windows cannot
 * tell each other what they wrote, and a popout would be a second app quietly
 * overwriting the first. Better to leave the button out than to offer that.
 */
export function canPopOut(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.open === 'function' &&
    typeof BroadcastChannel !== 'undefined'
  )
}

/* ------------------------------------------------------- the shared channel */

type Message =
  /** Paths this window has just written durably. */
  | { kind: 'wrote'; paths: string[] }
  /** A popout naming the note it holds, or letting go of it as it closes. */
  | { kind: 'holds'; id: string; path?: string }
  /** A main window that has just reloaded, asking who is holding what. */
  | { kind: 'hello' }
  /** …and asking one of them to close, for a window it can no longer address. */
  | { kind: 'release'; path: string }

let channel: BroadcastChannel | undefined

/** The note this window is holding, when this window is a popout. */
let holding: string | undefined

/**
 * Start mirroring writes to and from the other windows of this vault.
 *
 * Called by a popout as it boots and by the main window the moment it opens
 * one, so a session that never pops anything out never opens a channel.
 * Idempotent: both of those can happen in either order.
 */
export function installMirror(): void {
  if (channel || !canPopOut()) return
  channel = new BroadcastChannel(CHANNEL)
  channel.onmessage = (e: MessageEvent<Message>) => {
    const msg = e.data
    if (!msg) return
    if (msg.kind === 'wrote') void adoptFromStorage(msg.paths)
    else if (msg.kind === 'holds') held(msg.id, msg.path)
    else if (msg.kind === 'hello') reportHolding(holding)
    else if (msg.kind === 'release' && msg.path === holding) window.close()
  }
  // Adopting does not write, so this cannot bounce back and forth.
  onVaultWrite((paths) => channel?.postMessage({ kind: 'wrote', paths } satisfies Message))
}

/* ------------------------------------------- the main window's side of it */

/** Popouts this window has opened, by the id it gave each one. */
const popouts = new Map<string, Popout>()

/**
 * The notes currently held by a window of their own. Read through
 * `isPoppedOut` below, which is what subscribes the editor pane to it.
 */
const poppedOut = signal<readonly string[]>([])

let watcher: ReturnType<typeof setInterval> | undefined

function publish() {
  poppedOut.value = [...popouts.values()].map((p) => p.path)
}

/**
 * Re-read a note that has just come back, twice.
 *
 * A window closing is not a good moment to be sure a message got out, and the
 * last autosave in it may still have been in flight. The immediate read covers
 * the ordinary case and the late one covers the write that landed a moment
 * after the window went away; both are a single row out of IndexedDB, and the
 * editor folds whatever they turn up into the buffer the way it does a sync.
 */
function reread(path: string) {
  void adoptFromStorage([path])
  setTimeout(() => void adoptFromStorage([path]), 600)
}

/**
 * Notice windows that have gone without saying so — closed from the OS, or
 * taken with the browser. Runs only while something is popped out.
 */
function watch() {
  if (watcher !== undefined) return
  watcher = setInterval(() => {
    for (const [id, p] of popouts) {
      // A window from before a reload has no handle to ask; it says goodbye
      // over the channel instead, and "Bring it back" works on it regardless.
      if (!p.win || !p.win.closed) continue
      popouts.delete(id)
      reread(p.path)
    }
    publish()
    if (![...popouts.values()].some((p) => p.win)) {
      clearInterval(watcher)
      watcher = undefined
    }
  }, 700)
}

/** A popout has said which note it is holding now, or that it is letting go. */
function held(id: string, path?: string) {
  const p = popouts.get(id)
  if (!p) {
    // Not one this window opened: a popout answering the `hello` sent after a
    // reload. Take its word for it — the point is that the pane must not open a
    // note somebody else is typing into.
    if (path !== undefined) {
      popouts.set(id, { path })
      publish()
    }
    return
  }
  if (path === undefined) {
    popouts.delete(id)
    reread(p.path)
  } else if (path !== p.path) {
    // A link followed inside the popout: the note it left goes back to the pane
    // it came from, and the one it arrived at leaves.
    const from = p.path
    p.path = path
    reread(from)
  }
  publish()
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10)
}

function find(path: string): Popout | undefined {
  for (const p of popouts.values()) if (p.path === path) return p
  return undefined
}

/** Is this note being held by a window this one opened? */
export function isPoppedOut(path: string): boolean {
  return poppedOut.value.includes(path)
}

/**
 * Hand a note to a window of its own. Returns false only if the browser
 * refused to open one, which in practice means a popup blocker.
 *
 * Called straight out of the click, with no `await` in front of it: a window
 * opened after the gesture has finished is a window the browser blocks.
 */
export function openPopout(path: string): boolean {
  // A window that has been closed since the last sweep still has an entry here,
  // and it must not be mistaken for the one this asks for.
  for (const [id, p] of popouts) if (p.win?.closed) popouts.delete(id)
  const already = find(path)
  if (already) {
    already.win?.focus()
    return true
  }
  const id = newId()
  const url = new URL(location.href)
  url.hash = `#note=${encodeURIComponent(path)}&w=${id}`
  const win = window.open(url.toString(), `slate-note-${id}`, FEATURES)
  if (!win) return false
  installMirror()
  remember()
  popouts.set(id, { win, path })
  publish()
  watch()
  win.focus()
  return true
}

/**
 * Pick the registry back up after this window has reloaded.
 *
 * A reload takes the map above with it, and the windows it was tracking are
 * still out there holding notes. Without this the pane would open one of them
 * as if it were free, and two windows would be typing into one file. Only a tab
 * that has actually popped something out asks, so nothing else opens a channel.
 */
export function resumePopouts(): void {
  if (!wasUsed() || !canPopOut()) return
  installMirror()
  channel?.postMessage({ kind: 'hello' } satisfies Message)
}

/** Bring the window holding a note to the front, where there is one to raise. */
export function focusPopout(path: string): void {
  find(path)?.win?.focus()
}

/** Whether that window can be raised — false for one from before a reload. */
export function canFocusPopout(path: string): boolean {
  return !!find(path)?.win
}

/**
 * Take a note back into this window. The popout is closed, which flushes it,
 * and the note is re-read so the pane opens what that window last wrote rather
 * than what this one was holding when it let go.
 */
export function bringBack(path: string): void {
  for (const [id, p] of popouts) {
    if (p.path !== path) continue
    popouts.delete(id)
    if (p.win) {
      try {
        p.win.close()
      } catch {
        /* Already gone, or refused. Either way this window is done with it. */
      }
    } else {
      // No handle to close — from before a reload — so ask it over the channel.
      // The entry goes either way, so this can never leave a note stranded
      // behind a card with nothing left to answer it.
      channel?.postMessage({ kind: 'release', path } satisfies Message)
    }
  }
  publish()
  reread(path)
}

/* ----------------------------------------------- the popout window's side */

/**
 * Tell the window that opened this one which note is on screen here — on every
 * change, and once more with nothing as the window closes, which is what puts
 * the note back in the pane it came from.
 */
export function reportHolding(path?: string): void {
  if (!self?.id || !channel) return
  holding = path
  channel.postMessage({ kind: 'holds', id: self.id, path } satisfies Message)
}
