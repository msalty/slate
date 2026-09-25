// @vitest-environment jsdom
/**
 * Change this passage, on a note that refuses edits.
 *
 * The rewrite lands as a dispatch of its own, which `readOnly` does not stop —
 * that flag only guards CodeMirror's own input paths. So a passage selected
 * while reading a locked note, or one an importer owns, was rewritten anyway.
 */

import { describe, expect, it } from 'vitest'
import { EditorView } from '@codemirror/view'
import { EditorSelection } from '@codemirror/state'
import { createEditorState } from '../editor/setup'
import { activeEditor } from '../editor/context'
import { openTransform } from './TransformDialog'

function editor(doc: string): EditorView {
  const parent = document.body.appendChild(document.createElement('div'))
  const view = new EditorView({
    parent,
    state: createEditorState({
      doc,
      path: 'note.md',
      mode: 'source',
      fontSize: 16,
      onChange: () => {},
    }),
  })
  const at = doc.indexOf('Body')
  view.dispatch({ selection: EditorSelection.range(at, at + 4) })
  activeEditor.value = view
  return view
}

describe('changing a passage', () => {
  it('is refused on a note an importer owns', () => {
    const view = editor('---\nsource: fastmail\nuid: u1\n---\n\nBody text\n')
    expect(openTransform()).toBe(false)
    view.destroy()
  })

  it('is refused on a note its own properties lock', () => {
    const view = editor('---\nread-only: true\n---\n\nBody text\n')
    expect(openTransform()).toBe(false)
    view.destroy()
  })

  it('is offered on an ordinary note with a selection', () => {
    const view = editor('Body text\n')
    expect(openTransform()).toBe(true)
    view.destroy()
  })
})
