/** Test environment shims: an in-process IndexedDB and the few browser globals the core touches. */

import 'fake-indexeddb/auto'

// The sync engine short-circuits when the browser reports being offline.
if (!('onLine' in navigator)) {
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
}

// Settings persistence asks the browser to keep data; a no-op is fine here.
if (!navigator.storage) {
  Object.defineProperty(navigator, 'storage', {
    value: { persist: async () => false, persisted: async () => false, estimate: async () => ({}) },
    configurable: true,
  })
}
