import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  /*
   * Relative asset paths by default, so a built `dist/` works wherever it is
   * dropped — the domain root, `~/Sites/slate/`, a GitHub Pages subpath — with
   * no configuration and no rebuild. An absolute base would 404 under any
   * subdirectory, and most static hosts answer a 404 with index.html, so the
   * browser gets HTML where it asked for a module and reports a MIME error
   * rather than a missing file.
   *
   * This is safe here because the app has no client-side routing: there is a
   * single entry document, so a relative base can never resolve from the wrong
   * depth. Set VITE_BASE=/subdir/ if you need absolute paths anyway.
   */
  base: process.env.VITE_BASE ?? './',
  /*
   * A build stamp, so "Check for updates" has something to show for itself.
   * Without a visible version the button is an act of faith: you click it, the
   * app reloads, and you still cannot tell whether anything changed.
   */
  define: {
    __BUILD_ID__: JSON.stringify(
      new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'),
    ),
  },
  plugins: [
    preact(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: null,
      includeAssets: ['favicon.svg', 'icons/*.png'],
      manifest: {
        name: 'Slate',
        short_name: 'Slate',
        description: 'Local-first markdown notes that sync everywhere.',
        theme_color: '#1c1c1e',
        background_color: '#1c1c1e',
        display: 'standalone',
        orientation: 'any',
        start_url: '.',
        scope: '.',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The app shell is precached so a cold start works with no network at all.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        navigateFallback: 'index.html',
        // Never cache remote sync endpoints — the sync engine owns that freshness.
        navigateFallbackDenylist: [/^\/api/],
        runtimeCaching: [],
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          codemirror: [
            '@codemirror/state',
            '@codemirror/view',
            '@codemirror/commands',
            '@codemirror/language',
            '@codemirror/lang-markdown',
            '@codemirror/autocomplete',
            '@codemirror/search',
          ],
        },
      },
    },
  },
})
