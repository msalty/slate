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
  ViewPlugin,
  type ViewUpdate,
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
  previewMode,
  tableField,
  focusedField,
  focusWatcher,
  focusSeeder,
  interactedField,
} from './livePreview'
import {
  applyBlockStyle,
  applyIndent,
  applyInline,
  applyList,
  applyQuote,
  EMPTY_SNAPSHOT,
  formatSnapshot,
  inspect,
} from './format'
import { pasteHandler } from './paste'
import { WikiLink } from './wikilink-syntax'
import { noteContext, requestLinkDialog } from './context'
import { minimalEdit } from '../core/rebase'
import { tagCompletion, wikiCompletion } from './completion'

export const previewCompartment = new Compartment()
export const contextCompartment = new Compartment()
export const fontCompartment = new Compartment()

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

const formattingKeymap = [
  { key: 'Mod-b', run: applyInline('bold') },
  { key: 'Mod-i', run: applyInline('italic') },
  { key: 'Mod-u', run: applyInline('underline') },
  { key: 'Mod-Shift-x', run: applyInline('strike') },
  { key: 'Mod-Shift-h', run: applyInline('highlight') },
  { key: 'Mod-e', run: applyInline('code') },
  { key: 'Mod-k', run: makeWikiLink },
  // The other kind of link: one that leaves the vault.
  {
    key: 'Mod-Shift-k',
    run: () => {
      requestLinkDialog()
      return true
    },
  },
  // Paragraph styles, on the same keys a word processor uses.
  { key: 'Mod-Alt-1', run: applyBlockStyle('title') },
  { key: 'Mod-Alt-2', run: applyBlockStyle('heading') },
  { key: 'Mod-Alt-3', run: applyBlockStyle('subheading') },
  { key: 'Mod-Alt-0', run: applyBlockStyle('body') },
  { key: 'Mod-Shift-8', run: applyList('bullet') },
  { key: 'Mod-Shift-0', run: applyList('number') },
  { key: 'Mod-Shift-9', run: applyQuote },
  { key: 'Mod-Shift-7', run: applyList('check') },
  { key: 'Mod-]', run: applyIndent(1) },
  { key: 'Mod-[', run: applyIndent(-1) },
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

/** The three ways the same markdown can be presented. */
export type EditorMode = 'rich' | 'live' | 'source'

export interface EditorOptions {
  doc: string
  path: string
  mode: EditorMode
  fontSize: number
  onChange: (text: string) => void
  onSelectionIdle?: () => void
  /** Deleted notes are shown, not edited: restore one to change it. */
  readOnly?: boolean
}

/**
 * Publishes what is under the caret so the format bar can show its pressed
 * states. Only installed in rich mode, which is the only mode with a bar.
 */
const formatWatcher = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      formatSnapshot.value = inspect(view.state)
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet) formatSnapshot.value = inspect(u.state)
    }
    destroy() {
      formatSnapshot.value = EMPTY_SNAPSHOT
    }
  },
)

/**
 * The rendering extensions for a mode. Source mode gets none of them: the
 * buffer is the file, shown exactly as it will be written.
 */
export function previewExtensions(mode: EditorMode): Extension {
  if (mode === 'source') return []
  const shared = [
    focusedField,
    focusWatcher,
    focusSeeder,
    interactedField,
    livePreview,
    tableField,
    linkClicks,
  ]
  return mode === 'rich'
    ? [previewMode.of('rich'), ...shared, formatWatcher, EditorView.editorAttributes.of({ class: 'cm-rich' })]
    : shared
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
    previewCompartment.of(previewExtensions(opts.mode)),
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

  if (opts.readOnly) {
    // Both: `readOnly` stops commands, `editable` stops the browser's own
    // editing affordances (and the phone keyboard) from appearing at all.
    extensions.push(EditorState.readOnly.of(true), EditorView.editable.of(false))
  }

  return EditorState.create({ doc: opts.doc, extensions })
}

/**
 * Replace the document's text without losing undo history, scroll or caret.
 *
 * Only the span that actually differs is replaced, so text arriving from a sync
 * pull above the caret does not drag the caret with it, and an edit elsewhere in
 * the note leaves the cursor exactly where the user left it.
 */
export function setDoc(view: EditorView, text: string, path: string) {
  const edit = minimalEdit(view.state.doc.toString(), text)
  if (!edit) return
  view.dispatch({
    changes: edit,
    effects: contextCompartment.reconfigure(noteContext.of({ path })),
  } as Transaction | Parameters<EditorView['dispatch']>[0])
}
