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
import type { EditorState } from '@codemirror/state'

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

describe('in a link address', () => {
  /** The href rich text would follow for the first link in the note. */
  const href = (view: EditorView) =>
    view.contentDOM.querySelector('.cm-uri')?.getAttribute('data-href')

  it('resolves, because a link is followed rather than read', async () => {
    const view = await editor('See the [case](https://x.example/c.aspx?TID=$(nights)).\n')
    expect(href(view)).toBe('https://x.example/c.aspx?TID=6')
    view.destroy()
  })

  it('keeps the parentheses the address is entitled to', async () => {
    // The token's own `)` used to end the address, sending the click one
    // character short of where the note said it went.
    const view = await editor('See [it](https://x.example/a_(b)_c).\n')
    expect(href(view)).toBe('https://x.example/a_(b)_c')
    view.destroy()
  })

  it('works while the note is only being read, which is when links are used', async () => {
    const doc = FM + 'See the [case](https://x.example/c.aspx?TID=$(nights)).\n'
    const parent = document.body.appendChild(document.createElement('div'))
    const view = new EditorView({
      parent,
      state: createEditorState({
        doc,
        path: 'note.md',
        mode: 'rich',
        fontSize: 16,
        editable: false,
        onChange: () => {},
      }),
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(href(view)).toBe('https://x.example/c.aspx?TID=6')
    view.destroy()
  })

  it('leaves an address alone when the property is not this note\'s', async () => {
    const view = await editor('See [it](https://x.example/?id=$(nope)).\n')
    expect(href(view)).toBe('https://x.example/?id=$(nope)')
    view.destroy()
  })

  it('resolves a bare address too', async () => {
    const view = await editor('Go to https://x.example/c?TID=$(nights) now.\n')
    expect(href(view)).toBe('https://x.example/c?TID=6')
    view.destroy()
  })

  it('and one inside a table cell', async () => {
    const view = await editor(
      '| Case | Link |\n| --- | --- |\n| 1 | [open](https://x.example/c?TID=$(nights)) |\n',
    )
    const a = view.contentDOM.querySelector('.cm-table-render a')
    expect(a?.getAttribute('href')).toBe('https://x.example/c?TID=6')
    view.destroy()
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

  it('reveals it to a caret placed beside it, which is how it is reached at all', async () => {
    const view = await editor('Hello $(first_name).\n')
    const at = view.state.doc.toString().indexOf('$(first_name)')
    for (const anchor of [at, at + '$(first_name)'.length]) {
      view.dispatch({ selection: { anchor }, userEvent: 'select.pointer' })
      expect(vars(view)).toEqual([])
    }
    view.destroy()
  })

  it('keeps the value under a selection in rich text, so what is highlighted is what is copied', async () => {
    const view = await editor('Hello $(first_name), and welcome.\n')
    const doc = view.state.doc.toString()
    const from = doc.indexOf('Hello')
    view.dispatch({ selection: { anchor: from, head: doc.length }, userEvent: 'select.pointer' })
    expect(shown(view)).toContain('Hello Mike, and welcome.')
    expect(vars(view)).toEqual([{ text: 'Mike', key: 'first_name', blank: false }])
    view.destroy()
  })

  it('but shows the source under one in live preview, which is a mode for the file', async () => {
    const view = await editor('Hello $(first_name), and welcome.\n', 'live')
    const doc = view.state.doc.toString()
    const from = doc.indexOf('Hello')
    view.dispatch({ selection: { anchor: from, head: doc.length }, userEvent: 'select.pointer' })
    expect(shown(view)).toContain('Hello $(first_name), and welcome.')
    view.destroy()
  })
})

/** What the clipboard would end up with for a copy of `text`. */
function copied(view: EditorView, text: string): string {
  const filters = view.state.facet(EditorView.clipboardOutputFilter)
  return filters.reduce((s: string, f: (t: string, st: EditorState) => string) => f(s, view.state), text)
}

describe('copying out of rich text', () => {
  it('puts the values on the clipboard, not the tokens', async () => {
    const view = await editor('Hello $(first_name), all $(nights) nights.\n')
    expect(copied(view, 'Hello $(first_name), all $(nights) nights.')).toBe(
      'Hello Mike, all 6 nights.',
    )
    view.destroy()
  })

  it('carries a blank as its token, which is easier to notice than nothing', async () => {
    const view = await editor('Rate: $(client).\n')
    expect(copied(view, 'Rate: $(client).')).toBe('Rate: $(client).')
    view.destroy()
  })

  it('leaves a name this note never declared alone', async () => {
    const view = await editor('Run $(pwd).\n')
    expect(copied(view, 'Run $(pwd).')).toBe('Run $(pwd).')
    view.destroy()
  })

  it('does not touch live preview or source, which are modes for the file', async () => {
    for (const mode of ['live', 'source'] as EditorMode[]) {
      const view = await editor('Hello $(first_name).\n', mode)
      expect(copied(view, 'Hello $(first_name).')).toBe('Hello $(first_name).')
      view.destroy()
    }
  })

  it('hands a cut the token, because a cut is nearly always a move', async () => {
    const view = await editor('Hello $(first_name).\n')
    // A real cut, so the editor does what a cut does: a range of the body, and
    // one that holds no token of its own, so the note it leaves behind is
    // still the note the assertions below are about.
    const at = view.state.doc.toString().indexOf('Hello')
    view.dispatch({ selection: { anchor: at, head: at + 5 }, userEvent: 'select.pointer' })
    view.contentDOM.dispatchEvent(new Event('cut', { bubbles: true }))
    expect(copied(view, 'Hello $(first_name).')).toBe('Hello $(first_name).')
    // Only for that event: the next copy is a copy again.
    await new Promise((r) => queueMicrotask(() => r(undefined)))
    expect(copied(view, 'Hello $(first_name).')).toBe('Hello Mike.')
    view.destroy()
  })

  it('hands a drag the token, so dropping one back in the note cannot rewrite it', async () => {
    const view = await editor('Hello $(first_name).\n')
    view.contentDOM.dispatchEvent(new Event('dragstart', { bubbles: true }))
    expect(copied(view, 'Hello $(first_name).')).toBe('Hello $(first_name).')
    view.destroy()
  })

  it('and lets go of that by itself, without waiting for a dragend that may never come', async () => {
    const view = await editor('Hello $(first_name).\n')
    view.contentDOM.dispatchEvent(new Event('dragstart', { bubbles: true }))
    // No dragend, no drop: the drag was cancelled, or ended off-window, or was
    // the browser dragging a widget nobody meant to pick up. A flag held until
    // one of those arrived left every later copy handing back tokens.
    await new Promise((r) => queueMicrotask(() => r(undefined)))
    expect(copied(view, 'Hello $(first_name).')).toBe('Hello Mike.')
    view.destroy()
  })
})
