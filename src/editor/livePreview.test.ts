// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { forceParsing, syntaxTree, syntaxTreeAvailable } from '@codemirror/language'
import { createEditorState } from './setup'
import { livePreview, previewMode } from './livePreview'
import { highlightTask } from './taskHighlight'

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
    highlightTask(view, 4000)
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
    highlightTask(view, 250)
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
