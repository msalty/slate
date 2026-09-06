// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { highlightTask, taskHighlightExtension, taskHighlightField } from './taskHighlight'

describe('task navigation', () => {
  it('targets the exact task without changing markdown or selection, including repeated jumps', () => {
    const doc = '# Note\n\n- [ ] Same task\n- [ ] Same task'
    const view = new EditorView({ state: EditorState.create({ doc, extensions: taskHighlightExtension }) })
    try {
      for (const line of [3, 2, 2]) {
        highlightTask(view, line)
        expect(view.state.field(taskHighlightField).iter().from).toBe(view.state.doc.line(line + 1).from)
        expect(view.state.doc.toString()).toBe(doc)
        expect(view.state.selection.main.anchor).toBe(0)
      }
      view.dispatch({ selection: { anchor: 2 } })
      expect(view.state.field(taskHighlightField).size).toBe(0)
    } finally {
      view.destroy()
    }
  })

  it('ignores stale out-of-range targets', () => {
    const view = new EditorView({ state: EditorState.create({ doc: '- [ ] Task', extensions: taskHighlightExtension }) })
    try {
      highlightTask(view, 9)
      expect(view.state.field(taskHighlightField).size).toBe(0)
      expect(view.state.doc.toString()).toBe('- [ ] Task')
    } finally {
      view.destroy()
    }
  })
})
