/**
 * Boot sequence.
 *
 * Order matters here and is the reason the app opens instantly:
 *   1. settings from IndexedDB           (a few ms)
 *   2. the whole vault from IndexedDB     (tens of ms, even at thousands of notes)
 *   3. render — the UI is now fully usable, online or not
 *   4. only then: shared prefs, the sync engine, the service worker
 *
 * Nothing before step 3 touches the network.
 */

import { render } from 'preact'
import { App } from './ui/App'
import { PopoutWindow, preparePopout } from './ui/PopoutWindow'
import { popoutRequest } from './ui/popout'
import { initVault, applySharedSettingsSafe } from './app/boot'
import { apply as applyUpdate, setPluginUpdater, updateReady } from './app/update'
import './styles/app.css'

const root = document.getElementById('app')!

/**
 * A note popped out into a window of its own opens the same document with the
 * note's path in its hash, and boots into a one-note shell instead of the app.
 * Everything above this line is the same either way — the vault it reads is the
 * same IndexedDB, so the window opens as fast as the app does.
 */
const popout = popoutRequest()

async function main() {
  try {
    await initVault()
  } catch (e) {
    console.error('[slate] failed to open the local database', e)
    root.innerHTML = `<div style="padding:48px;max-width:640px;margin:0 auto;font:14px/1.7 -apple-system,system-ui,sans-serif">
      <h2 style="font-size:18px">Slate couldn't open its local database</h2>
      <p>This usually means the browser is in a private window, or storage is blocked for this site.
      Your notes are safe on the server if sync was configured.</p>
      <p style="color:#888">${(e as Error).message}</p>
    </div>`
    return
  }

  if (popout) {
    preparePopout(popout)
    render(<PopoutWindow />, root)
  } else {
    render(<App />, root)
  }

  // Everything below is deliberately after first paint.
  void applySharedSettingsSafe()
  /*
   * Not in a popout. The service worker is already installed by the window this
   * one came out of, and an update prompt belongs in the app rather than in a
   * window someone is in the middle of writing in.
   */
  if (!popout) void registerServiceWorker()
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return
  try {
    const { registerSW } = await import('virtual:pwa-register')
    const updateSW = registerSW({
      immediate: true,
      onNeedRefresh() {
        // A new build is waiting. Don't interrupt: the user updates when ready.
        updateReady.value = true
        const bar = document.createElement('div')
        bar.className = 'toast'
        bar.textContent = 'A new version is ready — tap to update.'
        bar.style.cursor = 'pointer'
        /*
         * Not location.reload(). A waiting worker cannot take over while the
         * old one still controls this page, and reloading does not release it,
         * so a plain reload lands back on the same build — the update stays
         * stuck until every tab is closed. applyUpdate() tells the new worker
         * to skip waiting first.
         */
        bar.onclick = () => void applyUpdate()
        document.body.appendChild(bar)
        setTimeout(() => bar.remove(), 12000)
      },
    })
    setPluginUpdater(updateSW)
  } catch (e) {
    console.warn('[slate] service worker not registered', e)
  }
}

void main()
