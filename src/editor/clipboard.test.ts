// @vitest-environment jsdom
/**
 * Copy, cut and paste in rich text, where the markup is not on screen.
 *
 * All three have to agree about one thing: a selection of the visible text
 * inside `==word==` *means* `==word==`. Copy already widened to it and cut
 * already deleted it, and paste did not — so copying a highlighted word and
 * pasting it back over itself, which has to be a no-op, wrote `====word====`.
 */

import { describe, expect, it, vi } from 'vitest'
import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { createEditorState } from './setup'

function editor(doc: string, opts: { readOnly?: boolean } = {}) {
  return new EditorView({
    state: createEditorState({
      doc,
      path: 'note.md',
      mode: 'rich',
      fontSize: 16,
      editable: !opts.readOnly,
      readOnly: opts.readOnly,
      onChange: vi.fn(),
    }),
    parent: document.body,
  })
}

/** A stand-in for the browser's clipboard, and the event that carries it. */
function clipboard(initial = '') {
  const store = new Map<string, string>()
  if (initial) store.set('text/plain', initial)
  return {
    data: {
      getData: (type: string) => store.get(type) ?? '',
      setData: (type: string, value: string) => void store.set(type, value),
      types: [...store.keys()],
      files: [],
      items: [],
    },
    get text() {
      return store.get('text/plain') ?? ''
    },
  }
}

/** Fire a clipboard event at the editor the way the browser would. */
function fire(view: EditorView, type: 'copy' | 'cut' | 'paste', clip: ReturnType<typeof clipboard>) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: clip.data })
  view.contentDOM.dispatchEvent(event)
  return event
}

/** Select the visible text between two markers, by what it reads as. */
function selectVisible(view: EditorView, visible: string) {
  const at = view.state.doc.toString().indexOf(visible)
  expect(at).toBeGreaterThanOrEqual(0)
  view.dispatch({ selection: EditorSelection.single(at, at + visible.length) })
}

/** Select several pieces of visible text at once, the way ⌘-click does. */
function selectEach(view: EditorView, ...visible: string[]) {
  const doc = view.state.doc.toString()
  let at = 0
  const ranges = visible.map((v) => {
    const i = doc.indexOf(v, at)
    expect(i).toBeGreaterThanOrEqual(0)
    at = i + v.length
    return EditorSelection.range(i, at)
  })
  view.dispatch({ selection: EditorSelection.create(ranges, ranges.length - 1) })
}

describe('copying takes the markup with it', () => {
  it('puts the delimiters on the clipboard, not just what is on screen', () => {
    const view = editor('a ==word== b')
    try {
      selectVisible(view, 'word')
      const clip = clipboard()
      fire(view, 'copy', clip)
      expect(clip.text).toBe('==word==')
    } finally {
      view.destroy()
    }
  })
})

describe('pasting replaces what copying would have taken', () => {
  it('is a no-op when a copy is pasted straight back over itself', () => {
    for (const doc of ['a ==word== b', 'a **word** b', 'a __word__ b']) {
      const view = editor(doc)
      try {
        selectVisible(view, 'word')
        const clip = clipboard()
        fire(view, 'copy', clip)
        fire(view, 'paste', clip)
        expect(view.state.doc.toString()).toBe(doc)
      } finally {
        view.destroy()
      }
    }
  })

  it('replaces the whole marked-up span, rather than nesting inside it', () => {
    const view = editor('a ==word== b')
    try {
      selectVisible(view, 'word')
      fire(view, 'paste', clipboard('plain'))
      expect(view.state.doc.toString()).toBe('a plain b')
    } finally {
      view.destroy()
    }
  })

  /*
   * A multi-cursor selection is several ranges, and this handler only ever read
   * the main one — so pasting over two selected words rewrote one of them and
   * dropped the other range on the floor, the second selection vanishing with
   * nothing pasted into it. Either every range is served or the handler has no
   * business taking the event off CodeMirror, which serves them all.
   */
  it('serves every range of a multi-cursor selection, not just the main one', () => {
    const view = editor('**one** and **two**')
    try {
      selectEach(view, 'one', 'two')
      fire(view, 'paste', clipboard('X'))
      expect(view.state.doc.toString()).toBe('X and X')
      expect(view.state.selection.ranges.map((r) => r.head)).toEqual(['X'.length, 'X and X'.length])
    } finally {
      view.destroy()
    }
  })

  it('gives each range its own line when the paste has one line per range', () => {
    // CodeMirror's own rule for a multi-range paste, which this has to keep:
    // two lines into two cursors is one line each, not both into both.
    const view = editor('**one** and **two**')
    try {
      selectEach(view, 'one', 'two')
      fire(view, 'paste', clipboard('first\nsecond'))
      expect(view.state.doc.toString()).toBe('first and second')
    } finally {
      view.destroy()
    }
  })

  it('widens each range on its own terms', () => {
    // The first is inside markup and grows; the second is plain and does not.
    const view = editor('**one** and two')
    try {
      selectEach(view, 'one', 'two')
      fire(view, 'paste', clipboard('X'))
      expect(view.state.doc.toString()).toBe('X and X')
    } finally {
      view.destroy()
    }
  })

  it('keeps two spans that touch as two pastes', () => {
    // `==one====two==` is two highlights with nothing between them, so the
    // grown ranges meet at one offset without overlapping. Two edits, not one
    // merged edit that would paste once where twice was asked for.
    const view = editor('==one====two==')
    try {
      selectEach(view, 'one', 'two')
      fire(view, 'paste', clipboard('X'))
      expect(view.state.doc.toString()).toBe('XX')
    } finally {
      view.destroy()
    }
  })

  it('leaves a range covering only part of a span where it is', () => {
    // Both words are inside one `**…**` and neither selection covers all of
    // it, so nothing widens and nothing is orphaned — `**X X**` is still bold.
    // Widening an edge alone would have written `**X` and broken it.
    const view = editor('**one two**')
    try {
      selectEach(view, 'one', 'two')
      fire(view, 'paste', clipboard('X'))
      expect(view.state.doc.toString()).toBe('**X X**')
    } finally {
      view.destroy()
    }
  })

  it('replaces exactly the selection when there is no markup to widen over', () => {
    // Nothing hidden here, so the widened range and the selection are the same
    // range and the result is an ordinary paste.
    const view = editor('a plain b')
    try {
      selectVisible(view, 'plain')
      fire(view, 'paste', clipboard('other'))
      expect(view.state.doc.toString()).toBe('a other b')
    } finally {
      view.destroy()
    }
  })
})

describe('cutting', () => {
  it('takes the orphaned delimiters with it', () => {
    const view = editor('a ==word== b')
    try {
      selectVisible(view, 'word')
      const clip = clipboard()
      fire(view, 'cut', clip)
      expect(clip.text).toBe('==word==')
      expect(view.state.doc.toString()).toBe('a  b')
    } finally {
      view.destroy()
    }
  })

  it('takes them across several spans at once', () => {
    const view = editor('**bold** and *italic*')
    try {
      selectVisible(view, 'bold** and *italic')
      fire(view, 'cut', clipboard())
      // It used to leave `***`: the opener of the first and the closer of the
      // second, both orphaned by a selection that took everything they wrapped.
      expect(view.state.doc.toString()).toBe('')
    } finally {
      view.destroy()
    }
  })

  /*
   * A note locked by its own properties refuses every edit, and `readOnly` is
   * what says so. CodeMirror's own commands consult it; a raw dispatch does
   * not — so this handler, which builds its own delete, took the text out of a
   * note that had said no. Paste checked; cut never did.
   */
  it('refuses to delete from a note that is read-only', () => {
    const view = editor('a ==word== b', { readOnly: true })
    try {
      selectVisible(view, 'word')
      const clip = clipboard()
      fire(view, 'cut', clip)
      expect(view.state.doc.toString()).toBe('a ==word== b')
      // Still a copy, though: reading a locked note and taking a quote out of
      // it is not an edit, and it is what a plain cut does there already.
      expect(clip.text).toBe('==word==')
    } finally {
      view.destroy()
    }
  })

  it('and a read-only note takes nothing from the clipboard either', () => {
    const view = editor('a ==word== b', { readOnly: true })
    try {
      selectVisible(view, 'word')
      fire(view, 'paste', clipboard('plain'))
      expect(view.state.doc.toString()).toBe('a ==word== b')
    } finally {
      view.destroy()
    }
  })
})
