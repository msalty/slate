/**
 * Where the caret can be, and what Enter, Backspace and Delete do about markup
 * it cannot see.
 *
 * Rich text hides the characters that make a line a heading, a list item or a
 * highlight. That leaves the caret with positions that draw at the same pixel
 * and behave nothing alike: `|## Heading`, `#|# Heading` and `## |Heading` are
 * one place on screen and three in the document, and `- |[ ] task` sits between
 * a hidden bullet and a checkbox. Every bug this file exists for is a key
 * pressed at one of those positions doing something to characters nobody could
 * see:
 *
 *     ## ⏎Heading      - ⏎[ ] task      ==phrase⏎==      ⌫ over a whole `## `
 *
 * Three rules, in the order they apply:
 *
 *  1. **The in-between positions do not exist.** A caret landing anywhere
 *     strictly inside a line's hidden prefix snaps to the first character of
 *     the line's text — the only position there you can type at and get what
 *     you see. This is what makes Home, a click in the left margin and an
 *     arrow key agree with each other on a checklist line.
 *  2. **Enter never splits a construct.** Against a hidden inline delimiter the
 *     caret steps to the far side of it. At the start of a line's text, a
 *     heading goes down with its words and a list item gets an empty one of
 *     itself above — because markdown's own Enter leaves `## ` above a plain
 *     line of text, and trims the trailing space that makes `- [ ] ` a task.
 *  3. **Backspace and Delete take one layer at a time.** At the start of a
 *     line's text Backspace removes a blank line above before it removes the
 *     line's own prefix, so it undoes the Enter that made that space; and when
 *     the prefix does come off, all of it comes off at once, rather than the
 *     bullet leaving a literal `[ ]` behind. Delete at the end of a line is the
 *     same rule facing the other way.
 *
 * None of this applies in live preview or source mode, where the syntax is
 * visible and the caret means exactly what it looks like it means.
 */

import { syntaxTree } from '@codemirror/language'
import {
  EditorSelection,
  EditorState,
  type Extension,
  type SelectionRange,
  type TransactionSpec,
} from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { parseLine, scanInline, setBlockStyle, toggleList, toggleQuote } from './format'
import { previewMode } from './livePreview'

/** Is this position inside a code block, where markdown prefixes are text? */
function inCodeBlock(state: EditorState, pos: number): boolean {
  for (let n = syntaxTree(state).resolveInner(pos, 1) as { name: string; parent: unknown } | null; n; ) {
    if (n.name === 'FencedCode' || n.name === 'CodeBlock') return true
    n = n.parent as { name: string; parent: unknown } | null
  }
  return false
}

/**
 * Where a line's text starts, when everything in front of it is hidden.
 *
 * Null when the line has no prefix, or when it is inside a code block — there
 * a leading `- ` is code and the caret has every right to be in the middle of
 * it.
 */
function contentStartOf(state: EditorState, pos: number): number | null {
  const line = state.doc.lineAt(pos)
  const p = parseLine(line.text)
  if (!p.contentFrom) return null
  if (inCodeBlock(state, line.from)) return null
  return line.from + p.contentFrom
}

/* ------------------------------------------------------- rule 1: the caret */

/**
 * Pull a position out of the hidden prefix it landed in.
 *
 * The start of the line itself is deliberately left alone. It draws at the same
 * pixel too, but it is where a select-all begins and where a triple click puts
 * its edge, and moving it would quietly drop the `## ` out of every copy of a
 * heading.
 */
export function snapOutOfPrefix(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(pos)
  if (pos === line.from) return pos
  const contentStart = contentStartOf(state, pos)
  return contentStart !== null && pos < contentStart ? contentStart : pos
}

/**
 * Rule 1, as an extension.
 *
 * A filter rather than anything in the view, because the positions have to be
 * gone for *every* way of arriving at one: a pointer, Home, an arrow key, a
 * command dispatching a selection of its own.
 *
 * Only transactions that do nothing but move the selection are touched. A
 * selection that comes out of an edit was computed from that edit and is not
 * this file's business — and skipping them means `startState` is the state the
 * positions belong to, so the syntax tree behind `contentStartOf` is the right
 * one and never has to be reparsed mid-transaction.
 */
export const caretOutOfPrefixes: Extension = EditorState.transactionFilter.of((tr) => {
  if (tr.docChanged || !tr.selection) return tr
  const state = tr.startState
  let moved = false
  const ranges = tr.selection.ranges.map((r: SelectionRange) => {
    const anchor = snapOutOfPrefix(state, r.anchor)
    const head = snapOutOfPrefix(state, r.head)
    if (anchor === r.anchor && head === r.head) return r
    moved = true
    return EditorSelection.range(anchor, head)
  })
  return moved ? [tr, { selection: EditorSelection.create(ranges, tr.selection.mainIndex) }] : tr
})

/* -------------------------------------------------------- rule 2: newlines */

/**
 * What to do about the caret before a newline is inserted.
 *
 * `move` hands the line break back to the normal Enter command with the caret
 * somewhere sane. `break-above` opens a line above this one and leaves the
 * caret in the text where it was — carrying `prefix` up onto the new line, so a
 * checklist gets an empty checkbox above and a heading gets blank space.
 */
export type EnterPlan =
  | { kind: 'move'; to: number }
  | { kind: 'break-above'; prefix: string }
  | null

/**
 * Step the caret out of hidden inline delimiters it is resting against.
 *
 * Off the end of the inner text it goes past the closing delimiter, off the
 * start it goes back in front of the opening one — repeatedly, so the caret
 * between the two closers of `**==word==**` ends up outside both.
 */
function outOfInlineMarks(text: string, rel: number): number {
  const spans = scanInline(text)
  for (;;) {
    const closing = spans.find((s) => s.innerTo === rel && s.to > rel)
    if (closing) {
      rel = closing.to
      continue
    }
    const opening = spans.find((s) => s.innerFrom === rel && s.from < rel)
    if (!opening) return rel
    rel = opening.from
  }
}

/** Where the caret should be before Enter splits the line, if not where it is. */
export function planEnter(state: EditorState): EnterPlan {
  const sel = state.selection.main
  if (!sel.empty) return null
  const pos = sel.from
  const line = state.doc.lineAt(pos)
  if (inCodeBlock(state, line.from)) return null

  const p = parseLine(line.text)
  const contentStart = line.from + p.contentFrom

  if (pos <= contentStart) {
    /*
     * Every position from the start of the line to the start of its text is the
     * same pixel once the prefix is hidden, so they are all treated as the one
     * the user could see. `contentStart < line.to` is what keeps an *empty*
     * item out of it: there Enter should start the next line, or end the list,
     * rather than push an empty marker around.
     */
    const hasText = contentStart < line.to
    // A heading goes down with its words. Nothing is carried up: the line left
    // behind is blank body text, which is what "space above the heading" is.
    if (p.level > 0 && hasText) return { kind: 'break-above', prefix: '' }
    /*
     * A list item gets an empty one of itself above, marker copied verbatim.
     *
     * Verbatim matters for a checkbox: the ordinary markdown Enter trims the
     * whitespace behind the caret, and `- [ ]` without its trailing space is
     * not a task at all — it is a bullet with the characters `[ ]` in it, which
     * in rich text shows up as exactly that. Ordered items are left to the
     * markdown command, which renumbers the rest of the list as it goes.
     */
    if ((p.markerKind === 'check' || p.markerKind === 'bullet') && hasText)
      return { kind: 'break-above', prefix: p.indent + p.quote + p.marker + p.task }
    if (pos < contentStart) return { kind: 'move', to: contentStart }
  }

  const moved = line.from + outOfInlineMarks(line.text, pos - line.from)
  return moved === pos ? null : { kind: 'move', to: moved }
}

/** The `break-above` edit: the line moves down, the caret stays in its text. */
export function breakAbove(state: EditorState, prefix: string): TransactionSpec {
  const line = state.doc.lineAt(state.selection.main.from)
  const contentStart = line.from + parseLine(line.text).contentFrom
  const insert = prefix + state.lineBreak
  return {
    changes: { from: line.from, insert },
    selection: { anchor: contentStart + insert.length },
    userEvent: 'input',
    scrollIntoView: true,
  }
}

/**
 * The Enter fix-up, as a command.
 *
 * Returning false for the `move` case is deliberate: the caret has been put
 * right and the newline itself is still markdown's business, so the binding
 * falls through to `insertNewlineContinueMarkup` behind it — which is what
 * continues a list, renumbers it, and ends one on a second Enter.
 */
export function fixEnterPosition(view: EditorView): boolean {
  if (view.state.facet(previewMode) !== 'rich') return false
  const plan = planEnter(view.state)
  if (!plan) return false
  if (plan.kind === 'break-above') {
    view.dispatch(breakAbove(view.state, plan.prefix))
    return true
  }
  view.dispatch({ selection: { anchor: plan.to }, userEvent: 'select' })
  return false
}

/* ------------------------------------------------------- rule 3: deletion */

/** Is this line blank — the space markdown puts between two blocks? */
function isBlank(state: EditorState, lineNumber: number): boolean {
  return !state.doc.line(lineNumber).text.trim()
}

/**
 * Backspace at the first character of a line's text.
 *
 * A blank line above goes first. That line is the space Enter opened, and until
 * it is gone the caret has not actually reached the top of anything — taking
 * the heading off instead is the one thing that cannot be undone by pressing
 * the key again, and it is what made "delete in front of a heading strips the
 * formatting" a bug report rather than a feature.
 *
 * With no blank line above, one layer of prefix comes off, through the very
 * commands the format bar's own buttons run — so backspacing a heading and
 * pressing Body land on the same markdown, and `- [ ] ` leaves as the one thing
 * it is rather than as a bullet that strands a literal `[ ]`.
 *
 * Returns null everywhere else, including a caret merely *near* the start, so
 * ordinary backspacing over text is never touched.
 */
export function planBackspace(state: EditorState): TransactionSpec | null {
  const sel = state.selection.main
  if (!sel.empty) return null
  const line = state.doc.lineAt(sel.from)
  const contentStart = contentStartOf(state, sel.from)
  if (contentStart === null || sel.from !== contentStart) return null

  if (line.number > 1 && isBlank(state, line.number - 1)) {
    const prev = state.doc.line(line.number - 1)
    return {
      changes: { from: prev.from, to: line.from },
      userEvent: 'delete.backward',
      scrollIntoView: true,
    }
  }

  const p = parseLine(line.text)
  const peel =
    p.level > 0
      ? setBlockStyle(state, 'body')
      : p.markerKind
        ? toggleList(state, p.markerKind)
        : p.quote
          ? toggleQuote(state)
          : null
  return peel && { ...peel, userEvent: 'delete.backward', scrollIntoView: true }
}

/**
 * Delete at the end of a line, facing the line below.
 *
 * The same rule the other way round: a blank line between two blocks is removed
 * on its own, and only then does the line below come up — losing its prefix as
 * it does, because two lines becoming one can only carry the style of the line
 * they land on. Left to the default, both happened at once: one press on
 * `intro` turned `intro`, a blank line and `## Heading line` into the single
 * paragraph `introHeading line`.
 */
export function planDelete(state: EditorState): TransactionSpec | null {
  const sel = state.selection.main
  if (!sel.empty) return null
  const line = state.doc.lineAt(sel.from)
  if (sel.from !== line.to || line.number >= state.doc.lines) return null
  const next = state.doc.line(line.number + 1)
  const contentStart = contentStartOf(state, next.from)
  const blankBelow = !next.text.trim()
  // Everything else deletes one character, exactly as it always did.
  if (contentStart === null && !blankBelow) return null
  /*
   * The line break, and only the line break, in the two cases where nothing
   * should come up with it: a blank line below is the space between two blocks
   * and goes on its own, and a line above with no text of its own has no style
   * to impose on whatever arrives, so that line keeps its own markers.
   */
  const to = contentStart === null || line.from === line.to ? next.from : contentStart
  return { changes: { from: line.to, to }, userEvent: 'delete.forward', scrollIntoView: true }
}

/** Backspace and Delete, as commands, in rich text only. */
const deletionCommand =
  (plan: (state: EditorState) => TransactionSpec | null) => (view: EditorView) => {
    if (view.state.facet(previewMode) !== 'rich') return false
    const spec = plan(view.state)
    if (!spec) return false
    view.dispatch(spec)
    return true
  }

export const backspaceInRichText = deletionCommand(planBackspace)
export const deleteInRichText = deletionCommand(planDelete)
