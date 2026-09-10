import { defineConfig, type Plugin } from 'vite'
import preact from '@preact/preset-vite'
import { VitePWA } from 'vite-plugin-pwa'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

/**
 * pdf.js's worker and its WebAssembly decoders, served and shipped under one
 * fixed path.
 *
 * Neither can be an ordinary `?url` import, for the same reason: pdf.js builds
 * these URLs itself, by name, from a directory it is handed, so the filenames
 * have to survive the build unhashed — which is what `emitFile` with an
 * explicit `fileName` does. The dev server never sees a build, so it is given a
 * matching route.
 *
 * The worker is renamed from `.mjs` to `.js` on the way through, and that is
 * not tidying. A module worker is refused unless it is served as JavaScript,
 * and `dist/` is built to be dropped onto any static host — including ones
 * whose mime.types predate `.mjs` and would hand the browser
 * `application/octet-stream`. `.js` is the one extension every one of them
 * knows.
 *
 * The decoders are what read the image formats a PDF can carry and a browser
 * cannot: JBIG2 and JPEG 2000, which is what a scanner puts in a scanned
 * document, and qcms, which is what makes an embedded colour profile come out
 * the right colour. Without them those pages come out blank or wrong, so they
 * are worth their 450KB — unlike pdf.js's fourth wasm file, quickjs, which
 * exists to run JavaScript embedded in PDF form fields, is larger than these
 * three together, and is not something a notes app should be executing.
 */
const PDF_DIR = 'pdfjs'
const PDF_FILES: Record<string, string> = {
  'pdf.worker.js': 'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
  'jbig2.wasm': 'pdfjs-dist/wasm/jbig2.wasm',
  'openjpeg.wasm': 'pdfjs-dist/wasm/openjpeg.wasm',
  'qcms_bg.wasm': 'pdfjs-dist/wasm/qcms_bg.wasm',
}

function pdfAssets(): Plugin {
  const require = createRequire(import.meta.url)
  const read = (name: string) => readFile(require.resolve(PDF_FILES[name]))
  return {
    name: 'slate:pdf-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.split('?')[0]?.replace(`/${PDF_DIR}/`, '')
        if (!name || !(name in PDF_FILES) || !req.url?.startsWith(`/${PDF_DIR}/`)) return next()
        void read(name).then((body) => {
          res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
          res.end(body)
        }, next)
      })
    },
    async buildStart() {
      for (const name of Object.keys(PDF_FILES)) {
        this.emitFile({ type: 'asset', fileName: `${PDF_DIR}/${name}`, source: await read(name) })
      }
    },
  }
}

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
    pdfAssets(),
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
        /*
         * Long-press the launcher icon. These are the fastest way into the app
         * there is — no cold start into a list you then have to navigate — and
         * they cost nothing but a URL each, which App.tsx reads on the way in.
         *
         * Relative, like start_url and scope above, because dist/ has to keep
         * working dropped into a subdirectory of somebody's web server.
         *
         * Android only in practice: iOS Safari implements neither this nor the
         * share target below. The README has the Shortcuts recipe that gets an
         * iPhone to the same place through the same URLs.
         */
        shortcuts: [
          { name: 'New task', short_name: 'Task', url: './?add=task' },
          { name: 'New note', short_name: 'Note', url: './?add=note' },
          { name: 'Today’s note', short_name: 'Today', url: './?open=today' },
        ],
        /*
         * Share text or a link from any other app into capture.
         *
         * A GET target on purpose: the parameters arrive in the URL, which the
         * app already knows how to read, and no service worker has to sit in
         * the request path to receive a POST. It also means a share works with
         * no network — `navigateFallback` serves index.html out of the
         * precache and the write is local, like every other write here.
         */
        share_target: {
          action: '.',
          method: 'GET',
          params: { title: 'title', text: 'text', url: 'url' },
        },
      },
      workbox: {
        /*
         * The app shell is precached so a cold start works with no network at
         * all, and `wasm` is in the list because the PDF viewer is part of that
         * promise. pdf.js — its worker, its library chunk and its image
         * decoders — is the largest thing the app ships: about two megabytes,
         * downloaded once, in exchange for a PDF that opens on a plane.
         * Fetching it on demand instead would be a smaller install and a
         * document that refuses to open exactly when the notes around it
         * still do.
         */
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,wasm}'],
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
