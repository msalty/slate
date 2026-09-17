// @vitest-environment jsdom
/**
 * Folding a callout from inside it.
 *
 * Two safeguards used to cancel each other out. The chevron preserves the
 * selection, because a caret landing on the header line hands back the raw
 * `[!warning]` and takes the chevron with it. The renderer refuses to hide a
 * range holding the selection, because a fold that swallowed the caret would
 * be text you could type into and not see. Both are right on their own; with
 * the caret in the body, the first wrote the `-` and the second declined to
 * act on it, so the click did nothing you could see.
 *
 * These drive the real button through a real EditorView, because that is where
 * the two met.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { EditorView } from '@codemirror/view'
import { EditorSelection } from '@codemirror/state'
import { createEditorState } from './setup'
import { calloutBody, caretOutsideCallout } from './widgets'

const NOTE = [
  'Before the callout.',
  '',
  '> [!WARNING] Friday deploys',
  '> The window closes at 16:00.',
  '> Ask before you push.',
  '',
  'After the callout.',
  '',
].join('\n')

let view: EditorView | undefined

afterEach(() => {
  view?.destroy()
  view = undefined
})

/** A focused, interacted editor — the state in which anything is revealed. */
function open(doc: string, at: number | { anchor: number; head: number }): EditorView {
  const dom = document.createElement('div')
  document.body.appendChild(dom)
  view = new EditorView({
    state: createEditorState({ doc, path: 'note.md', mode: 'live', fontSize: 16, onChange: () => {} }),
    parent: dom,
  })
  view.focus()
  /*
   * `select.pointer` rather than a bare selection: the preview reveals nothing
   * until the user has actually done something, so a note merely opened with
   * the caret at 0 renders whole. A click is what this is standing in for.
   */
  view.dispatch({
    selection: typeof at === 'number' ? EditorSelection.cursor(at) : EditorSelection.single(at.anchor, at.head),
    userEvent: 'select.pointer',
  })
  return view
}

const chevron = (v: EditorView) =>
  v.dom.querySelector<HTMLButtonElement>('.cm-callout-fold') ?? undefined

/** The header line of the callout in NOTE, wherever it has ended up. */
function headerLine(v: EditorView) {
  for (let n = 1; n <= v.state.doc.lines; n++) {
    const line = v.state.doc.line(n)
    if (line.text.includes('[!')) return line
  }
  throw new Error('no callout in this document')
}

describe('the body a fold would hide', () => {
  it('runs from the header line break to the end of the quote', () => {
    const v = open(NOTE, 0)
    const header = headerLine(v)
    const body = calloutBody(v.state, header.to)
    expect(body).toBeDefined()
    expect(body!.from).toBe(header.to)
    expect(body!.lines).toBe(2)
    expect(v.state.doc.sliceString(body!.from + 1, body!.to)).toBe(
      '> The window closes at 16:00.\n> Ask before you push.',
    )
  })

  it('is nothing at all for a callout with no body', () => {
    const v = open('> [!NOTE] On its own\n\nText.\n', 0)
    expect(calloutBody(v.state, headerLine(v).to)).toBeUndefined()
  })
})

describe('where the caret is put when the fold would swallow it', () => {
  it('lands after the callout, which is where you were heading', () => {
    const v = open(NOTE, 0)
    const header = headerLine(v)
    const body = calloutBody(v.state, header.to)!
    const at = caretOutsideCallout(v.state, header, body.to)
    expect(v.state.doc.lineAt(at).number).toBe(header.number + 3)
    expect(at).toBe(v.state.doc.lineAt(at).from)
  })

  it('lands before it when the callout ends the note', () => {
    const doc = 'Intro.\n\n> [!WARNING] Last thing\n> Nothing follows this.'
    const v = open(doc, 0)
    const header = headerLine(v)
    const body = calloutBody(v.state, header.to)!
    const at = caretOutsideCallout(v.state, header, body.to)
    /*
     * Not the header line, which would hand back the raw marker and take the
     * chevron with it — folding would dissolve the control that did it.
     */
    expect(v.state.doc.lineAt(at).number).toBe(header.number - 1)
  })

  it('has nowhere but the header in a note that is only a callout', () => {
    const doc = '> [!WARNING] Only this\n> And its body.'
    const v = open(doc, 0)
    const header = headerLine(v)
    const body = calloutBody(v.state, header.to)!
    expect(caretOutsideCallout(v.state, header, body.to)).toBe(header.to)
  })
})

describe('clicking the chevron', () => {
  /** Position of the second body line, which is squarely inside the fold. */
  const insideBody = (v: EditorView) => headerLine(v).to + 10

  it('folds from outside the callout, as it always did', () => {
    const v = open(NOTE, 0)
    chevron(v)!.click()
    expect(headerLine(v).text).toContain('[!WARNING]-')
    expect(v.dom.querySelector('.cm-callout-folded')).not.toBeNull()
  })

  it('folds from inside the body, moving the caret out of the way', () => {
    const v = open(NOTE, insideBody(v0(NOTE)))
    const before = v.state.selection.main.head
    const body = calloutBody(v.state, headerLine(v).to)!
    expect(before).toBeGreaterThan(body.from)
    expect(before).toBeLessThan(body.to)

    chevron(v)!.click()

    expect(headerLine(v).text).toContain('[!WARNING]-')
    // The whole point: the body is actually hidden, not merely marked.
    expect(v.dom.querySelector('.cm-callout-folded')).not.toBeNull()
    const after = v.state.selection.main.head
    const newBody = calloutBody(v.state, headerLine(v).to)!
    // Clear of the folded range, not merely at the edge of it: one character
    // out by, from reading a position against the wrong document, put it back
    // on the last body line and the fold refused all over again.
    expect(after).toBeGreaterThan(newBody.to)
    // The line straight after the callout, which is where you were heading.
    expect(v.state.doc.lineAt(after).number).toBe(v.state.doc.lineAt(newBody.to).number + 1)
    expect(after).toBe(v.state.doc.lineAt(after).from)
  })

  it('leaves the note itself alone apart from the marker', () => {
    const v = open(NOTE, insideBody(v0(NOTE)))
    chevron(v)!.click()
    expect(v.state.doc.toString()).toBe(NOTE.replace('[!WARNING]', '[!WARNING]-'))
  })

  it('stands down rather than hiding a selection somebody is holding', () => {
    const doc = NOTE
    const probe = v0(doc)
    const header = headerLine(probe)
    const body = calloutBody(probe.state, header.to)!
    const v = open(doc, { anchor: body.from + 3, head: body.to - 3 })

    chevron(v)!.click()

    /*
     * No marker written at all. Writing one whose fold cannot render is the
     * same invisible no-op this whole change exists to remove — better to do
     * nothing and stay saying so.
     */
    expect(headerLine(v).text).toContain('[!WARNING] ')
    expect(headerLine(v).text).not.toContain('[!WARNING]-')
    expect(v.state.selection.main.from).toBe(body.from + 3)
    expect(v.state.selection.main.to).toBe(body.to - 3)
  })

  it('unfolds from anywhere, since nothing is being hidden', () => {
    const v = open(NOTE.replace('[!WARNING]', '[!WARNING]-'), 0)
    expect(v.dom.querySelector('.cm-callout-folded')).not.toBeNull()
    chevron(v)!.click()
    expect(headerLine(v).text).toContain('[!WARNING] ')
    expect(v.dom.querySelector('.cm-callout-folded')).toBeNull()
  })
})

/**
 * A throwaway view used only to measure positions in `doc` before the real one
 * is opened at a selection derived from them.
 */
function v0(doc: string): EditorView {
  const probe = new EditorView({
    state: createEditorState({ doc, path: 'probe.md', mode: 'live', fontSize: 16, onChange: () => {} }),
  })
  probe.destroy()
  return probe
}
