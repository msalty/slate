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
import { initVault, applySharedSettingsSafe } from './app/boot'
import './styles/app.css'

const root = document.getElementById('app')!

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

  render(<App />, root)

  // Everything below is deliberately after first paint.
  void applySharedSettingsSafe()
  void registerServiceWorker()
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return
  try {
    const { registerSW } = await import('virtual:pwa-register')
    registerSW({
      immediate: true,
      onNeedRefresh() {
        // A new build is waiting. Don't interrupt: the user reloads when ready.
        const bar = document.createElement('div')
        bar.className = 'toast'
        bar.textContent = 'A new version is ready — reload to update.'
        bar.style.cursor = 'pointer'
        bar.onclick = () => location.reload()
        document.body.appendChild(bar)
        setTimeout(() => bar.remove(), 12000)
      },
    })
  } catch (e) {
    console.warn('[slate] service worker not registered', e)
  }
}

void main()
