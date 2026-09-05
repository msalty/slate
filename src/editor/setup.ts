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
  previewMode,
  tableField,
  focusedField,
  focusWatcher,
  focusSeeder,
  interactedField,
} from './livePreview'
import { linkClicks } from './linkClicks'
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
import {
  backspaceInRichText,
  caretOutOfPrefixes,
  deleteInRichText,
  fixEnterPosition,
} from './caret'
import { clipboardHandler } from './paste'
import { editableCompartment, editableFacet } from './reading'
import { WikiLink } from './wikilink-syntax'
import { noteContext, requestLinkDialog } from './context'
import { setDueAtCaret } from './due'
import { focusedCell } from './table'
import { minimalEdit } from '../core/rebase'
import { calloutCompletion, tagCompletion, wikiCompletion } from './completion'

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
  /*
   * The other kind of link: one that leaves the vault.
   *
   * Not ⌘⇧K, however natural that looks beside ⌘K. CodeMirror resolves a
   * shifted letter by trying the unshifted binding first, so ⌘K's wikilink
   * would answer the shifted press and this would never run.
   */
  {
    key: 'Mod-Shift-l',
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
  /*
   * A date for the task the caret is on. Falls through on any other line.
   *
   * ⌘⌥D and not ⌘⇧D, for the reason spelled out at Mod-Shift-l above: search
   * binds ⌘D to selectNextOccurrence, and CodeMirror resolves the unshifted
   * name first, so ⌘⇧D was answered by that and never reached this. Precedence
   * cannot fix it — the unshifted lookup happens across every keymap before the
   * shifted one is tried at all. ⌘⌥D matches on the first lookup instead, and
   * sits with the other ⌘⌥ bindings just above.
   */
  { key: 'Mod-Alt-d', run: setDueAtCaret },
  { key: 'Mod-]', run: applyIndent(1) },
  { key: 'Mod-[', run: applyIndent(-1) },
  { key: 'Mod-/', run: toggleComment },
]

/**
 * The three keys that have to be answered before markdown's own keymap.
 *
 * `markdown()` installs Enter and Backspace of its own at `Prec.high` — the
 * same precedence as the formatting keymap above, and registered ahead of it,
 * so it wins every tie. That is exactly right for a paragraph and wrong for
 * anything rich text is hiding: its Enter continues a list before the caret has
 * been taken out of markup nobody can see, and its Backspace takes a marker off
 * before the blank line above it. Sitting at the top and handing back
 * everything they do not claim is the only ordering that works, and the cost of
 * getting it wrong is silent — the binding simply never runs.
 *
 * Enter still defers to the completion popup by hand. It has to: at this
 * precedence it would otherwise answer the Enter that was accepting a wikilink
 * suggestion, and insert a newline instead.
 */
const hiddenMarkupKeymap = [
  {
    key: 'Enter',
    run: (view: EditorView) =>
      acceptCompletion(view) || fixEnterPosition(view) || insertNewlineContinueMarkup(view),
  },
  /*
   * The deletion keys, for the one position each of them can reach hidden
   * markup from: the start of a line's text and the end of a line. Both fall
   * through everywhere else, which is everywhere the caret is among characters
   * the user can see. See editor/caret.ts.
   */
  { key: 'Backspace', run: backspaceInRichText },
  { key: 'Delete', run: deleteInRichText },
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
  /**
   * False opens the note as a page to read — no caret, and so no keyboard —
   * until a tap in it asks for an editing surface. See editor/reading.ts.
   */
  editable?: boolean
  /**
   * Where the caret starts, for a note opened to be written in. Without one it
   * is position 0, which is right for an empty note and wrong for one that
   * opened with a template already in it — the first keystroke would land
   * inside the heading.
   */
  caret?: number
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
 * Mirrors "a table cell is what the toolbar acts on" onto the editor's DOM.
 *
 * Two pieces of CSS hang off the class: the editor's own caret is hidden, since
 * it would be drawn at the edge of the table block where it means nothing, and
 * the marked cell is shown. Driving it from the signal rather than from the
 * cell's focus events is what keeps it right while the cell is *blurred* but
 * still the target — which is the whole of formatting a table on a phone, where
 * the Format sheet only opens once the keyboard has gone.
 */
const cellTargetWatcher = ViewPlugin.fromClass(
  class {
    private dispose: () => void
    constructor(view: EditorView) {
      this.dispose = focusedCell.subscribe((cell) =>
        view.dom.classList.toggle('cm-cell-editing', !!cell),
      )
    }
    destroy() {
      this.dispose()
      focusedCell.value = null
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
    ? [
        previewMode.of('rich'),
        ...shared,
        // Rich text is the only mode with positions the user cannot see, so it
        // is the only one where they are taken away. See editor/caret.ts.
        caretOutOfPrefixes,
        formatWatcher,
        cellTargetWatcher,
        /*
         * Typing in the note means you are no longer typing in a table cell.
         * The cell is its own editing host, so the editor taking focus is the
         * only reliable signal that the toolbar should stop aiming at it.
         */
        EditorView.focusChangeEffect.of((_state, focusing) => {
          if (focusing) focusedCell.value = null
          return null
        }),
        EditorView.editorAttributes.of({ class: 'cm-rich' }),
      ]
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
    markdownLanguage.data.of({ autocomplete: calloutCompletion }),
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
    editableCompartment.of(editableFacet(opts.editable !== false)),
    previewCompartment.of(previewExtensions(opts.mode)),
    fontCompartment.of(
      EditorView.theme({ '&': { '--editor-font-size': `${opts.fontSize}px` } } as never),
    ),
    clipboardHandler,
    Prec.highest(keymap.of(hiddenMarkupKeymap)),
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

  // `readOnly` stops commands; the editable compartment above stops the
  // browser's own editing affordances (and the phone keyboard) from appearing
  // at all, and a deleted note is opened for reading, so it already has it off.
  if (opts.readOnly) extensions.push(EditorState.readOnly.of(true))

  return EditorState.create({
    doc: opts.doc,
    selection:
      opts.caret === undefined
        ? undefined
        : { anchor: Math.max(0, Math.min(opts.caret, opts.doc.length)) },
    extensions,
  })
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
