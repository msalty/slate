/**
 * Formatting commands: what the Rich Text toolbar (and the keyboard shortcuts)
 * actually do to the markdown.
 *
 * The document is markdown at every instant — there is no rich-text model being
 * serialised. "Make this a heading" is a text edit that puts `## ` at the front
 * of a line; "bold" wraps a range in `**`. What makes it feel like a rich-text
 * editor is that rich mode never shows those characters back to you.
 *
 * Everything here is a pure function from EditorState to a transaction spec, so
 * the rules can be tested without a DOM. The thin `Command` wrappers at the
 * bottom are what the keymap and the toolbar call.
 */

import { signal } from '@preact/signals'
import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

/** Paragraph styles, named as Apple Notes names them. */
export type BlockStyle = 'title' | 'heading' | 'subheading' | 'body'

/** Character-level styles. */
export type InlineMark = 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'highlight'

export type ListKind = 'bullet' | 'number' | 'check'

/** Heading level each paragraph style maps to. Body is "no heading". */
const BLOCK_LEVEL: Record<BlockStyle, number> = { title: 1, heading: 2, subheading: 3, body: 0 }

/**
 * Delimiters per mark.
 *
 * Underline is the one thing Apple Notes offers that markdown has no syntax
 * for, so it uses the HTML every markdown renderer already passes through.
 * Highlight uses the `==` convention Obsidian popularised.
 */
const DELIMS: Record<InlineMark, { open: string; close: string }> = {
  bold: { open: '**', close: '**' },
  italic: { open: '*', close: '*' },
  underline: { open: '<u>', close: '</u>' },
  strike: { open: '~~', close: '~~' },
  code: { open: '`', close: '`' },
  highlight: { open: '==', close: '==' },
}

/* ------------------------------------------------------------- line parsing */

export interface LineParts {
  /** Leading whitespace. */
  indent: string
  /** Any `> ` quote markers, verbatim. */
  quote: string
  /** The list marker including its trailing space, e.g. `- ` or `2. `. */
  marker: string
  markerKind: ListKind | null
  /** The `[ ] ` / `[x] ` task box including its trailing space. */
  task: string
  /** Heading level, 0 when the line is body text. */
  level: number
  /** The `## ` heading marker including its trailing space. */
  headingMark: string
  /** Offset within the line where the content proper begins. */
  contentFrom: number
  content: string
}

/**
 * Split a line into its markdown prefixes and its content.
 *
 * Order matters and follows the grammar: indent, then quotes, then a list
 * marker, then a task box, then a heading marker.
 */
export function parseLine(text: string): LineParts {
  let i = 0
  const indent = /^[ \t]*/.exec(text)![0]
  i += indent.length

  const quote = /^(?:>[ \t]?)*/.exec(text.slice(i))![0]
  i += quote.length

  let marker = ''
  let markerKind: ListKind | null = null
  const bullet = /^([-*+])([ \t]+)/.exec(text.slice(i))
  const numbered = bullet ? null : /^(\d{1,9}[.)])([ \t]+)/.exec(text.slice(i))
  if (bullet) {
    marker = bullet[0]
    markerKind = 'bullet'
  } else if (numbered) {
    marker = numbered[0]
    markerKind = 'number'
  }
  i += marker.length

  let task = ''
  if (markerKind) {
    const box = /^(\[[ xX]\])([ \t]+)/.exec(text.slice(i))
    if (box) {
      task = box[0]
      markerKind = 'check'
      i += task.length
    }
  }

  let headingMark = ''
  let level = 0
  const h = /^(#{1,6})([ \t]+)/.exec(text.slice(i))
  if (h) {
    headingMark = h[0]
    level = h[1].length
    i += headingMark.length
  }

  return {
    indent,
    quote,
    marker,
    markerKind,
    task,
    level,
    headingMark,
    contentFrom: i,
    content: text.slice(i),
  }
}

/* ----------------------------------------------------------- inline scanning */

export interface InlineSpan {
  mark: InlineMark
  /** Range of the whole construct, delimiters included. */
  from: number
  to: number
  /** Range of the text between the delimiters. */
  innerFrom: number
  innerTo: number
}

/**
 * Rules in precedence order: code first, because nothing inside it is markup,
 * then the two-character marks before the one-character one so `**bold**` is
 * never read as an empty italic wrapping `*bold*`.
 */
const INLINE_RULES: Array<{ mark: InlineMark; re: RegExp }> = [
  { mark: 'code', re: /^(`+)([^`]+?)\1(?!`)/ },
  { mark: 'underline', re: /^<u>(.+?)<\/u>/ },
  { mark: 'bold', re: /^\*\*(?!\s)(.+?)(?<!\s)\*\*/ },
  { mark: 'strike', re: /^~~(?!\s)(.+?)(?<!\s)~~/ },
  { mark: 'highlight', re: /^==(?!\s)(.+?)(?<!\s)==/ },
  { mark: 'italic', re: /^\*(?!\s|\*)(.+?)(?<!\s)\*(?!\*)/ },
]

/**
 * Every inline construct on one line, nested ones included.
 *
 * This is a scanner rather than a syntax-tree walk because it has to answer
 * "is the caret inside bold text" for text the parser may not have reached yet,
 * and because the same answer drives both the toolbar's pressed states and the
 * unwrap half of a toggle.
 */
export function scanInline(text: string, offset = 0, depth = 0): InlineSpan[] {
  const out: InlineSpan[] = []
  if (depth > 4) return out

  for (let i = 0; i < text.length; ) {
    let hit: { mark: InlineMark; m: RegExpExecArray } | undefined
    for (const rule of INLINE_RULES) {
      const m = rule.re.exec(text.slice(i))
      if (m) {
        hit = { mark: rule.mark, m }
        break
      }
    }
    if (!hit) {
      i++
      continue
    }
    const whole = hit.m[0]
    const inner = hit.m[hit.m.length - 1]
    const innerFrom = i + whole.indexOf(inner)
    out.push({
      mark: hit.mark,
      from: offset + i,
      to: offset + i + whole.length,
      innerFrom: offset + innerFrom,
      innerTo: offset + innerFrom + inner.length,
    })
    // Nested marks, except inside code where the content is literal.
    if (hit.mark !== 'code') out.push(...scanInline(inner, offset + innerFrom, depth + 1))
    i += whole.length
  }
  return out
}

/** The innermost span of `mark` whose inner text covers [from, to]. */
function spanAround(
  state: EditorState,
  mark: InlineMark,
  from: number,
  to: number,
): InlineSpan | undefined {
  const line = state.doc.lineAt(from)
  if (to > line.to) return undefined
  const spans = scanInline(line.text, line.from).filter(
    (s) => s.mark === mark && s.innerFrom <= from && s.innerTo >= to,
  )
  // Innermost wins: the shortest enclosing span.
  return spans.sort((a, b) => a.to - a.from - (b.to - b.from))[0]
}

/* ------------------------------------------------------------ block styles */

/**
 * Package prefix edits — the ones that rewrite the markers at the head of a
 * line — into a transaction that leaves the caret in the *content*.
 *
 * CodeMirror's default mapping keeps a position on the left of anything
 * inserted at that exact position, so turning an empty line into a checklist
 * item leaves the caret in front of `- [ ] ` and the first thing typed lands
 * before the checkbox. Mapping the selection forward instead puts the caret
 * where the text goes. It matters most in rich mode, where the marker is
 * hidden: a caret on the wrong side of it looks identical and behaves nothing
 * alike.
 */
function prefixEdit(
  state: EditorState,
  changes: Array<{ from: number; to: number; insert: string }>,
): TransactionSpec {
  const set = state.changes(changes)
  return { changes: set, selection: state.selection.map(set, 1), userEvent: 'input.format' }
}

/** Lines the selection touches, as line numbers. */
function selectedLines(state: EditorState): number[] {
  const out = new Set<number>()
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from).number
    const last = state.doc.lineAt(r.to).number
    for (let n = first; n <= last; n++) out.add(n)
  }
  return [...out].sort((a, b) => a - b)
}

/**
 * Apply a paragraph style to every selected line.
 *
 * A heading replaces any heading already there, keeps the indent and any quote,
 * and drops a list marker: `- ## Groceries` is legal markdown but renders as a
 * heading buried in a bullet, which is never what picking "Heading" meant.
 */
export function setBlockStyle(state: EditorState, style: BlockStyle): TransactionSpec | null {
  const level = BLOCK_LEVEL[style]
  const changes: Array<{ from: number; to: number; insert: string }> = []

  for (const n of selectedLines(state)) {
    const line = state.doc.line(n)
    const p = parseLine(line.text)
    if (p.level === level && (level === 0 || !p.marker)) continue
    const keep = level === 0 ? p.marker + p.task : ''
    const prefix = p.indent + p.quote + keep + (level ? `${'#'.repeat(level)} ` : '')
    changes.push({ from: line.from, to: line.from + p.contentFrom, insert: prefix })
  }
  return changes.length ? prefixEdit(state, changes) : null
}

/* ------------------------------------------------------------------- lists */

const LIST_PREFIX: Record<ListKind, (n: number) => string> = {
  bullet: () => '- ',
  number: (n) => `${n}. `,
  check: () => '- [ ] ',
}

/**
 * The number a new ordered-list item should carry: one past the item above it
 * at the same indent, or 1 when it starts a list. Without this, turning one
 * line inside a numbered list into a list item would restart it at 1.
 */
function numberFor(state: EditorState, lineNumber: number, indent: string): number {
  for (let n = lineNumber - 1; n >= 1; n--) {
    const p = parseLine(state.doc.line(n).text)
    if (!p.content.trim() && !p.marker) break
    if (p.indent.length !== indent.length) continue
    if (p.markerKind !== 'number') break
    return Number.parseInt(p.marker, 10) + 1
  }
  return 1
}

/**
 * Toggle a list style across the selection. Applying the kind a line already
 * has removes it, which is what a pressed toolbar button should do.
 */
export function toggleList(state: EditorState, kind: ListKind): TransactionSpec | null {
  const lines = selectedLines(state)
  const parsed = lines.map((n) => parseLine(state.doc.line(n).text))
  const remove = parsed.every((p) => p.markerKind === kind)
  const changes: Array<{ from: number; to: number; insert: string }> = []
  let counter = 0

  for (let i = 0; i < lines.length; i++) {
    const line = state.doc.line(lines[i])
    const p = parsed[i]
    // A blank line in the middle of a multi-line selection stays blank.
    if (!remove && !p.content.trim() && !p.marker && lines.length > 1) continue

    const head = p.indent + p.quote
    let insert: string
    if (remove) {
      insert = head
    } else if (kind === 'number') {
      counter = counter === 0 ? numberFor(state, lines[i], p.indent) : counter + 1
      insert = head + LIST_PREFIX.number(counter)
    } else {
      insert = head + LIST_PREFIX[kind](0)
    }
    const to = line.from + p.indent.length + p.quote.length + p.marker.length + p.task.length
    if (state.doc.sliceString(line.from, to) === insert) continue
    changes.push({ from: line.from, to, insert })
  }
  return changes.length ? prefixEdit(state, changes) : null
}

/** Toggle `> ` on the selected lines. */
export function toggleQuote(state: EditorState): TransactionSpec | null {
  const lines = selectedLines(state)
  const parsed = lines.map((n) => parseLine(state.doc.line(n).text))
  const remove = parsed.every((p) => p.quote.length > 0)
  const changes: Array<{ from: number; to: number; insert: string }> = []

  for (let i = 0; i < lines.length; i++) {
    const line = state.doc.line(lines[i])
    const p = parsed[i]
    const from = line.from + p.indent.length
    if (remove) changes.push({ from, to: from + p.quote.length, insert: '' })
    else changes.push({ from, to: from, insert: '> ' })
  }
  return changes.length ? prefixEdit(state, changes) : null
}

/**
 * Nest or un-nest list items.
 *
 * Deliberately limited to list lines: four spaces in front of a paragraph is an
 * indented code block in markdown, so a general-purpose indent button would
 * silently turn prose into code.
 */
export function indentList(state: EditorState, dir: 1 | -1): TransactionSpec | null {
  const changes: Array<{ from: number; to: number; insert: string }> = []
  for (const n of selectedLines(state)) {
    const line = state.doc.line(n)
    const p = parseLine(line.text)
    if (!p.markerKind) continue
    const at = line.from + p.indent.length + p.quote.length
    if (dir === 1) {
      changes.push({ from: at, to: at, insert: '  ' })
    } else {
      const drop = Math.min(2, p.indent.length)
      if (!drop) continue
      changes.push({ from: line.from, to: line.from + drop, insert: '' })
    }
  }
  return changes.length ? { changes, userEvent: 'input.format' } : null
}

export function canIndent(state: EditorState, dir: 1 | -1): boolean {
  return selectedLines(state).some((n) => {
    const p = parseLine(state.doc.line(n).text)
    return !!p.markerKind && (dir === 1 || p.indent.length > 0)
  })
}

/* ------------------------------------------------------------ inline marks */

/**
 * Toggle an inline mark.
 *
 * Three cases, in the order a person would expect them: inside an existing span
 * of that mark, unwrap it; with text selected, wrap it; with a bare caret, wrap
 * the word under the caret, or — if there is no word — leave an empty pair with
 * the caret inside it, so whatever gets typed next comes out styled.
 */
export function toggleInline(state: EditorState, mark: InlineMark): TransactionSpec {
  const { open, close } = DELIMS[mark]

  return state.changeByRange((range) => {
    const existing = spanAround(state, mark, range.from, range.to)
    if (existing) {
      const shift = (pos: number) =>
        pos - (pos > existing.innerFrom ? open.length : 0) - (pos > existing.innerTo ? close.length : 0)
      return {
        changes: [
          { from: existing.from, to: existing.innerFrom, insert: '' },
          { from: existing.innerTo, to: existing.to, insert: '' },
        ],
        range: EditorSelection.range(
          Math.max(existing.from, shift(range.from)),
          Math.max(existing.from, shift(range.to)),
        ),
      }
    }

    let { from, to } = range
    if (from === to) {
      const line = state.doc.lineAt(from)
      const rel = from - line.from
      const left = /[\w'-]*$/.exec(line.text.slice(0, rel))?.[0].length ?? 0
      const right = /^[\w'-]*/.exec(line.text.slice(rel))?.[0].length ?? 0
      from -= left
      to += right
    } else {
      // Leave whitespace outside the markers. `**word **` is not emphasis in
      // CommonMark — a closing run may not be preceded by a space — so a
      // selection that swept up a trailing space would render as literal
      // asterisks instead of bold text.
      const raw = state.doc.sliceString(from, to)
      from += raw.length - raw.trimStart().length
      to -= raw.length - raw.trimEnd().length
      if (to < from) to = from
    }
    const text = state.doc.sliceString(from, to)
    return {
      changes: { from, to, insert: `${open}${text}${close}` },
      range: text
        ? EditorSelection.range(from + open.length, to + open.length)
        : EditorSelection.cursor(from + open.length),
    }
  })
}

/* -------------------------------------------------------------- inspection */

export interface FormatSnapshot {
  /** False when no editor has the caret; the toolbar renders inert. */
  active: boolean
  block: BlockStyle
  list: ListKind | null
  quote: boolean
  marks: Record<InlineMark, boolean>
  canIndent: boolean
  canOutdent: boolean
}

const NO_MARKS: Record<InlineMark, boolean> = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  code: false,
  highlight: false,
}

export const EMPTY_SNAPSHOT: FormatSnapshot = {
  active: false,
  block: 'body',
  list: null,
  quote: false,
  marks: NO_MARKS,
  canIndent: false,
  canOutdent: false,
}

function styleForLevel(level: number): BlockStyle {
  return level === 1 ? 'title' : level === 2 ? 'heading' : level >= 3 ? 'subheading' : 'body'
}

/** What the toolbar should show as pressed for the current selection. */
export function inspect(state: EditorState): FormatSnapshot {
  const head = state.selection.main
  const line = state.doc.lineAt(head.from)
  const p = parseLine(line.text)
  const marks = { ...NO_MARKS }
  for (const m of Object.keys(DELIMS) as InlineMark[]) {
    marks[m] = !!spanAround(state, m, head.from, head.to)
  }
  return {
    active: true,
    block: styleForLevel(p.level),
    list: p.markerKind,
    quote: p.quote.length > 0,
    marks,
    canIndent: canIndent(state, 1),
    canOutdent: canIndent(state, -1),
  }
}

/**
 * What the toolbar renders from: the state of the editor that currently holds
 * the caret. Published by the rich-mode watcher in `setup.ts`, and reset when
 * that editor goes away so a stale note's formatting can't be shown as active.
 */
export const formatSnapshot = signal<FormatSnapshot>(EMPTY_SNAPSHOT)

/* ----------------------------------------------------------------- commands */

function run(view: EditorView, spec: TransactionSpec | null): boolean {
  if (!spec) return false
  view.dispatch(spec, { scrollIntoView: true })
  return true
}

export const applyBlockStyle = (style: BlockStyle) => (view: EditorView) =>
  run(view, setBlockStyle(view.state, style))

export const applyInline = (mark: InlineMark) => (view: EditorView) =>
  run(view, { ...toggleInline(view.state, mark), userEvent: 'input.format' })

export const applyList = (kind: ListKind) => (view: EditorView) =>
  run(view, toggleList(view.state, kind))

export const applyQuote = (view: EditorView) => run(view, toggleQuote(view.state))

export const applyIndent = (dir: 1 | -1) => (view: EditorView) =>
  run(view, indentList(view.state, dir))
