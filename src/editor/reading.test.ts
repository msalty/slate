// @vitest-environment jsdom
/**
 * The tap that turns a note being read into one being written in.
 *
 * The case worth a test is the one a browser found: a press that *starts* on
 * something which answers for itself, and ends somewhere else because acting
 * on it moved the note. Following `[[Note#Costs]]` scrolls to that heading,
 * and the pointerup then arrives over whatever slid into that spot — which,
 * judged on the target alone, is a tap on ordinary text.
 */

import { describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { createEditorState } from './setup'
import { installTapToEdit } from './reading'

function editor(doc: string) {
  return new EditorView({
    state: createEditorState({
      doc,
      path: 'note.md',
      mode: 'rich',
      fontSize: 16,
      editable: false,
      onChange: vi.fn(),
    }),
    parent: document.body,
  })
}

/** A press and a release, each aimed at an element of its own. */
function tap(down: Element, up: Element, at = { x: 40, y: 40 }) {
  for (const [type, target] of [
    ['pointerdown', down],
    ['pointerup', up],
  ] as const) {
    const e = new MouseEvent(type, { bubbles: true, button: 0, clientX: at.x, clientY: at.y })
    target.dispatchEvent(e)
  }
}

describe('what counts as asking to write', () => {
  it('starts editing on a tap in the text', () => {
    const view = editor('# Note\n\nSome prose to tap on.\n')
    const begin = vi.fn()
    const off = installTapToEdit(view, begin)
    try {
      const line = view.dom.querySelector('.cm-line')!
      tap(line, line)
      expect(begin).toHaveBeenCalledTimes(1)
    } finally {
      off()
      view.destroy()
    }
  })

  it('does not, when the press began on a link that then moved the note', () => {
    const view = editor('# Note\n\nSee [[Other]] for the rest.\n')
    const begin = vi.fn()
    const off = installTapToEdit(view, begin)
    try {
      const link = view.dom.querySelector('[data-wikilink]')
      expect(link).toBeTruthy()
      /*
       * Down on the link, up on a plain line — which is exactly what the
       * browser reports once following the link has scrolled the note. Judged
       * on the pointerup alone this looks like a tap on prose, and the note
       * used to fall into edit mode with a caret in an unrelated line, taking
       * the highlight off the heading it had just arrived at.
       */
      tap(link!, view.dom.querySelector('.cm-line')!)
      expect(begin).not.toHaveBeenCalled()
    } finally {
      off()
      view.destroy()
    }
  })

  it('does not, when the press ends on a link either', () => {
    const view = editor('# Note\n\nSee [[Other]] for the rest.\n')
    const begin = vi.fn()
    const off = installTapToEdit(view, begin)
    try {
      const link = view.dom.querySelector('[data-wikilink]')!
      tap(view.dom.querySelector('.cm-line')!, link)
      expect(begin).not.toHaveBeenCalled()
    } finally {
      off()
      view.destroy()
    }
  })
})
