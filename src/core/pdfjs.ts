/**
 * pdf.js, fetched the first time a PDF is drawn and never again.
 *
 * A dynamic import is what keeps it out of the bundle everybody downloads to
 * write a note. The worker and the decoders it needs alongside it are emitted
 * by the build under a fixed path of their own (see vite.config.ts), because
 * pdf.js asks for those by name rather than importing them.
 *
 * The `legacy` build, not the default one, and the difference is not cosmetic:
 * the default build is compiled for whatever the newest browser can do this
 * month — it calls `Map.prototype.getOrInsertComputed`, which is a 2025
 * proposal — and on a phone a year old every page fails to draw with a
 * `not a function` in the console. `legacy` is the same library carrying the
 * polyfills for that, about 60KB more, and it is the one that works on the
 * devices this had to be fixed for in the first place.
 *
 * It lives here rather than beside the viewer because two places draw PDFs
 * now: the full-screen viewer in `ui/PdfView.tsx`, and the first page of one
 * embedded in a note, which is built by a CodeMirror widget — and the editor
 * never imports UI.
 */

export type Pdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')

/**
 * Where the worker and the decoders live.
 *
 * Resolved against `document.baseURI` rather than written absolute, because the
 * whole app is built to run from whatever subdirectory it is dropped into — the
 * domain root, `~/Sites/slate/`, a Pages subpath — with no rebuild.
 */
export const pdfAsset = (name = '') => new URL(`pdfjs/${name}`, document.baseURI).href

let loading: Promise<Pdfjs> | undefined

export function pdfLibrary(): Promise<Pdfjs> {
  return (loading ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = pdfAsset('pdf.worker.js')
    return lib
  }))
}
