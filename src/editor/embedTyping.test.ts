// @vitest-environment jsdom
/**
 * Typing out an embed, in the mode that used to make it impossible.
 *
 * Rich text keeps a finished embed a picture whatever the caret does beside
 * it, which is right — but it was doing the same to one being written. The
 * moment `![[a]]` parsed, the widget replaced it, the range went atomic, the
 * autocomplete lost the text it was completing, and the note was left with
 * `![[a]]` and no way to type the rest of the name.
 *
 * So these check the two halves of the rule against each other: the markup is
 * there while the caret is between the brackets, and gone the moment it is
 * anywhere else.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { EditorView } from '@codemirror/view'
import { createEditorState } from './setup'
import { livePreview } from './livePreview'

/**
 * A mounted, focused editor — focused the way the app's own mode switch does
 * it, because that is the only route that works headless: jsdom runs no
 * measure cycle, so CodeMirror never notices a `focus()` on its own, and an
 * editor believing itself unfocused reveals nothing at any caret. Re-setting
 * the state re-runs `focusSeeder`, which is exactly what switching editor mode
 * with the caret in the note does in the app.
 */
async function editor(doc: string, mode: 'rich' | 'live'): Promise<EditorView> {
  const state = () => createEditorState({ doc, path: 'note.md', mode, fontSize: 16, onChange: () => {} })
  const parent = document.body.appendChild(document.createElement('div'))
  const view = new EditorView({ parent, state: state() })
  view.focus()
  view.setState(state())
  await new Promise((r) => setTimeout(r, 0))
  return view
}

/** Put the caret somewhere the way a person would: as a user event. */
function caretAt(view: EditorView, at: number) {
  view.dispatch({ selection: { anchor: at }, userEvent: 'select.pointer' })
}

/** True when rich text has swapped this range for a widget. */
function replaced(view: EditorView, from: number, to: number): boolean {
  let found = false
  view.plugin(livePreview)!.decorations.between(from, to, (a, b, deco) => {
    if (deco.spec.widget && a <= from && b >= to) found = true
  })
  return found
}

describe('typing an embed target', () => {
  const doc = 'Start ![[a]] end'
  // `![[a]]` spans 6..12; the target `a` sits at 9.
  const embed = { from: 6, to: 12, target: 9 }
  let view: EditorView

  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('leaves the markup alone in rich text while the caret is between the brackets', async () => {
    view = await editor(doc, 'rich')
    caretAt(view, embed.target)
    expect(replaced(view, embed.from, embed.to)).toBe(false)
    view.destroy()
  })

  it('covers both ends of the target, so the first and last character can be typed', async () => {
    view = await editor(doc, 'rich')
    for (const at of [embed.from + 3, embed.to - 2]) {
      caretAt(view, at)
      expect(replaced(view, embed.from, embed.to)).toBe(false)
    }
    view.destroy()
  })

  it('still shows a picture when the caret is merely beside one', async () => {
    view = await editor(doc, 'rich')
    for (const at of [embed.from, embed.from + 2, embed.to - 1, embed.to]) {
      caretAt(view, at)
      expect(replaced(view, embed.from, embed.to)).toBe(true)
    }
    view.destroy()
  })

  it('is a picture again once the caret leaves', async () => {
    view = await editor(doc, 'rich')
    caretAt(view, embed.target)
    expect(replaced(view, embed.from, embed.to)).toBe(false)
    caretAt(view, doc.length)
    expect(replaced(view, embed.from, embed.to)).toBe(true)
    view.destroy()
  })

  it('reveals it beside the caret in live preview, which is that mode’s whole rule', async () => {
    view = await editor(doc, 'live')
    caretAt(view, embed.to)
    expect(replaced(view, embed.from, embed.to)).toBe(false)
    view.destroy()
  })
})

describe('typing a markdown image address', () => {
  // `![shot](x)` spans 6..16; the address `x` sits at 14.
  const doc = 'Start ![shot](x) end'
  const image = { from: 6, to: 16, url: 14 }
  let view: EditorView

  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('leaves the markup alone while the caret is inside the parentheses', async () => {
    view = await editor(doc, 'rich')
    caretAt(view, image.url)
    expect(replaced(view, image.from, image.to)).toBe(false)
    view.destroy()
  })

  it('but not while it is in the alt text, which the picture is not made of', async () => {
    view = await editor(doc, 'rich')
    caretAt(view, image.from + 3)
    expect(replaced(view, image.from, image.to)).toBe(true)
    view.destroy()
  })
})
