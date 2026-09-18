// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { revealLine, navTargetExtension, navTargetField } from './navTarget'

describe('being taken to a line', () => {
  it('targets the exact task without changing markdown or selection, including repeated jumps', () => {
    const doc = '# Note\n\n- [ ] Same task\n- [ ] Same task'
    const view = new EditorView({ state: EditorState.create({ doc, extensions: navTargetExtension }) })
    try {
      for (const line of [3, 2, 2]) {
        revealLine(view, line)
        expect(view.state.field(navTargetField).iter().from).toBe(view.state.doc.line(line + 1).from)
        expect(view.state.doc.toString()).toBe(doc)
        expect(view.state.selection.main.anchor).toBe(0)
      }
      view.dispatch({ selection: { anchor: 2 } })
      expect(view.state.field(navTargetField).size).toBe(0)
    } finally {
      view.destroy()
    }
  })

  it('ignores stale out-of-range targets', () => {
    const view = new EditorView({ state: EditorState.create({ doc: '- [ ] Task', extensions: navTargetExtension }) })
    try {
      revealLine(view, 9)
      expect(view.state.field(navTargetField).size).toBe(0)
      expect(view.state.doc.toString()).toBe('- [ ] Task')
    } finally {
      view.destroy()
    }
  })
})
