/**
 * Where the caret can be on a line whose markup is hidden, and what Enter,
 * Backspace and Delete do about it.
 *
 * Rich text draws `- [ ] Task 1` as a checkbox and a sentence. The six
 * characters in front of that sentence are still in the document, though, so
 * without help the caret has six places to be along a stretch of screen with
 * two — and four of them break the line if anything is typed or deleted there.
 *
 * So the line's head is one atom, and it has exactly two edges:
 *
 *     ▌- [ ] Task 1              - [ ] ▌Task 1
 *      in front of the marker     behind it
 *
 * Which one you get is decided by the marker, not by the characters: click to
 * the left of the checkbox and you are in front of it, click to the right and
 * you are behind it, and the arrow keys step over the whole thing rather than
 * through it. The two edges then mean different things, and that is the point
 * of having both:
 *
 *   | | Enter | Backspace |
 *   |---|---|---|
 *   | in front | the line moves down, leaving space above | the line moves up |
 *   | behind   | another item like this one, above | the marker comes off |
 *
 * A heading or a quote has no marker drawn for it, so there is nothing to be in
 * front of and the two edges are one place: there, Enter moves the heading down
 * with its words, and Backspace takes the blank line above before it takes the
 * style off.
 *
 * Two smaller rules finish the job. Enter beside a hidden inline delimiter
 * steps over it, so a line break never lands inside `==phrase==`. And typing at
 * the front edge goes into the line's text rather than in front of its marker,
 * because `x- [ ] Task 1` is not a checklist item at all.
 *
 * An ordered list is the exception to all of it: `1.` is on screen, so its
 * caret positions are real and every key here leaves them alone.
 *
 * None of this applies in live preview or source mode, where the syntax is
 * visible and the caret means exactly what it looks like it means.
 */

import { syntaxTree } from '@codemirror/language'
import {
  EditorSelection,
  EditorState,
  type Extension,
  RangeSet,
  RangeValue,
  type SelectionRange,
  type TransactionSpec,
} from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import {
  type LineParts,
  parseLine,
  scanInline,
  setBlockStyle,
  toggleList,
  toggleQuote,
} from './format'
import { previewMode } from './livePreview'

/** Is this position inside a code block, where markdown prefixes are text? */
function inCodeBlock(state: EditorState, pos: number): boolean {
  for (let n = syntaxTree(state).resolveInner(pos, 1) as { name: string; parent: unknown } | null; n; ) {
    if (n.name === 'FencedCode' || n.name === 'CodeBlock') return true
    n = n.parent as { name: string; parent: unknown } | null
  }
  return false
}

/** The head of a line, and how much of it the reader cannot see. */
export interface LineHead {
  /** The front edge: the caret position ahead of the bullet or checkbox. */
  from: number
  /** The end of the hidden run — the first place a caret may sit again. */
  hiddenTo: number
  /** The back edge: where the line's own text begins. */
  contentStart: number
  /** True when something is actually drawn there to be in front of. */
  hasMarker: boolean
  parts: LineParts
}

/**
 * What is hidden at the head of the line holding `pos`, if anything.
 *
 * Null for a line with nothing hidden — including an ordered list item, whose
 * `1.` is on screen and whose caret positions are therefore all real, and
 * anything inside a code block, where a leading `- ` is code.
 */
export function lineHead(state: EditorState, pos: number): LineHead | null {
  const line = state.doc.lineAt(pos)
  const p = parseLine(line.text)
  if (!p.contentFrom) return null
  if (inCodeBlock(state, line.from)) return null

  const hasMarker = !!p.task || p.markerKind === 'bullet'
  if (!hasMarker && !p.quote && !p.headingMark) return null
  /*
   * An ordered marker is left on screen unless it carries a checkbox, so the
   * hidden run stops in front of it — `> 1. item` hides the quote and nothing
   * else, and the caret may still sit inside the `1. `.
   */
  const numbered = p.markerKind === 'number' && !p.task && !p.headingMark
  const hiddenTo = numbered
    ? line.from + p.indent.length + p.quote.length
    : line.from + p.contentFrom
  if (hiddenTo <= line.from) return null
  return { from: line.from, hiddenTo, contentStart: line.from + p.contentFrom, hasMarker, parts: p }
}

/* ------------------------------------------------------ the head as an atom */

class HiddenHead extends RangeValue {}
const hiddenHead = new HiddenHead()

function headAtoms(view: EditorView): RangeSet<HiddenHead> {
  const ranges = []
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos)
      const head = lineHead(view.state, line.from)
      if (head) ranges.push(hiddenHead.range(head.from, head.hiddenTo))
      if (line.to >= to) break
      pos = line.to + 1
    }
  }
  return RangeSet.of(ranges, true)
}

/**
 * The hidden head of every visible line, declared atomic as **one** range.
 *
 * This is what gives the line its two edges and nothing in between, and doing
 * it here rather than by hand is what makes every way of moving agree: an arrow
 * key steps to the far edge because CodeMirror skips an atom in the direction
 * of travel, a click lands on whichever edge it is nearer — which is to say, on
 * the side of the checkbox you clicked — and a selection edge inside the head
 * is pushed out to cover it, so copying a heading copies the `## `.
 *
 * The live-preview decorations are already atomic, but as separate ranges: the
 * hidden `- `, then the checkbox widget. That leaves the seam between them a
 * legal place to stand, which is where Home used to land and where Backspace
 * used to take the bullet and leave a stranded `[ ]`.
 */
export const hiddenHeadAtoms = ViewPlugin.fromClass(
  class {
    atoms: RangeSet<HiddenHead>
    constructor(view: EditorView) {
      this.atoms = headAtoms(view)
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.atoms = headAtoms(u.view)
    }
  },
  {
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atoms ?? RangeSet.empty),
  },
)

/**
 * The backstop, for selections that arrive without having skipped the atom.
 *
 * Home is the one that matters: it moves to a *visual* line boundary, which on
 * a checklist line is the seam behind the hidden bullet. Anything that does
 * land inside the head goes to whichever edge is nearer — the same rule a click
 * follows, so the two never disagree about the same pixel — and on a line with
 * no marker drawn, where there is nothing to be in front of, to the text.
 */
export function snapOutOfPrefix(state: EditorState, pos: number): number {
  const head = lineHead(state, pos)
  if (!head || pos <= head.from || pos >= head.hiddenTo) return pos
  if (!head.hasMarker) return head.hiddenTo
  return pos - head.from < head.hiddenTo - pos ? head.from : head.hiddenTo
}

/**
 * A filter rather than anything in the view, because a selection can be set
 * from anywhere. Only transactions that do nothing but move the selection are
 * touched: one that comes out of an edit was computed from that edit and is not
 * this file's business — and skipping them means `startState` is the state the
 * positions belong to, so the syntax tree behind `lineHead` is the right one
 * and never has to be reparsed mid-transaction.
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

/**
 * Typing at the front edge goes into the line's text.
 *
 * The front edge is a place to press Enter and Backspace, not a place to write:
 * a character inserted there lands in front of the marker, and `x- [ ] Task 1`
 * is a paragraph beginning with an x, not a checklist item. Nothing about that
 * is visible until the checkbox disappears.
 */
export const typeIntoText: Extension = EditorView.inputHandler.of((view, from, to, text) => {
  if (view.state.facet(previewMode) !== 'rich' || from !== to) return false
  const head = lineHead(view.state, from)
  if (!head || from !== head.from) return false
  view.dispatch({
    changes: { from: head.contentStart, insert: text },
    selection: { anchor: head.contentStart + text.length },
    userEvent: 'input.type',
    scrollIntoView: true,
  })
  return true
})

/* ------------------------------------------------------------------- Enter */

/**
 * What to do about the caret before a newline is inserted.
 *
 * `move` hands the line break back to the normal Enter command with the caret
 * somewhere sane. `break-above` opens a line above this one and leaves the
 * caret on the same edge of the line it was on, so pressing Enter again does
 * the same thing again rather than something else.
 */
export type EnterPlan =
  | { kind: 'move'; to: number }
  | { kind: 'break-above'; prefix: string; caret: 'front' | 'text' }
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
  const head = lineHead(state, pos)

  if (head) {
    const p = head.parts
    // In front of the marker: the whole line goes down, and the caret rides
    // with it — so a second Enter pushes it down again rather than splitting it.
    if (pos === head.from) return { kind: 'break-above', prefix: '', caret: 'front' }
    if (pos === head.contentStart) {
      // A heading goes down with its words; the line left behind is blank body
      // text, which is what "space above the heading" is. There is no marker to
      // stand in front of, so this edge answers for both. An empty heading has
      // nothing to carry down, and Enter simply starts the line below it.
      if (p.level > 0 && head.contentStart < line.to)
        return { kind: 'break-above', prefix: '', caret: 'text' }
      /*
       * A list item gets another one of itself above, marker copied verbatim —
       * whether it has text yet or not. Markdown's own Enter treats an empty
       * item as the end of the list, which is a keyboard way out of one, but
       * here Backspace behind the marker is that way out and says so plainly:
       * it takes the checkbox off and leaves the line. Left to markdown, an
       * empty item at the end of a longer list got a blank line inserted above
       * it instead, which is neither thing.
       *
       * Verbatim matters for a checkbox: markdown's Enter trims the whitespace
       * behind the caret, and `- [ ]` without its trailing space is not a task
       * at all — it is a bullet with the characters `[ ]` in it, which in rich
       * text shows up as exactly that.
       */
      if (p.markerKind === 'check' || p.markerKind === 'bullet')
        return { kind: 'break-above', prefix: p.indent + p.quote + p.marker + p.task, caret: 'text' }
    }
    // Anything left standing inside the head, from a source that skipped the
    // atom, is treated as the text edge.
    if (pos < head.contentStart) return { kind: 'move', to: head.contentStart }
  }

  if (inCodeBlock(state, line.from)) return null
  const moved = line.from + outOfInlineMarks(line.text, pos - line.from)
  return moved === pos ? null : { kind: 'move', to: moved }
}

/** The `break-above` edit: the line moves down, the caret keeps its edge. */
export function breakAbove(
  state: EditorState,
  prefix: string,
  caret: 'front' | 'text' = 'text',
): TransactionSpec {
  const line = state.doc.lineAt(state.selection.main.from)
  const contentStart = line.from + parseLine(line.text).contentFrom
  const insert = prefix + state.lineBreak
  return {
    changes: { from: line.from, insert },
    selection: { anchor: (caret === 'front' ? line.from : contentStart) + insert.length },
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
    view.dispatch(breakAbove(view.state, plan.prefix, plan.caret))
    return true
  }
  view.dispatch({ selection: { anchor: plan.to }, userEvent: 'select' })
  return false
}

/* --------------------------------------------------------------- deletion */

/** Take one layer of markup off the line, exactly as the format bar would. */
function peel(state: EditorState, p: LineParts): TransactionSpec | null {
  const spec =
    p.level > 0
      ? setBlockStyle(state, 'body')
      : p.markerKind
        ? toggleList(state, p.markerKind)
        : p.quote
          ? toggleQuote(state)
          : null
  return spec && { ...spec, userEvent: 'delete.backward', scrollIntoView: true }
}

/**
 * Backspace on either edge of a hidden head.
 *
 * In front of the marker the line comes *up* a line: the blank space above it
 * goes, or, with a line of text up there instead, the two join — and a line
 * that has joined another can only carry one style, so the marker goes with the
 * break. Behind the marker the marker itself goes, whole, which is the only way
 * `- [ ] ` leaves without stranding the `[ ]` half of itself.
 *
 * A heading has no marker drawn to be in front of, so its one edge does both,
 * in that order: the blank line above first — until that is gone, Backspace has
 * not reached the top of anything, and taking the style off instead is the one
 * thing pressing the key again cannot undo.
 */
export function planBackspace(state: EditorState): TransactionSpec | null {
  const sel = state.selection.main
  if (!sel.empty) return null
  const head = lineHead(state, sel.from)
  if (!head) return null
  const line = state.doc.lineAt(sel.from)
  const front = sel.from === head.from
  if (!front && sel.from !== head.contentStart) return null

  const prev = line.number > 1 ? state.doc.line(line.number - 1) : null
  const blankAbove = !!prev && !prev.text.trim()
  const upALine = (): TransactionSpec | null => {
    if (!prev) return null
    if (blankAbove)
      return {
        changes: { from: prev.from, to: line.from },
        userEvent: 'delete.backward',
        scrollIntoView: true,
      }
    return {
      changes: { from: prev.to, to: head.contentStart },
      userEvent: 'delete.backward',
      scrollIntoView: true,
    }
  }

  if (front) return upALine()
  // The text edge. On a line with a marker it is behind that marker, and only
  // the marker is in question; on one without, it is the front of the line too.
  if (head.hasMarker) return peel(state, head.parts)
  return blankAbove ? upALine() : peel(state, head.parts)
}

/**
 * Delete at the end of a line, facing the line below.
 *
 * The same rule the other way round: a blank line between two blocks is removed
 * on its own, and only then does the line below come up — losing its marker as
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
  const head = lineHead(state, next.from)
  const blankBelow = !next.text.trim()
  // Everything else deletes one character, exactly as it always did.
  if (!head && !blankBelow) return null
  /*
   * The line break, and only the line break, in the two cases where nothing
   * should come up with it: a blank line below is the space between two blocks
   * and goes on its own, and a line above with no text of its own has no style
   * to impose on whatever arrives, so that line keeps its own markers.
   */
  const to = !head || line.from === line.to ? next.from : head.contentStart
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
