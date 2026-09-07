// @vitest-environment jsdom
/**
 * What an embed becomes in rich text.
 *
 * Four kinds of file draw themselves in the note — a picture, a video, a
 * sound, a PDF — and each of those can be dragged to a width. Everything else
 * becomes a card wearing the mark of its own kind, which is the whole point of
 * the marks: a note holding a spreadsheet, a zip and a font should not be
 * three identical grey rectangles.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { createEditorState } from './setup'
import { EmbedWidget } from './widgets'

/** Files the vault is pretending to hold, by path, with their size. */
const held = new Map<string, number>()

vi.mock('../core/vault', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/vault')>()
  return {
    ...actual,
    attachmentUrl: (path: string) => (held.has(path) ? `blob:${path}` : undefined),
    getRaw: (path: string) =>
      held.has(path) ? ({ path, size: held.get(path) } as unknown as ReturnType<typeof actual.getRaw>) : undefined,
  }
})

/** pdf.js, minus the two megabytes: one three-page document that draws instantly. */
vi.mock('../core/pdfjs', () => ({
  pdfAsset: () => 'pdfjs/',
  pdfLibrary: async () => ({
    getDocument: () => ({
      destroy: () => {},
      promise: Promise.resolve({
        numPages: 3,
        getPage: async () => ({
          getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
          render: () => ({ promise: Promise.resolve() }),
        }),
      }),
    }),
  }),
}))

let view: EditorView

/*
 * jsdom draws nothing, so a canvas there has no 2d context to render into.
 * The page geometry — the sizes below — is worked out before a single pixel is
 * drawn, and that is the part worth checking.
 */
vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as never)

beforeEach(() => {
  held.clear()
  document.body.innerHTML = ''
  view?.destroy()
  view = new EditorView({
    state: createEditorState({ doc: 'note', path: 'note.md', mode: 'rich', fontSize: 16, onChange: () => {} }),
  })
})

/** The DOM rich text would put in the note for `![[path]]`. */
function embed(path: string, width?: number): HTMLElement {
  return new EmbedWidget({ path, label: path, alt: '', width }).toDOM(view)
}

describe('a file the page can draw', () => {
  it('shows a picture, and a handle to size it by', () => {
    held.set('shot.png', 2048)
    const dom = embed('shot.png', 300)
    const img = dom.querySelector('img')!
    expect(img.src).toBe('blob:shot.png')
    expect(img.style.width).toBe('300px')
    expect(dom.querySelector('.cm-embed-resize')).not.toBeNull()
  })

  it('shows a player for a video, sized the same way', () => {
    held.set('clip.mp4', 9000)
    const dom = embed('clip.mp4', 480)
    expect(dom.querySelector('video')!.style.width).toBe('480px')
    expect(dom.querySelector('.cm-embed-resize')).not.toBeNull()
  })

  it('now sizes a sound too, which used to be the one embed that could not be', () => {
    held.set('take-1.mp3', 4096)
    const dom = embed('take-1.mp3', 260)
    const audio = dom.querySelector('audio')!
    expect(audio.controls).toBe(true)
    expect(audio.style.width).toBe('260px')
    expect(dom.querySelector('.cm-embed-resize')).not.toBeNull()
  })

  it('leaves the width to the theme when the markdown names none', () => {
    held.set('take-1.mp3', 4096)
    expect(embed('take-1.mp3').querySelector('audio')!.style.width).toBe('')
  })
})

describe('a PDF', () => {
  it('draws its first page into the note, at the width it is shown at', async () => {
    held.set('invoice.pdf', 120_000)
    const dom = embed('invoice.pdf')
    const box = dom.querySelector('.cm-embed-pdf') as HTMLElement
    expect(box).not.toBeNull()
    expect(dom.querySelector('.cm-embed-resize')).not.toBeNull()

    await vi.waitFor(() => expect(box.querySelector('canvas')!.style.aspectRatio).not.toBe(''))
    const canvas = box.querySelector('canvas') as HTMLCanvasElement
    // 420 CSS pixels of a 600x800 page, at this screen's pixel ratio.
    expect(canvas.width).toBe(420)
    expect(canvas.height).toBe(560)
    expect(canvas.style.aspectRatio).toBe('600 / 800')
    // What the page cannot say for itself: how many more of them there are.
    expect(dom.querySelector('.cm-embed-pdf-meta')!.textContent).toBe('3 pages · 117 KB')
  })

  it('is drawn at the width in the markdown when there is one', async () => {
    held.set('invoice.pdf', 1000)
    const dom = embed('invoice.pdf', 240)
    expect((dom.querySelector('.cm-embed-pdf') as HTMLElement).style.width).toBe('240px')
    await vi.waitFor(() => expect(dom.querySelector('canvas')!.style.aspectRatio).not.toBe(''))
    expect(dom.querySelector('canvas')!.width).toBe(240)
  })

  it('falls back to a card when there are no bytes to draw', () => {
    const dom = embed('missing-from-cache.pdf')
    expect(dom.querySelector('.cm-embed-pdf')).toBeNull()
    expect(dom.querySelector('.cm-embed-card')).not.toBeNull()
  })
})

describe('a file the page cannot draw', () => {
  it('is a card wearing its own kind of mark', () => {
    held.set('files/budget.xlsx', 24_000)
    const dom = embed('files/budget.xlsx')
    const card = dom.querySelector('.cm-embed-card')!
    expect(card.querySelector('svg')!.getAttribute('data-family')).toBe('sheet')
    expect(card.textContent).toContain('files/budget.xlsx')
    expect(card.textContent).toContain('XLSX · 23 KB')
  })

  it('tells two kinds of unshowable file apart', () => {
    held.set('a.zip', 10)
    held.set('a.woff2', 10)
    const mark = (p: string) =>
      embed(p).querySelector('.cm-embed-card svg')!.getAttribute('data-family')
    expect(mark('a.zip')).toBe('archive')
    expect(mark('a.woff2')).toBe('font')
  })

  it('still says what it is when the vault has no bytes for it either', () => {
    const card = embed('a.zip').querySelector('.cm-embed-card')!
    expect(card.textContent).toContain('ZIP')
  })

  it('says so plainly when the target resolves to nothing at all', () => {
    const dom = new EmbedWidget({ label: 'gone.zip', alt: '' }).toDOM(view)
    expect(dom.querySelector('.cm-embed-missing')!.textContent).toBe('Missing: gone.zip')
  })
})
