// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { forceParsing, syntaxTree, syntaxTreeAvailable } from '@codemirror/language'
import { createEditorState } from './setup'
import { livePreview, previewMode } from './livePreview'
import { revealLine } from './navTarget'

it('refreshes rich text when background parsing advances without a document or selection change', () => {
  const doc = '# Note\n\n' + '- [ ] **Task** with a [link](https://example.com)\n'.repeat(5000)
  const onChange = vi.fn()
  const view = new EditorView({ state: createEditorState({
    doc, path: 'note.md', mode: 'rich', fontSize: 16, editable: false, onChange,
  }) })
  try {
    const tree = syntaxTree(view.state)
    const decorations = view.plugin(livePreview)!.decorations
    expect(tree.length).toBeLessThan(doc.length)
    expect(forceParsing(view, doc.length, 2000)).toBe(true)
    expect(syntaxTree(view.state)).not.toBe(tree)
    expect(view.plugin(livePreview)!.decorations).not.toBe(decorations)
    expect(view.state.doc.toString()).toBe(doc)
    expect(view.state.selection.main.anchor).toBe(0)
    revealLine(view, 4000)
    expect(onChange).not.toHaveBeenCalled()
    expect(view.state.facet(previewMode)).toBe('rich')
    expect(view.state.facet(EditorView.editable)).toBe(false)
    expect(view.state.doc.toString()).toBe(doc)
  } finally {
    view.destroy()
  }
})


it('prepares the content below a task before centering it, without parsing the whole note', () => {
  const doc = '# Note\n\n' + '- [ ] **Task** with a [link](https://example.com)\n'.repeat(5000)
  const onChange = vi.fn()
  const view = new EditorView({ state: createEditorState({
    doc, path: 'note.md', mode: 'rich', fontSize: 16, editable: false, onChange,
  }) })
  try {
    revealLine(view, 250)
    // The task lands in the middle of the viewport, not at its bottom.
    expect(syntaxTreeAvailable(view.state, view.state.doc.line(300).to)).toBe(true)
    expect(syntaxTree(view.state).length).toBeLessThan(doc.length)
    expect(view.state.doc.toString()).toBe(doc)
    expect(onChange).not.toHaveBeenCalled()
    expect(view.state.facet(previewMode)).toBe('rich')
  } finally {
    view.destroy()
  }
})

/*
 * An email address, or anything with a dot in it, typed as a link's text is
 * autolinked by GFM inside the brackets: a second URL node, ahead of the
 * address. Every URL under a link was hidden as machinery, so the label went
 * blank the moment its dot was typed — and the click went to the label, the
 * first URL, instead of the address.
 */
it('shows a link whose text is itself an address, and sends it to the address', async () => {
  const doc =
    '- home · [jane@example.com](mailto:jane@example.com)\n' +
    '- web · [www.example.com](https://example.com/home)\n' +
    '- titled · [site](https://example.org "My Title")\n'
  const parent = document.body.appendChild(document.createElement('div'))
  const view = new EditorView({
    parent,
    state: createEditorState({
      doc, path: 'note.md', mode: 'rich', fontSize: 16, editable: false, onChange: () => {},
    }),
  })
  try {
    forceParsing(view, doc.length, 2000)
    await new Promise((r) => setTimeout(r, 0))
    const shown = view.contentDOM.textContent ?? ''
    expect(shown).toContain('jane@example.com')
    expect(shown).toContain('www.example.com')
    expect(shown).not.toContain('mailto:')
    expect(shown).not.toContain('https://example.com/home')
    // A link's title is hidden with its address, as it always was.
    expect(shown).not.toContain('My Title')
    const hrefs = [...view.contentDOM.querySelectorAll('.cm-uri')].map((e) => e.getAttribute('data-href'))
    expect(hrefs).toEqual([
      'mailto:jane@example.com',
      'https://example.com/home',
      'https://example.org',
    ])
  } finally {
    view.destroy()
    parent.remove()
  }
})
