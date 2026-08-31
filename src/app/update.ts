/**
 * App updates.
 *
 * The service worker precaches the whole shell, which is what makes a cold
 * start work with no network — and also what makes a stale build so sticky.
 *
 * The part that surprises people: a new worker installs fine and then *waits*.
 * It cannot take over while the old one still controls an open page, and a
 * plain `location.reload()` does not release that control — the browser keeps
 * the page controlled across the navigation. So reloading, even a dozen times,
 * leaves you on the old build; only closing every tab (or clearing site data)
 * ever hands over. The fix is to tell the waiting worker to skip waiting and
 * only then reload, which is what `apply()` does.
 *
 * Everything here is careful to touch only the *code* caches. Notes live in
 * IndexedDB and are never involved in an update.
 */

import { signal } from '@preact/signals'

/** A newer build is installed and waiting to take over. */
export const updateReady = signal(false)

/** Set by main.tsx from registerSW()'s return value; see applyViaPlugin. */
let pluginUpdate: ((reload?: boolean) => Promise<void>) | undefined

export function setPluginUpdater(fn: (reload?: boolean) => Promise<void>) {
  pluginUpdate = fn
}

export const BUILD_ID = __BUILD_ID__

function supported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator
}

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!supported()) return undefined
  return (await navigator.serviceWorker.getRegistration()) ?? undefined
}

/** Resolve once `sw` leaves the installing state, or after `ms`. */
function settled(sw: ServiceWorker, ms = 20_000): Promise<void> {
  if (sw.state !== 'installing') return Promise.resolve()
  return new Promise((res) => {
    const done = () => {
      if (sw.state !== 'installing') {
        sw.removeEventListener('statechange', done)
        res()
      }
    }
    sw.addEventListener('statechange', done)
    setTimeout(() => {
      sw.removeEventListener('statechange', done)
      res()
    }, ms)
  })
}

export type CheckResult = 'ready' | 'current' | 'unsupported'

/**
 * Ask the browser to re-fetch sw.js and install it if it differs.
 *
 * `update()` deliberately bypasses the HTTP cache for the worker script, so
 * this is a real check against the server rather than a look at what we already
 * have — which is why it needs the network and reports honestly without it.
 */
export async function check(): Promise<CheckResult> {
  const reg = await registration()
  if (!reg) return 'unsupported'

  try {
    await reg.update()
  } catch {
    // The browser's own message here is famously unhelpful ("an unknown error
    // occurred when fetching the script"), and the cause is nearly always one
    // of these two.
    throw new Error(
      navigator.onLine
        ? 'Could not reach the server to check for a new build.'
        : 'No connection — checking for a new build needs one.',
    )
  }
  // update() returns as soon as the fetch is done; installing the new build
  // (precaching every asset) can take a good deal longer.
  if (reg.installing) await settled(reg.installing)

  const ready = !!reg.waiting
  updateReady.value = ready
  return ready ? 'ready' : 'current'
}

/**
 * Hand over to the waiting build and reload onto it.
 *
 * Waits for `controllerchange` so the reload lands on the new worker rather
 * than racing it — without that the reload can be served by the old one and
 * nothing appears to happen.
 */
export async function apply(): Promise<void> {
  const reg = await registration()
  if (!reg?.waiting) {
    location.reload()
    return
  }

  // The plugin's own updateSW() does exactly this and is the better path when
  // it is available, because it is wired to the worker it registered.
  if (pluginUpdate) {
    await pluginUpdate(true)
    return
  }

  await new Promise<void>((res) => {
    navigator.serviceWorker.addEventListener('controllerchange', () => res(), { once: true })
    reg.waiting?.postMessage({ type: 'SKIP_WAITING' })
    setTimeout(res, 5000)
  })
  location.reload()
}

/**
 * The escape hatch, for an install that is wedged badly enough that `check()`
 * finds nothing and the app is still stale.
 *
 * Unregisters every worker for this origin and empties Cache Storage, then
 * re-fetches the shell straight from the network so the reload cannot be
 * answered from the HTTP cache either. This is the same ground as "clear the
 * browser cache", minus the part where that also throws away everything else
 * the browser is holding for this site.
 *
 * Notes are in IndexedDB and are not touched. It does need the network, though
 * — with the caches gone and no connection there would be nothing to boot from.
 */
export async function reinstall(): Promise<void> {
  if (!navigator.onLine) throw new Error('Reinstalling needs a connection — the cached copy is what gets replaced.')

  if (supported()) {
    const regs = await navigator.serviceWorker.getRegistrations()
    await Promise.all(regs.map((r) => r.unregister()))
  }
  if ('caches' in globalThis) {
    const keys = await caches.keys()
    await Promise.all(keys.map((k) => caches.delete(k)))
  }

  // Pull a fresh copy of the shell before navigating: `cache: 'reload'` skips
  // the HTTP cache on the way out and replaces the stored entry on the way
  // back, so the reload below gets the new document.
  try {
    await fetch(new URL('index.html', location.href), { cache: 'reload' })
  } catch {
    // A miss here is not fatal — the reload will go to the network anyway.
  }

  location.reload()
}
