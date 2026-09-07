/**
 * `$(key)` — the note's own frontmatter, read back into its body.
 *
 * The properties form already holds what a note *is*: who the client is, what
 * the address is, when it starts. This is how those values get to say
 * something in the page as well as in the form — write `$(client)` in the
 * body and the rendered views show the value, so a note made from a template
 * fills itself in as its properties are filled in.
 *
 * Two rules keep it honest:
 *
 *   - The file is never rewritten. `$(client)` is what is on disk and what
 *     other editors see; only the two rendered modes swap it for a value, and
 *     the caret reveals the token again the moment it lands inside one.
 *   - Only a key the note actually declares is touched. `$(pwd)` in a note
 *     with no `pwd` property is left exactly as typed, because a shell command
 *     in a sentence is not a variable and guessing wrong is worse than doing
 *     nothing.
 *
 * The values come out of the buffer rather than out of the index, so a
 * property edited in the form shows in the body on the same keystroke that
 * writes it.
 */

import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { parseFrontmatter, varText, type FrontmatterValue } from '../core/markdown'

/**
 * Line numbers of a leading `---` block, fences included.
 *
 * Capped, because a note whose first line is `---` and which never closes the
 * block would otherwise be scanned to its end on every keystroke — and a
 * frontmatter block two hundred lines long is not one.
 */
export function frontmatterLines(state: EditorState): number[] {
  if (state.doc.lines < 2) return []
  if (state.doc.line(1).text.trim() !== '---') return []
  const limit = Math.min(state.doc.lines, 200)
  for (let n = 2; n <= limit; n++) {
    if (state.doc.line(n).text.trim() === '---') {
      return Array.from({ length: n }, (_, i) => i + 1)
    }
  }
  return []
}

/** Where the frontmatter block ends, or -1 when the note has none. */
export function frontmatterEnd(state: EditorState, lines = frontmatterLines(state)): number {
  return lines.length ? state.doc.line(lines[lines.length - 1]).to : -1
}

/*
 * The last block parsed, and what came out of it.
 *
 * Decorations are rebuilt on every keystroke, every selection change and every
 * scroll, and all but the first of those leave the frontmatter exactly as it
 * was. One entry is enough: there is one editor, and it is showing one note.
 */
let cache: { text: string; data: Record<string, FrontmatterValue> } | undefined

/** The note's properties, parsed out of the buffer it is being edited in. */
export function frontmatterOf(
  state: EditorState,
  lines = frontmatterLines(state),
): Record<string, FrontmatterValue> {
  const end = frontmatterEnd(state, lines)
  if (end < 0) return {}
  const text = state.doc.sliceString(0, end)
  if (cache?.text !== text) cache = { text, data: parseFrontmatter(text).data }
  return cache.data
}

/**
 * `$(` offers the note's own properties.
 *
 * Which is most of what makes the feature findable: there is no menu for it,
 * so the list that appears the moment the bracket is typed is where somebody
 * learns both that this exists and what this note has to offer.
 */
export function propertyCompletion(context: CompletionContext): CompletionResult | null {
  const before = context.matchBefore(/\$\([A-Za-z0-9_.-]*/)
  if (!before) return null
  const data = frontmatterOf(context.state)
  const keys = Object.keys(data)
  if (!keys.length) return null

  const options: Completion[] = keys.map((key) => {
    const value = varText(data[key])
    return {
      label: key,
      detail: value ?? 'empty',
      apply: applyKey(key),
    }
  })
  return { from: before.from + 2, options, validFor: /^[A-Za-z0-9_.-]*$/ }
}

/**
 * Insert the key and close the token.
 *
 * `closeBrackets` has usually already put the `)` there — typing `$(` leaves
 * the caret between a matched pair — so the completion has to absorb it or
 * accepting a suggestion leaves `$(client))` behind. The same problem, and the
 * same answer, as completing a wikilink.
 */
function applyKey(key: string) {
  return (view: EditorView, _c: Completion, from: number, to: number) => {
    const closed = view.state.doc.sliceString(to, to + 1) === ')'
    view.dispatch({
      changes: { from, to: closed ? to + 1 : to, insert: `${key})` },
      selection: { anchor: from + key.length + 1 },
      userEvent: 'input.complete',
    })
  }
}
