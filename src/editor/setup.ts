/**
 * Editor assembly: the extension set, the keymap, and the compartments that
 * let settings change without tearing the editor down.
 */

import {
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
  Prec,
  type Transaction,
} from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightSpecialChars,
  keymap,
  placeholder,
  rectangularSelection,
} from '@codemirror/view'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  toggleComment,
} from '@codemirror/commands'
import { bracketMatching, indentOnInput } from '@codemirror/language'
import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { markdown, markdownLanguage, insertNewlineContinueMarkup } from '@codemirror/lang-markdown'
import { codeLanguages } from './languages'
import { editorTheme, highlighting } from './theme'
import {
  livePreview,
  linkClicks,
  tableField,
  focusedField,
  focusWatcher,
  interactedField,
} from './livePreview'
import { pasteHandler } from './paste'
import { WikiLink } from './wikilink-syntax'
import { noteContext } from './context'
import { tagCompletion, wikiCompletion } from './completion'

export const previewCompartment = new Compartment()
export const contextCompartment = new Compartment()
export const fontCompartment = new Compartment()

/** Wrap the selection (or the word at the caret) in a pair of markers. */
function wrapWith(marker: string) {
  return (view: EditorView): boolean => {
    const changes = view.state.changeByRange((range) => {
      const doc = view.state.doc
      let { from, to } = range
      if (from === to) {
        // No selection: operate on the word under the caret.
        const line = doc.lineAt(from)
        const rel = from - line.from
        const left = /[\w'-]*$/.exec(line.text.slice(0, rel))?.[0].length ?? 0
        const right = /^[\w'-]*/.exec(line.text.slice(rel))?.[0].length ?? 0
        from -= left
        to += right
      }
      const text = doc.sliceString(from, to)
      const already =
        text.startsWith(marker) && text.endsWith(marker) && text.length >= marker.length * 2
      const next = already ? text.slice(marker.length, -marker.length) : `${marker}${text}${marker}`
      const delta = already ? -marker.length : marker.length
      return {
        changes: { from, to, insert: next },
        range: EditorSelection.range(range.from + delta, range.to + delta),
      }
    })
    view.dispatch(changes, { scrollIntoView: true, userEvent: 'input.format' })
    return true
  }
}

/** Turn the selection into a wikilink, or open the link autocomplete. */
function makeWikiLink(view: EditorView): boolean {
  const changes = view.state.changeByRange((range) => {
    const text = view.state.doc.sliceString(range.from, range.to)
    const insert = `[[${text}]]`
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.range(range.from + 2 + text.length, range.from + 2 + text.length),
    }
  })
  view.dispatch(changes, { userEvent: 'input.format' })
  return true
}

/** Prefix every selected line with a marker (list, quote, task). */
function prefixLines(prefix: string) {
  return (view: EditorView): boolean => {
    const { state } = view
    const changes: Array<{ from: number; to: number; insert: string }> = []
    const done = new Set<number>()
    for (const range of state.selection.ranges) {
      for (let n = state.doc.lineAt(range.from).number; n <= state.doc.lineAt(range.to).number; n++) {
        if (done.has(n)) continue
        done.add(n)
        const line = state.doc.line(n)
        const existing = new RegExp(`^\\s*${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
        if (existing.test(line.text)) {
          const m = existing.exec(line.text)!
          changes.push({ from: line.from + m[0].length - prefix.length, to: line.from + m[0].length, insert: '' })
        } else {
          const indent = /^\s*/.exec(line.text)![0].length
          changes.push({ from: line.from + indent, to: line.from + indent, insert: prefix })
        }
      }
    }
    if (!changes.length) return false
    view.dispatch({ changes, userEvent: 'input.format' })
    return true
  }
}

const formattingKeymap = [
  { key: 'Mod-b', run: wrapWith('**') },
  { key: 'Mod-i', run: wrapWith('*') },
  { key: 'Mod-Shift-x', run: wrapWith('~~') },
  { key: 'Mod-e', run: wrapWith('`') },
  { key: 'Mod-k', run: makeWikiLink },
  { key: 'Mod-Shift-8', run: prefixLines('- ') },
  { key: 'Mod-Shift-9', run: prefixLines('> ') },
  { key: 'Mod-Shift-7', run: prefixLines('- [ ] ') },
  { key: 'Mod-/', run: toggleComment },
  // Continue lists and quotes on Enter — the single highest-value markdown
  // affordance, so it takes precedence over the default newline command.
  //
  // It must hand off to the completion popup first, though. This binding sits
  // at high precedence, so without the explicit check it swallows Enter while a
  // wikilink suggestion is open and inserts a newline instead of accepting it.
  {
    key: 'Enter',
    run: (view: EditorView) => acceptCompletion(view) || insertNewlineContinueMarkup(view),
  },
]

export interface EditorOptions {
  doc: string
  path: string
  live: boolean
  fontSize: number
  onChange: (text: string) => void
  onSelectionIdle?: () => void
}

export function createEditorState(opts: EditorOptions): EditorState {
  const md = markdown({
    base: markdownLanguage,
    codeLanguages,
    extensions: [WikiLink],
  })

  const extensions: Extension[] = [
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    highlightSpecialChars(),
    highlightSelectionMatches(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    search({ top: true }),
    EditorState.allowMultipleSelections.of(true),
    EditorView.lineWrapping,
    placeholder('Start writing…'),
    md,
    markdownLanguage.data.of({ autocomplete: wikiCompletion }),
    markdownLanguage.data.of({ autocomplete: tagCompletion }),
    autocompletion({
      activateOnTyping: true,
      closeOnBlur: true,
      maxRenderedOptions: 60,
      icons: false,
      defaultKeymap: true,
    }),
    editorTheme,
    highlighting,
    contextCompartment.of(noteContext.of({ path: opts.path })),
    previewCompartment.of(
      opts.live
        ? [focusedField, focusWatcher, interactedField, livePreview, tableField, linkClicks]
        : [],
    ),
    fontCompartment.of(
      EditorView.theme({ '&': { '--editor-font-size': `${opts.fontSize}px` } } as never),
    ),
    pasteHandler,
    Prec.high(keymap.of(formattingKeymap)),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      ...completionKeymap,
      indentWithTab,
    ]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) opts.onChange(u.state.doc.toString())
    }),
  ]

  return EditorState.create({ doc: opts.doc, extensions })
}

/** Replace the whole document without losing undo history or scroll. */
export function setDoc(view: EditorView, text: string, path: string) {
  const current = view.state.doc.toString()
  if (current === text) return
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: Math.min(view.state.selection.main.anchor, text.length) },
    effects: contextCompartment.reconfigure(noteContext.of({ path })),
  } as Transaction | Parameters<EditorView['dispatch']>[0])
}
