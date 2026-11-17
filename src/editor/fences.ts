/**
 * Fenced blocks that are drawn rather than read.
 *
 * A fence whose language names one of these is a picture written as text — a
 * diagram, today — and the note shows the picture. This is the one place that
 * says which languages those are and where the code that draws each one lives;
 * the editor (see `fenceField` in livePreview.ts) knows only that a renderer
 * exists, never which.
 *
 * It is the same shape as `codeLanguages` in languages.ts, for the same reason:
 * a renderer is a library, and a note with no diagram in it should not pay for
 * one. Each loads the first time a block asks for it.
 *
 * Adding a kind of block is one entry here and one module beside this file.
 */

/** A drawing on the page, kept so it can follow its source as that is edited. */
export interface FenceView {
  /** Redraw from new source, in place. */
  update(source: string): void
  destroy(): void
}

/**
 * Draw `source` into `el`.
 *
 * Source that cannot be drawn is the renderer's to report, inside `el` — it
 * must not throw, because half-written source is the normal state of a block
 * somebody is typing. `resized` is called whenever the drawing's height may
 * have changed, so the editor can measure it again.
 */
export type FenceMount = (el: HTMLElement, source: string, resized: () => void) => FenceView

export interface FenceRenderer {
  /** The fence's language, as written after the backticks. Lower case. */
  name: string
  alias?: string[]
  load: () => Promise<FenceMount>
}

export const fenceRenderers: FenceRenderer[] = [
  {
    name: 'mermaid',
    alias: ['mmd'],
    load: () => import('./mermaid').then((m) => m.mountMermaid),
  },
]

/**
 * The renderer for a fence's info string, if it has one.
 *
 * Only the first word counts, as it does for syntax highlighting: whatever
 * follows the language on a fence line is somebody else's metadata.
 */
export function fenceRendererFor(
  info: string,
  renderers: readonly FenceRenderer[] = fenceRenderers,
): FenceRenderer | null {
  const lang = info.trim().split(/\s+/)[0]?.toLowerCase()
  if (!lang) return null
  return renderers.find((r) => r.name === lang || r.alias?.includes(lang)) ?? null
}

const loading = new WeakMap<FenceRenderer, Promise<FenceMount>>()
const loaded = new WeakMap<FenceRenderer, FenceMount>()

/** A renderer that has already arrived, so a block can be drawn without a gap. */
export function loadedFence(renderer: FenceRenderer): FenceMount | undefined {
  return loaded.get(renderer)
}

/**
 * Fetch a renderer, once.
 *
 * A failure is not remembered: the usual cause is a network that was not there,
 * and the next block to ask should get to try again.
 */
export function loadFence(renderer: FenceRenderer): Promise<FenceMount> {
  let pending = loading.get(renderer)
  if (!pending) {
    pending = renderer.load().then(
      (mount) => {
        loaded.set(renderer, mount)
        return mount
      },
      (err) => {
        loading.delete(renderer)
        throw err
      },
    )
    loading.set(renderer, pending)
  }
  return pending
}
