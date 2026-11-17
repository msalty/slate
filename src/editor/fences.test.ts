// @vitest-environment jsdom
/** Drawn fences: which blocks become a picture, and what draws them. */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { forceParsing } from '@codemirror/language'
import { type FenceRenderer, fenceRendererFor, loadFence, loadedFence } from './fences'

/*
 * The real renderer is a library that measures text and wants a layout engine
 * under it. What is being tested here is everything around it, so it is stood
 * in for by something that records what it was asked to draw.
 */
const drawn = vi.hoisted(() => ({
  mounts: [] as string[],
  updates: [] as string[],
  destroyed: 0,
}))

vi.mock('./mermaid', () => ({
  mountMermaid: (el: HTMLElement, source: string) => {
    drawn.mounts.push(source)
    el.textContent = `drawn: ${source}`
    return {
      update: (next: string) => drawn.updates.push(next),
      destroy: () => drawn.destroyed++,
    }
  },
}))

import { createEditorState } from './setup'
import { fenceField } from './livePreview'

// jsdom has no layout; CodeMirror asks for it whenever it measures.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList
Range.prototype.getBoundingClientRect = () => new DOMRect()

beforeEach(() => {
  drawn.mounts.length = 0
  drawn.updates.length = 0
  drawn.destroyed = 0
})

describe('fenceRendererFor', () => {
  it('finds a renderer by the language on the fence', () => {
    expect(fenceRendererFor('mermaid')?.name).toBe('mermaid')
  })

  it('goes by the first word alone, in any case', () => {
    expect(fenceRendererFor('  Mermaid title="Flow"')?.name).toBe('mermaid')
  })

  it('knows a renderer by its aliases', () => {
    expect(fenceRendererFor('mmd')?.name).toBe('mermaid')
  })

  it('has nothing for a language that is only code', () => {
    expect(fenceRendererFor('js')).toBeNull()
    expect(fenceRendererFor('')).toBeNull()
  })
})

describe('loadFence', () => {
  const mount = () => ({ update() {}, destroy() {} })

  it('fetches a renderer once however many blocks ask', async () => {
    const load = vi.fn(async () => mount)
    const renderer: FenceRenderer = { name: 'x', load }
    expect(loadedFence(renderer)).toBeUndefined()
    await Promise.all([loadFence(renderer), loadFence(renderer)])
    expect(load).toHaveBeenCalledTimes(1)
    expect(loadedFence(renderer)).toBe(mount)
  })

  /* Offline the first time is not offline for ever. */
  it('tries again after a failure', async () => {
    const load = vi
      .fn<() => Promise<typeof mount>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(mount)
    const renderer: FenceRenderer = { name: 'y', load }
    await expect(loadFence(renderer)).rejects.toThrow('offline')
    await expect(loadFence(renderer)).resolves.toBe(mount)
  })
})

function editor(doc: string, mode: 'live' | 'rich' | 'source' = 'live') {
  const parent = document.body.appendChild(document.createElement('div'))
  const view = new EditorView({
    parent,
    state: createEditorState({
      doc, path: 'note.md', mode, fontSize: 16, editable: true, onChange: () => {},
    }),
  })
  forceParsing(view, doc.length, 2000)
  // The field reads the tree; give it a transaction to read the finished one in.
  view.dispatch({})
  return view
}

/** The blocks shown as a drawing, as the source each one replaces. */
function replaced(view: EditorView): string[] {
  const out: string[] = []
  const set = view.state.field(fenceField, false)?.atomic
  set?.between(0, view.state.doc.length, (from, to) => {
    out.push(view.state.doc.sliceString(from, to))
  })
  return out
}

describe('fenceField', () => {
  it('replaces a closed mermaid block, fences and all', () => {
    const block = '```mermaid\nflowchart LR\n  A --> B\n```'
    const view = editor(`# T\n\n${block}\n\nafter\n`)
    try {
      expect(replaced(view)).toEqual([block])
    } finally {
      view.destroy()
    }
  })

  it('leaves an ordinary code block a code block', () => {
    const view = editor('```js\nconst a = 1\n```\n')
    try {
      expect(replaced(view)).toEqual([])
    } finally {
      view.destroy()
    }
  })

  /* Everything under a half-typed block is not a diagram. */
  it('does not draw a fence that is never closed', () => {
    const view = editor('```mermaid\nflowchart LR\n  A --> B\n\nprose\n')
    try {
      expect(replaced(view)).toEqual([])
    } finally {
      view.destroy()
    }
  })

  it('does not draw an empty block', () => {
    const view = editor('```mermaid\n```\n\n```mermaid\n\n```\n')
    try {
      expect(replaced(view)).toEqual([])
    } finally {
      view.destroy()
    }
  })

  /* Its lines carry the list's own indentation; replacing them would eat it. */
  it('leaves a block nested in a list or a quote alone', () => {
    const view = editor(
      '- item\n  ```mermaid\n  flowchart LR\n    A --> B\n  ```\n\n> ```mermaid\n> flowchart LR\n> ```\n',
    )
    try {
      expect(replaced(view)).toEqual([])
    } finally {
      view.destroy()
    }
  })

  it('draws in rich text too, and never in source mode', () => {
    const doc = '```mermaid\npie\n  "a": 1\n```\n'
    const rich = editor(doc, 'rich')
    const source = editor(doc, 'source')
    try {
      expect(replaced(rich)).toHaveLength(1)
      expect(source.state.field(fenceField, false)).toBeUndefined()
    } finally {
      rich.destroy()
      source.destroy()
    }
  })
})

describe('the drawing', () => {
  const doc = 'intro\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nafter\n'
  const settle = () => new Promise((r) => setTimeout(r, 0))

  it('is handed the body of the block, without its fences', async () => {
    const view = editor(doc)
    try {
      await settle()
      expect(drawn.mounts).toEqual(['flowchart LR\n  A --> B'])
      expect(view.dom.querySelector('.cm-fence')?.textContent).toContain('drawn: flowchart LR')
    } finally {
      view.destroy()
    }
  })

  /* Or every diagram in a note would redraw at every keystroke. */
  it('is not drawn again when the note is edited somewhere else', async () => {
    const view = editor(doc)
    try {
      await settle()
      view.dispatch({ changes: { from: 0, insert: 'More ' } })
      view.dispatch({ changes: { from: view.state.doc.length, insert: 'and more' } })
      await settle()
      expect(drawn.mounts).toHaveLength(1)
      expect(drawn.updates).toEqual([])
    } finally {
      view.destroy()
    }
  })

  /* The last drawing that worked stays up; the renderer is told the new text. */
  it('is updated in place when its own source changes', async () => {
    const view = editor(doc)
    try {
      await settle()
      const dom = view.dom.querySelector('.cm-fence')
      const at = view.state.doc.toString().indexOf('B\n```') + 1
      view.dispatch({ changes: { from: at, insert: ' --> C' } })
      await settle()
      expect(drawn.updates).toEqual(['flowchart LR\n  A --> B --> C'])
      expect(drawn.mounts).toHaveLength(1)
      expect(view.dom.querySelector('.cm-fence')).toBe(dom)
    } finally {
      view.destroy()
    }
  })

  it('is taken down with the block', async () => {
    const view = editor(doc)
    try {
      await settle()
      const from = view.state.doc.toString().indexOf('```mermaid')
      view.dispatch({ changes: { from, to: from + '```mermaid'.length, insert: '```js' } })
      await settle()
      expect(view.dom.querySelector('.cm-fence')).toBeNull()
      expect(drawn.destroyed).toBe(1)
    } finally {
      view.destroy()
    }
  })
})
