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

/**
 * The capture entry points, in one place.
 *
 * Each is a URL the app reads on the way in (see core/capture.ts), and each is
 * also something you can put on a Home Screen. Android gets them from the
 * manifest's `shortcuts` — a long press on the launcher icon. iOS has no such
 * thing, and cannot be given one from the app's own manifest either:
 *
 *   **iOS launches an installed web app at the address it was installed with.**
 *   The manifest's `start_url` is baked into the web clip when you add it, and
 *   anything appended to the URL afterwards — by a Shortcut, a link, the
 *   `webapp://` scheme — is discarded before the page loads. Verified on a
 *   device: `webapp://…/?add=task` opens Slate at `start_url` with an empty
 *   query, which is indistinguishable from tapping the icon.
 *
 * So the address has to be baked in at the moment of adding, which means each
 * entry point needs a manifest of its own carrying it as `start_url`, and a
 * page of its own linking that manifest to be added *from*. That is what this
 * emits: three small pages, each installable as its own icon.
 */
const CAPTURE = [
  {
    slug: 'new-task',
    label: 'New task',
    short: 'Task',
    query: '?add=task',
    blurb: 'opens Slate with the quick-add sheet up, on a new task',
  },
  {
    slug: 'new-note',
    label: 'New note',
    short: 'Note',
    query: '?add=note',
    blurb: 'opens Slate with the quick-add sheet up, on a new note',
  },
  {
    slug: 'today',
    label: 'Today’s note',
    short: 'Today',
    query: '?open=today',
    blurb: 'opens today’s daily note, making it if the day hasn’t got one',
  },
] as const

const ICONS = [
  { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
  { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
  { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
]

type CaptureEntry = (typeof CAPTURE)[number]

/*
 * No `theme_color` and no `background_color`, for the reason set out at length
 * against the app's own manifest below: whichever single colour is chosen is
 * wrong for half of the users, and omitting it is what lets the system chrome
 * follow the phone.
 */
function captureManifest(c: CaptureEntry): string {
  return `${JSON.stringify(
    {
      name: `Slate — ${c.label}`,
      short_name: c.label,
      description: `Slate: ${c.blurb}.`,
      // Distinct ids, or a browser that keys installs by id sees one app.
      id: `./${c.query}`,
      start_url: `./${c.query}`,
      scope: './',
      display: 'standalone',
      orientation: 'any',
      icons: ICONS,
    },
    null,
    2,
  )}\n`
}

/**
 * The page you add to the Home Screen.
 *
 * Standalone HTML rather than a route in the app: Safari reads the manifest of
 * the page being added, and the app has exactly one document, which links
 * exactly one manifest. It carries the same `apple-` meta tags index.html
 * does, since those are read at the moment of adding and decide whether the
 * icon opens standalone or inside Safari's chrome.
 */
function capturePage(c: CaptureEntry): string {
  const others = CAPTURE.filter((o) => o.slug !== c.slug)
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
    <title>${c.label} · Slate</title>
    <link rel="manifest" href="./${c.slug}.webmanifest" />
    <link rel="apple-touch-icon" href="./icons/icon-192.png" />
    <link rel="icon" href="./favicon.svg" type="image/svg+xml" />
    <meta name="apple-mobile-web-app-title" content="${c.label}" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="default" />
    <meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff" />
    <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#1c1c1e" />
    <style>
      :root { --bg: #fff; --text: #1c1c1e; --muted: #5c5c60; --faint: #8e8e93; --line: rgba(0,0,0,.09); }
      @media (prefers-color-scheme: dark) {
        :root { --bg: #1c1c1e; --text: #f2f2f4; --muted: #a8a8ad; --faint: #79797f; --line: rgba(255,255,255,.09); }
      }
      html { background: var(--bg); }
      body {
        margin: 0; background: var(--bg); color: var(--text);
        font: 16px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
        padding: env(safe-area-inset-top) 20px calc(40px + env(safe-area-inset-bottom));
      }
      main { max-width: 34rem; margin: 0 auto; padding-block: 48px 0; }
      .eyebrow { font-size: 11px; font-weight: 600; letter-spacing: .13em; text-transform: uppercase; color: var(--faint); margin: 0 0 10px; }
      h1 { font-size: 1.9rem; line-height: 1.15; letter-spacing: -.02em; margin: 0 0 18px; }
      p { margin: 0 0 16px; }
      .why { color: var(--muted); font-size: .94rem; border-left: 2px solid var(--line); padding-left: 14px; }
      nav { margin-top: 28px; padding-top: 18px; border-top: 1px solid var(--line); font-size: .94rem; }
      nav a { display: block; margin-bottom: 8px; color: inherit; }
      :focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">Home Screen icon</p>
      <h1>${c.label}</h1>
      <p>Tap <b>Share</b>, then <b>Add to Home Screen</b>. The icon it makes ${c.blurb}.</p>
      <p>Add it from <b>Safari</b> — a web app cannot install another one, so this page does nothing from inside Slate itself.</p>
      <p class="why">
        This page exists because iOS launches an installed web app at the address it was
        installed with, and throws away anything added to the URL afterwards. The address
        has to be baked in at the moment you add it, which is what adding <i>this</i> page
        rather than the app does. On Android you need none of it: long-press the Slate
        icon instead.
      </p>
      <nav>
        <a href="./${c.query}">Open Slate — ${c.label.toLowerCase()}</a>
${others.map((o) => `        <a href="./${o.slug}.html">Home Screen icon: ${o.label}</a>`).join('\n')}
        <a href="./">Open Slate</a>
      </nav>
    </main>
  </body>
</html>
`
}

/**
 * Emit those pages and manifests into the build, and serve them in dev.
 *
 * The manifests are deliberately not precached: they are read once, by the
 * browser, at the moment an icon is added, which is a moment that needs the
 * network anyway. The pages are ordinary `.html` and so are covered by the
 * precache glob, which matters more than it looks — a navigation to one has to
 * beat `navigateFallback`, and being precached is what makes it.
 */
function capturePages(): Plugin {
  const files = (): Record<string, string> =>
    Object.fromEntries(
      CAPTURE.flatMap((c) => [
        [`${c.slug}.html`, capturePage(c)],
        [`${c.slug}.webmanifest`, captureManifest(c)],
      ]),
    )
  return {
    name: 'slate:capture-pages',
    configureServer(server) {
      const emitted = files()
      server.middlewares.use((req, res, next) => {
        const name = req.url?.split('?')[0]?.replace(/^\//, '')
        if (!name || !(name in emitted)) return next()
        res.setHeader(
          'Content-Type',
          name.endsWith('.html') ? 'text/html' : 'application/manifest+json',
        )
        res.end(emitted[name])
      })
    },
    buildStart() {
      for (const [fileName, source] of Object.entries(files())) {
        this.emitFile({ type: 'asset', fileName, source })
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
    capturePages(),
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
        icons: ICONS,
        /*
         * Long-press the launcher icon. These are the fastest way into the app
         * there is — no cold start into a list you then have to navigate — and
         * they cost nothing but a URL each, which App.tsx reads on the way in.
         *
         * Relative, like start_url and scope above, because dist/ has to keep
         * working dropped into a subdirectory of somebody's web server.
         *
         * Android only: iOS Safari implements neither this nor the share target
         * below, and cannot be given them from here — see the note above
         * CAPTURE for why an iPhone needs a page and a manifest per entry
         * point instead, which `capturePages` emits.
         */
        shortcuts: CAPTURE.map((c) => ({
          name: c.label,
          short_name: c.short,
          url: `./${c.query}`,
        })),
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
