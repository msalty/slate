/**
 * Enter, in a mode where the markup is invisible.
 *
 * Rich text hides the characters that make a line a heading, a list item or a
 * highlight, which leaves the caret with positions that look identical on
 * screen and behave nothing alike. `## |Heading` and `|## Heading` are the same
 * pixel; so are `==phrase|==` and `==phrase==|`. Pressing Enter at the wrong
 * one of each pair cuts a construct in half and leaves the markdown broken in a
 * way the editor then cannot show you:
 *
 *     ==Highlighted phrase        - [ ] Test task     ## Heading
 *     ==                      →   - ⏎[ ] Test task    ## ⏎Heading
 *
 * So before the newline goes in, the caret is taken to the position the user
 * was plainly aiming at:
 *
 *   - Against a hidden inline delimiter it belongs on the far side of it, so
 *     the construct stays whole and the break lands outside it.
 *   - Anywhere in a line's hidden prefix — every position from the start of the
 *     line to the first character of its text draws at the same pixel — it
 *     belongs at the start of that text, and Enter does the ordinary markdown
 *     thing from there: a new quoted line, the next item of a numbered list.
 *
 * Two prefixes want more than that, because the ordinary thing splits them into
 * something the mode cannot show. `## Heading` becomes an empty `## ` above a
 * plain line of text, where every word processor moves the heading down with
 * its words; and a checkbox loses the trailing space that makes it one, because
 * markdown's Enter trims the whitespace behind the caret. Both open a line
 * above instead, carrying nothing (a heading) or their own marker (a list item)
 * up onto it.
 *
 * None of this applies in live preview or source mode, where the syntax is
 * visible and the caret means exactly what it looks like it means.
 */

import { syntaxTree } from '@codemirror/language'
import type { EditorState, TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { parseLine, scanInline } from './format'
import { previewMode } from './livePreview'

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

/** Is this position inside a code block, where markdown prefixes are text? */
function inCodeBlock(state: EditorState, pos: number): boolean {
  for (let n = syntaxTree(state).resolveInner(pos, 1) as { name: string; parent: unknown } | null; n; ) {
    if (n.name === 'FencedCode' || n.name === 'CodeBlock') return true
    n = n.parent as { name: string; parent: unknown } | null
  }
  return false
}

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
