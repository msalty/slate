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
        /*
         * There is deliberately no theme_color here.
         *
         * On Android this value is not a hint, it is the whole story: Chrome
         * bakes it into the WebAPK at install time and paints the status bar
         * with it, and an installed PWA does *not* read the page's
         * <meta name="theme-color"> — verified on a device, where switching
         * the in-app theme moved every pixel of the app and not the status
         * bar. Nor can the app paint that strip itself: Chrome 135 let the
         * viewport extend into the gesture navigation bar (which is why the
         * bottom of the screen follows --bg), but installed PWAs still cannot
         * draw behind the status bar under `viewport-fit=cover`; the support
         * for it is only now landing.
         *
         * So a theme_color here is one colour for both schemes, permanently,
         * and whichever one it is, half the users get a band across the top
         * that does not match the app underneath it — which is exactly the
         * seam this is trying to close. #1c1c1e was that band above a white
         * app for every light-mode user.
         *
         * Omitted, Chrome falls back to its own default toolbar colour, which
         * tracks its night mode and therefore the phone's. That is the closest
         * thing available to a status bar that follows the theme.
         *
         * The <meta name="theme-color"> tags in index.html are still right and
         * still needed — browser tabs, desktop installs and iOS all honour
         * them, and Android will too once it can. This is only about the one
         * value Android freezes at install.
         *
         * Changing anything in this manifest needs the app *uninstalled from
         * the launcher and installed again*. Nothing short of that does it:
         * Chrome bakes these values into the WebAPK when the package is
         * minted, and that package sits underneath everything the web layer
         * can reach — the app's own Settings → Reinstall clears service
         * workers and Cache Storage and does not touch it, and Chrome's
         * background manifest-update path is lazy (it waits for every window
         * to close, plus power and Wi-Fi). A manifest edit verified as live on
         * the server can therefore be invisible on the phone indefinitely,
         * which is exactly how this one wasted several rounds of debugging.
         *
         * `undefined` rather than simply leaving the key out, and it has to
         * stay that way: vite-plugin-pwa merges what it is given over its own
         * defaults with Object.assign, and its default theme_color is
         * '#42b883' — Vue green. Omit the key and the plugin supplies that
         * instead, which is how you end up with a green status bar. Object
         * .assign copies a key whose value is undefined, and JSON.stringify
         * then drops it, so this is what actually keeps it out of the file.
         * The plugin logs a warning about the missing theme_color; it is
         * wrong that installability depends on it, and the warning is the
         * intended outcome here.
         */
        theme_color: undefined,
        /*
         * Undefined for the same reason, and by the same mechanism — the
         * plugin's default here is '#ffffff'.
         *
         * Honest history, because the comment that used to sit here was wrong
         * and someone will otherwise build on it: this was removed on the
         * theory that Chrome's status bar falls back theme_color →
         * background_color → the page, because dropping theme_color alone
         * appeared to change nothing and #1c1c1e was the one colour left. That
         * theory was never actually tested. The device was reading a stale
         * WebAPK the whole time (see the note below), so *no* manifest change
         * had reached it — including the one that eventually fixed this.
         *
         * What is known: with both cleared and the package genuinely
         * reinstalled, the status bar follows the theme. Whether restoring
         * background_color alone would keep that is untested. It only paints
         * the splash, so restoring it would buy back the dark launch screen —
         * at the price of another uninstall/reinstall to find out, and a
         * regression if the fallback theory turns out to be right after all.
         */
        background_color: undefined,
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
