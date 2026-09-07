// @vitest-environment jsdom
/**
 * `$(property)` in the body, drawn from the note's own frontmatter.
 *
 * The two halves worth pinning down are what gets substituted and what
 * deliberately does not: a key the note declares becomes its value, and
 * anything else — an unknown key, a shell command in a sentence, a token
 * inside code — is left exactly as it was typed. Plus the escape hatch every
 * other construct in this editor has: the caret reveals the source.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { EditorView } from '@codemirror/view'
import { createEditorState, type EditorMode } from './setup'

const FM = ['---', 'first_name: Mike', 'client:', 'tags: [travel, lisbon]', 'nights: 6', '---', ''].join('\n')

/**
 * A mounted, focused editor — focused the way the app's own mode switch does
 * it, because that is the only route that works headless (see
 * embedTyping.test.ts, which needs the same trick for the same reason).
 */
async function editor(body: string, mode: EditorMode = 'rich'): Promise<EditorView> {
  const doc = FM + body
  const state = () => createEditorState({ doc, path: 'note.md', mode, fontSize: 16, onChange: () => {} })
  const parent = document.body.appendChild(document.createElement('div'))
  const view = new EditorView({ parent, state: state() })
  view.focus()
  view.setState(state())
  await new Promise((r) => setTimeout(r, 0))
  return view
}

/** What the note reads as on screen. */
const shown = (view: EditorView) => view.contentDOM.textContent ?? ''

const vars = (view: EditorView) =>
  [...view.contentDOM.querySelectorAll('.cm-var')].map((el) => ({
    text: el.textContent,
    key: (el as HTMLElement).dataset.var,
    blank: el.classList.contains('cm-var-blank'),
  }))

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('a property written into the body', () => {
  it('reads as its value, in the sentence, with no chrome around it', async () => {
    const view = await editor('Hello $(first_name), and welcome.\n')
    expect(shown(view)).toContain('Hello Mike, and welcome.')
    expect(vars(view)).toEqual([{ text: 'Mike', key: 'first_name', blank: false }])
    view.destroy()
  })

  it('joins a list the way the properties form takes one', async () => {
    const view = await editor('Filed under $(tags).\n')
    expect(shown(view)).toContain('Filed under travel, lisbon.')
    view.destroy()
  })

  it('shows a number as itself', async () => {
    const view = await editor('$(nights) nights.\n')
    expect(shown(view)).toContain('6 nights.')
    view.destroy()
  })

  it('is a blank wearing its own name until the property is filled in', async () => {
    const view = await editor('Prepared for $(client).\n')
    expect(vars(view)).toEqual([{ text: 'client', key: 'client', blank: true }])
    view.destroy()
  })

  it('reads the same inside a table cell, which the editor draws itself', async () => {
    const view = await editor('| Field | Value |\n| --- | --- |\n| Client | $(first_name) |\n')
    const cell = view.contentDOM.querySelector('.cm-table-render .cm-var')
    expect(cell?.textContent).toBe('Mike')
    view.destroy()
  })

  it('opens the properties form on a click in rich text, and nowhere else', async () => {
    const rich = await editor('Hello $(first_name).\n', 'rich')
    expect(vars(rich)[0].key).toBe('first_name')
    rich.destroy()
    // Live preview renders the value too, but has no form to open, so the
    // click hook is not there: a click lands the caret and reveals the token.
    const live = await editor('Hello $(first_name).\n', 'live')
    expect(vars(live)).toEqual([{ text: 'Mike', key: undefined, blank: false }])
    live.destroy()
  })
})

describe('what it leaves alone', () => {
  it('a key this note never declared', async () => {
    const view = await editor('Run $(pwd) to see where you are.\n')
    expect(shown(view)).toContain('Run $(pwd) to see')
    expect(vars(view)).toEqual([])
    view.destroy()
  })

  it('a token inside code, where text is literal', async () => {
    const view = await editor('Type `$(first_name)` to write it.\n')
    expect(shown(view)).toContain('$(first_name)')
    expect(vars(view)).toEqual([])
    view.destroy()
  })

  it('the frontmatter block itself', async () => {
    const view = await editor('Body.\n', 'live')
    // The block is visible in live preview; nothing in it has been swapped.
    expect(shown(view)).toContain('first_name: Mike')
    expect(vars(view)).toEqual([])
    view.destroy()
  })

  it('the file, which still says what was typed', async () => {
    const view = await editor('Hello $(first_name).\n')
    expect(view.state.doc.toString()).toContain('Hello $(first_name).')
    view.destroy()
  })
})

describe('editing one', () => {
  it('reveals the token the caret is inside, in rich text as well as live', async () => {
    for (const mode of ['rich', 'live'] as EditorMode[]) {
      const view = await editor('Hello $(first_name).\n', mode)
      const at = view.state.doc.toString().indexOf('$(first_name)') + 4
      view.dispatch({ selection: { anchor: at }, userEvent: 'select.pointer' })
      expect(shown(view)).toContain('$(first_name)')
      expect(vars(view)).toEqual([])
      view.destroy()
    }
  })
})
