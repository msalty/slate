// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { createEditorState } from './setup'

function editor(doc: string, footer?: HTMLElement) {
  return new EditorView({
    state: createEditorState({
      doc,
      path: 'note.md',
      mode: 'rich',
      fontSize: 16,
      editable: false,
      onChange: vi.fn(),
      footer,
    }),
    parent: document.body,
  })
}

it('hangs the footer past the last line, inside the note that scrolls', () => {
  const footer = document.createElement('div')
  footer.textContent = 'what links here'
  const view = editor('# Lisbon Trip\n\nFlights booked.\n', footer)
  try {
    /*
     * Inside the content, not beside it: that is the whole point of the block —
     * it scrolls with the note and takes no height from the pane — and it is
     * the last thing in there, after the text rather than in it.
     */
    expect(footer.closest('.cm-content')).toBe(view.contentDOM)
    expect(view.contentDOM.lastElementChild).toBe(footer)
    // CodeMirror keeps the caret out of what it did not write.
    expect(footer.contentEditable).toBe('false')
  } finally {
    view.destroy()
  }
})

it('re-anchors to the end as the note grows, without rebuilding what is in it', () => {
  const footer = document.createElement('div')
  const inner = document.createElement('span')
  inner.textContent = 'one mention'
  footer.append(inner)
  const view = editor('Flights booked.', footer)
  try {
    view.dispatch({ changes: { from: view.state.doc.length, insert: '\n\nAnd a hotel.' } })
    expect(view.contentDOM.lastElementChild).toBe(footer)
    /*
     * The same element, with the same children: the shell renders into this
     * node once and lets its own signals keep it up to date, so a keystroke at
     * the end of a note must not throw that away and build it again.
     */
    expect(footer.firstElementChild).toBe(inner)
  } finally {
    view.destroy()
  }
})

it('leaves an editor that was given no footer alone', () => {
  const view = editor('Flights booked.')
  try {
    expect(view.contentDOM.lastElementChild?.className).toBe('cm-line')
    expect(view.contentDOM.textContent).toBe('Flights booked.')
  } finally {
    view.destroy()
  }
})
