/**
 * Live preview: markdown that looks rendered but *is* still markdown.
 *
 * The document in the buffer is always the exact text that gets written to the
 * .md file — nothing here transforms content. All it does is hide syntax
 * characters and swap a few spans for widgets, and it reveals the real syntax
 * the moment the caret enters a construct, so nothing is ever uneditable.
 *
 * That is the whole reason this approach was chosen over a document-model
 * WYSIWYG: there is no serialization step that could quietly rewrite the user's
 * file, so a round-trip is lossless by construction.
 *
 * Two modes share all of this:
 *
 *   - `live` reveals the source of whatever the caret is inside. You see
 *     `**bold**` while you are editing that word, and bold text everywhere else.
 *   - `rich` never reveals *formatting* syntax — emphasis, headings, quotes,
 *     list markers, checkboxes — so the note reads as a word processor
 *     document. Since the marks are atomic, backspacing over a hidden `## `
 *     removes the whole thing and the line becomes body text, which is how a
 *     rich-text editor behaves anyway.
 *
 * Rich mode still reveals *structural* source — link URLs, wikilink targets,
 * tables, rules — because those carry data with nowhere else to be edited.
 * Hiding them permanently would make parts of a note unreachable, which is a
 * worse sin than showing a bracket.
 */

import { syntaxTree } from '@codemirror/language'
import {
  type EditorState,
  Facet,
  type Range,
  RangeSet,
  StateEffect,
  StateField,
} from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import type { SyntaxNodeRef } from '@lezer/common'
import {
  BulletWidget,
  CheckboxWidget,
  EmbedWidget,
  HrWidget,
  TableWidget,
  isDelimiterRow,
} from './widgets'
import { noteContext, requestOpenLink } from './context'
import { resolveEmbed, resolveLink } from '../core/vault'
import { revision } from '../core/vault'

/** Which of the two rendering modes the preview extensions are running in. */
export type PreviewMode = 'live' | 'rich'

export const previewMode = Facet.define<PreviewMode, PreviewMode>({
  combine: (values) => values[0] ?? 'live',
})

const hidden = Decoration.replace({})
const underlined = Decoration.mark({ class: 'cm-underline' })
const highlighted = Decoration.mark({ class: 'cm-highlight' })

const lineDeco = (cls: string) => Decoration.line({ class: cls })

const H = [1, 2, 3, 4, 5, 6].map((n) => lineDeco(`cm-h${n}`))
const quoteLine = lineDeco('cm-quote')
const codeLine = lineDeco('cm-codeblock')
const codeFirst = lineDeco('cm-codeblock cm-codeblock-first')
const codeLast = lineDeco('cm-codeblock cm-codeblock-last')
const tableLine = lineDeco('cm-table')
const taskDone = Decoration.mark({ class: 'cm-task-done' })

/** Marks whose only job is syntax; hidden unless the caret is in range. */
const MARK_NODES = new Set([
  'EmphasisMark',
  'StrongEmphasisMark',
  'StrikethroughMark',
  'CodeMark',
  'HeaderMark',
  'QuoteMark',
  'LinkMark',
  'WikiLinkMark',
  'SuperscriptMark',
  'SubscriptMark',
])

/**
 * Whether the editor has focus.
 *
 * Live preview reveals raw syntax wherever the caret is, which is right while
 * you're typing and wrong the moment you look away: a note whose first line is
 * a table would sit there showing pipes, because the caret starts at position 0
 * and never moved. Tracking focus lets an unfocused editor render everything.
 */
const setFocused = StateEffect.define<boolean>()

export const focusedField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setFocused)) return e.value
    return value
  },
})

export const focusWatcher = EditorView.focusChangeEffect.of((_state, focusing) =>
  setFocused.of(focusing),
)

/**
 * Seed that flag when the extensions are installed.
 *
 * `focusChangeEffect` only fires on a *change*, so switching editor mode while
 * the caret is in the note leaves a freshly configured field believing the
 * editor is unfocused — and an unfocused editor never reveals anything. The
 * dispatch is deferred because a plugin may not update the view it is being
 * constructed for.
 */
export const focusSeeder = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      if (!view.hasFocus) return
      queueMicrotask(() => {
        if (view.dom.isConnected && view.hasFocus) view.dispatch({ effects: setFocused.of(true) })
      })
    }
  },
)

/**
 * Has the user actually done anything in this editor yet?
 *
 * Opening a note focuses it with the caret at position 0. That position is
 * legitimately "inside" a table or a bold span that starts the note, so reveal
 * on caret position alone would show raw pipes the instant a note whose first
 * line is a table is opened — never having been touched. Only a real user
 * event (a click, an arrow key, a keystroke) counts as editing.
 *
 * The table widget's own click-to-edit dispatch tags itself `select.pointer`
 * for exactly this reason.
 */
export const interactedField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    if (value) return true
    return (
      tr.isUserEvent('select') ||
      tr.isUserEvent('input') ||
      tr.isUserEvent('delete') ||
      tr.isUserEvent('move') ||
      tr.isUserEvent('undo') ||
      tr.isUserEvent('redo')
    )
  },
})

/**
 * True when the caret is in [from, to] and the user is actually working there.
 *
 * `kind` says what would be revealed: `format` is styling the toolbar can apply
 * and remove on its own, so rich mode keeps it hidden; `structure` is source
 * with nowhere else to be edited, revealed in both modes.
 */
function touched(
  state: EditorState,
  from: number,
  to: number,
  kind: 'format' | 'structure' = 'structure',
): boolean {
  if (kind === 'format' && state.facet(previewMode) === 'rich') return false
  if (!state.field(focusedField, false)) return false
  if (!state.field(interactedField, false)) return false
  for (const r of state.selection.ranges) {
    if (r.from <= to && r.to >= from) return true
  }
  return false
}

/** True when a selection range is on any line the node spans. */
function lineTouched(
  state: EditorState,
  from: number,
  to: number,
  kind: 'format' | 'structure' = 'structure',
): boolean {
  const a = state.doc.lineAt(from).from
  const b = state.doc.lineAt(to).to
  return touched(state, a, b, kind)
}

const TAG_RE = /(^|[\s(>])(#[A-Za-z0-9_][A-Za-z0-9/_-]*)/g

/** Inline styles the markdown parser has no node for: `<u>text</u>`, `==text==`. */
const INLINE_EXTRAS: Array<[RegExp, Decoration]> = [
  [/<u>(.+?)<\/u>/g, underlined],
  [/==(?!\s)(.+?)(?<!\s)==/g, highlighted],
]

/** Line numbers of a leading `---` frontmatter block, fences included. */
function frontmatterLines(state: EditorState): number[] {
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

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view
  const out: Array<Range<Decoration>> = []
  const ctx = state.facet(noteContext)
  const tree = syntaxTree(state)
  // Lines already given a block decoration, so nested nodes don't double up.
  const seenLines = new Set<number>()

  /*
   * Frontmatter, before anything else.
   *
   * A leading `---` block is genuinely ambiguous markdown: `date: 2026-09-12`
   * followed by `---` parses as a setext H1, so left alone the metadata renders
   * as a huge heading at the top of every note. Claiming these lines first —
   * and marking them seen — gives them a quiet properties-block look instead,
   * still fully editable.
   */
  const fmLines = frontmatterLines(state)
  for (const n of fmLines) {
    const line = state.doc.line(n)
    seenLines.add(line.from)
    const cls =
      n === fmLines[0]
        ? 'cm-frontmatter cm-frontmatter-first'
        : n === fmLines[fmLines.length - 1]
          ? 'cm-frontmatter cm-frontmatter-last'
          : 'cm-frontmatter'
    out.push(lineDeco(cls).range(line.from))
  }

  /*
   * Table source lines, from the same scan that drives the rendered widget.
   * Claiming them here keeps the tree walk from also styling them, and
   * monospaces the pipes while the caret is inside so columns line up.
   */
  for (const t of findTables(state)) {
    const first = state.doc.line(t.fromLine)
    const last = state.doc.line(t.toLine)
    const editing = touched(state, first.from, last.to)
    for (let n = t.fromLine; n <= t.toLine; n++) {
      const line = state.doc.line(n)
      seenLines.add(line.from)
      if (editing) out.push(tableLine.range(line.from))
    }
  }

  for (const { from: vFrom, to: vTo } of view.visibleRanges) {
    tree.iterate({
      from: vFrom,
      to: vTo,
      enter: (node: SyntaxNodeRef) => {
        const name = node.name

        /* ---- headings ------------------------------------------------ */
        const atx = /^ATXHeading([1-6])$/.exec(name) ?? /^SetextHeading([1-2])$/.exec(name)
        if (atx) {
          const line = state.doc.lineAt(node.from)
          if (!seenLines.has(line.from)) {
            seenLines.add(line.from)
            out.push(H[Number(atx[1]) - 1].range(line.from))
          }
          return
        }

        /* ---- blockquote ---------------------------------------------- */
        if (name === 'Blockquote') {
          for (let p = node.from; p <= node.to; ) {
            const line = state.doc.lineAt(p)
            if (!seenLines.has(line.from)) {
              seenLines.add(line.from)
              out.push(quoteLine.range(line.from))
            }
            if (line.to >= node.to) break
            p = line.to + 1
          }
          return
        }

        /* ---- fenced code --------------------------------------------- */
        if (name === 'FencedCode' || name === 'CodeBlock') {
          const firstLine = state.doc.lineAt(node.from).number
          const lastLine = state.doc.lineAt(Math.max(node.from, node.to - 1)).number
          for (let n = firstLine; n <= lastLine; n++) {
            const line = state.doc.line(n)
            if (seenLines.has(line.from)) continue
            seenLines.add(line.from)
            const deco = n === firstLine ? codeFirst : n === lastLine ? codeLast : codeLine
            out.push(deco.range(line.from))
          }
          return
        }

        /* ---- horizontal rule ------------------------------------------ */
        if (name === 'HorizontalRule') {
          if (!lineTouched(state, node.from, node.to))
            out.push(Decoration.replace({ widget: new HrWidget() }).range(node.from, node.to))
          return
        }

        /* ---- list markers ---------------------------------------------- */
        if (name === 'ListMark') {
          const line = state.doc.lineAt(node.from)
          if (lineTouched(state, node.from, node.to, 'format')) return
          const rest = line.text.slice(node.to - line.from)
          // A task's own checkbox is the marker; a literal dash beside it is
          // noise, so it goes entirely.
          if (/^\s*\[[ xX]\]/.test(rest)) {
            out.push(hidden.range(node.from, Math.min(node.to + 1, line.to)))
            return
          }
          // Ordered lists keep their numbers; unordered ones get a real bullet.
          if (/^[-*+]$/.test(state.doc.sliceString(node.from, node.to))) {
            out.push(
              Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to),
            )
          }
          return
        }

        /* ---- task checkboxes ------------------------------------------ */
        if (name === 'TaskMarker') {
          const raw = state.doc.sliceString(node.from, node.to)
          const checked = /x/i.test(raw)
          if (!touched(state, node.from - 1, node.to + 1, 'format')) {
            out.push(
              Decoration.replace({ widget: new CheckboxWidget(checked) }).range(node.from, node.to),
            )
          }
          if (checked) {
            const line = state.doc.lineAt(node.from)
            if (node.to + 1 < line.to) out.push(taskDone.range(node.to + 1, line.to))
          }
          return
        }

        /* ---- wikilinks ------------------------------------------------ */
        if (name === 'WikiLink') {
          const raw = state.doc.sliceString(node.from, node.to)
          const inner = raw.slice(2, -2)
          const [targetPart, alias] = splitPipe(inner)
          const target = targetPart.split('#')[0].trim()
          const resolved = resolveLink(target)
          const open = node.from + 2
          const close = node.to - 2
          const active = touched(state, node.from, node.to)

          if (!active) {
            // Hide the brackets and, when there is an alias, the target too.
            out.push(hidden.range(node.from, open))
            out.push(hidden.range(close, node.to))
            if (alias !== undefined) {
              out.push(hidden.range(open, open + targetPart.length + 1))
            }
          }
          const textFrom = !active && alias !== undefined ? open + targetPart.length + 1 : open
          if (textFrom < close) {
            out.push(
              Decoration.mark({
                class: resolved ? 'cm-wikilink' : 'cm-wikilink cm-wikilink-broken',
                attributes: {
                  'data-wikilink': target,
                  'data-exists': resolved ? '1' : '0',
                  title: resolved ?? `Create "${target}"`,
                },
              }).range(textFrom, close),
            )
          }
          return
        }

        /* ---- wikilink embeds ------------------------------------------ */
        if (name === 'WikiEmbed') {
          if (touched(state, node.from, node.to)) return
          const raw = state.doc.sliceString(node.from, node.to)
          const inner = raw.slice(3, -2)
          const [targetPart, sizePart] = splitPipe(inner)
          const target = targetPart.trim()
          const width = sizePart && /^\d+$/.test(sizePart.trim()) ? Number(sizePart) : undefined
          out.push(
            Decoration.replace({
              widget: new EmbedWidget({
                path: resolveEmbed(target, ctx.path),
                label: target,
                width,
                alt: sizePart && !width ? sizePart : '',
              }),
              block: false,
            }).range(node.from, node.to),
          )
          return
        }

        /* ---- markdown images ------------------------------------------ */
        if (name === 'Image') {
          if (touched(state, node.from, node.to)) return
          const raw = state.doc.sliceString(node.from, node.to)
          const m = /^!\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]*)/.exec(raw)
          if (!m) return
          let url = m[2]
          if (url.startsWith('<') && url.endsWith('>')) url = url.slice(1, -1)
          const [clean, width] = splitWidth(url)
          const external = /^(https?|data):/i.test(clean)
          out.push(
            Decoration.replace({
              widget: new EmbedWidget({
                path: external ? undefined : resolveEmbed(decodeURI(clean), ctx.path),
                href: external ? clean : undefined,
                label: decodeURI(clean) || m[1],
                width,
                alt: m[1],
              }),
              block: false,
            }).range(node.from, node.to),
          )
          return
        }

        /* ---- inline links: hide the URL machinery --------------------- */
        if (name === 'URL' || name === 'LinkTitle') {
          const parent = node.node.parent
          if (parent && (parent.name === 'Link' || parent.name === 'Image')) {
            if (!touched(state, parent.from, parent.to)) out.push(hidden.range(node.from, node.to))
          }
          return
        }

        /* ---- generic syntax marks -------------------------------------- */
        if (MARK_NODES.has(name)) {
          const parent = node.node.parent
          const scopeFrom = parent ? parent.from : node.from
          const scopeTo = parent ? parent.to : node.to
          // Link brackets are structure: the URL they hide has to be reachable.
          const kind = name === 'LinkMark' || name === 'WikiLinkMark' ? 'structure' : 'format'
          const reveal =
            name === 'HeaderMark' || name === 'QuoteMark'
              ? lineTouched(state, scopeFrom, scopeTo, kind)
              : touched(state, scopeFrom, scopeTo, kind)
          if (reveal) return
          // A HeaderMark swallows the space that follows it, so the heading
          // text doesn't start with a stray indent once the "#" is hidden.
          let to = node.to
          if (name === 'HeaderMark' && state.doc.sliceString(to, to + 1) === ' ') to += 1
          if (name === 'QuoteMark' && state.doc.sliceString(to, to + 1) === ' ') to += 1
          if (to > node.from) out.push(hidden.range(node.from, to))
        }
      },
    })

    /*
     * Underline and highlight.
     *
     * Neither is CommonMark, so the parser knows nothing about them and they
     * are matched textually, like hashtags below. Underline is the `<u>` HTML
     * markdown passes through — the only way to write one at all — and it is
     * what the toolbar's U button produces.
     */
    for (let p = vFrom; p <= vTo; ) {
      const line = state.doc.lineAt(p)
      // A setext underline (`====`) is a heading marker, not a highlight.
      const setext = /^[=]+$/.test(line.text.trim())
      for (const [re, deco] of INLINE_EXTRAS) {
        if (deco === highlighted && setext) continue
        re.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = re.exec(line.text))) {
          const from = line.from + m.index
          const to = from + m[0].length
          if (isInsideCodeOrLink(tree.resolveInner(from + 1, 1))) continue
          if (touched(state, from, to, 'format')) continue
          const innerFrom = from + m[0].indexOf(m[1])
          out.push(hidden.range(from, innerFrom))
          out.push(deco.range(innerFrom, innerFrom + m[1].length))
          out.push(hidden.range(innerFrom + m[1].length, to))
        }
      }
      if (line.to >= vTo) break
      p = line.to + 1
    }

    /* ---- hashtags: not a markdown construct, so matched textually ---- */
    for (let p = vFrom; p <= vTo; ) {
      const line = state.doc.lineAt(p)
      TAG_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = TAG_RE.exec(line.text))) {
        const from = line.from + m.index + m[1].length
        const to = from + m[2].length
        // Skip anything the markdown parser already claimed (code, links, URLs).
        const node = tree.resolveInner(from + 1, 1)
        if (isInsideCodeOrLink(node, true)) continue
        out.push(Decoration.mark({ class: 'cm-tag', attributes: { 'data-tag': m[2].slice(1) } }).range(from, to))
      }
      if (line.to >= vTo) break
      p = line.to + 1
    }
  }

  return RangeSet.of(out, true)
}

/**
 * Is this position inside something the markdown parser has already claimed?
 *
 * `orHeading` is what separates the two textual scanners that use this. A `#`
 * inside a heading is the heading's own marker, never a hashtag, so the tag
 * scan excludes headings — but a `<u>` or `==` inside a heading is ordinary
 * formatting and has to keep working, so the inline-extras scan does not.
 */
function isInsideCodeOrLink(
  node: { name: string; parent: unknown } | null,
  orHeading = false,
): boolean {
  let n = node as { name: string; parent: unknown } | null
  let depth = 0
  while (n && depth++ < 12) {
    if (
      n.name === 'InlineCode' ||
      n.name === 'FencedCode' ||
      n.name === 'CodeBlock' ||
      n.name === 'CodeText' ||
      n.name === 'URL' ||
      n.name === 'Link' ||
      n.name === 'WikiLink' ||
      n.name === 'WikiEmbed'
    )
      return true
    if (orHeading && /^ATXHeading[1-6]$/.test(n.name)) return true
    n = n.parent as { name: string; parent: unknown } | null
  }
  return false
}

function splitPipe(s: string): [string, string | undefined] {
  const i = s.indexOf('|')
  return i < 0 ? [s, undefined] : [s.slice(0, i), s.slice(i + 1)]
}

function splitWidth(url: string): [string, number | undefined] {
  const m = /^(.*?)#w=(\d+)$/.exec(url)
  return m ? [m[1], Number(m[2])] : [url, undefined]
}

/**
 * The plugin. Decorations rebuild on document/selection/viewport changes, and
 * additionally when the vault index changes — a link that was broken becomes
 * live the moment its target note is created in another pane.
 */
export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    private lastRevision = revision.value
    private dispose: () => void

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
      this.dispose = revision.subscribe(() => {
        if (revision.value === this.lastRevision) return
        this.lastRevision = revision.value
        // Defer: we may be inside another component's render pass.
        queueMicrotask(() => {
          if (view.dom.isConnected) this.decorations = buildDecorations(view)
        })
      })
    }

    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged) {
        this.decorations = buildDecorations(u.view)
      }
    }

    destroy() {
      this.dispose()
    }
  },
  {
    decorations: (v) => v.decorations,
    // Widgets behave as single units for cursor movement and selection.
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
  },
)

/**
 * Rendered tables.
 *
 * This has to be a StateField rather than part of the plugin above: replacing a
 * range that spans line breaks is a block decoration, and CodeMirror only
 * accepts those from state, never from a view plugin. (Getting that wrong
 * doesn't degrade — it throws and takes the whole editor down.)
 *
 * Scanning the full document is fine here: tables are found from the syntax
 * tree, which is incremental, and notes are small. On a document large enough
 * that the parser hasn't finished, the unparsed tail simply shows its source
 * until parsing catches up.
 */
interface TableBlock {
  fromLine: number
  toLine: number
}

/**
 * Find GFM pipe tables by scanning lines.
 *
 * This deliberately does not use the syntax tree. @lezer/markdown drops a table
 * whose delimiter row has any trailing whitespace — a single trailing space is
 * enough — and silently reparses the whole thing as paragraph text. Trailing
 * spaces are legal GFM and turn up constantly in real files, so detection is
 * done here against the actual rules: a header row, a delimiter row with a
 * matching cell count, then any following rows that contain a pipe.
 */
function findTables(state: EditorState): TableBlock[] {
  const out: TableBlock[] = []
  const total = state.doc.lines
  let inFence = false

  for (let n = 1; n <= total; n++) {
    const line = state.doc.line(n).text

    if (/^\s{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    // A table needs a header row with a pipe and a delimiter row beneath it.
    if (!line.includes('|') || isDelimiterRow(line)) continue
    if (n + 1 > total) break
    const delim = state.doc.line(n + 1).text
    if (!isDelimiterRow(delim)) continue
    if (countCells(delim) !== countCells(line)) continue

    let end = n + 1
    while (end + 1 <= total) {
      const next = state.doc.line(end + 1).text
      if (!next.trim() || !next.includes('|')) break
      if (/^\s{0,3}(```|~~~)/.test(next)) break
      end++
    }
    out.push({ fromLine: n, toLine: end })
    n = end
  }
  return out
}

function countCells(line: string): number {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  let count = 1
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\') {
      i++
      continue
    }
    if (t[i] === '|') count++
  }
  return count
}

function buildTableDecorations(state: EditorState): DecorationSet {
  const out: Array<Range<Decoration>> = []
  const notePath = state.facet(noteContext).path

  for (const t of findTables(state)) {
    const first = state.doc.line(t.fromLine)
    const last = state.doc.line(t.toLine)
    // Caret inside the table means the user is editing it: show the source.
    if (touched(state, first.from, last.to)) continue
    out.push(
      Decoration.replace({
        widget: new TableWidget(
          state.doc.sliceString(first.from, last.to),
          first.from,
          notePath,
        ),
        block: true,
      }).range(first.from, last.to),
    )
  }
  return RangeSet.of(out, true)
}

export const tableField = StateField.define<DecorationSet>({
  create: buildTableDecorations,
  update(value, tr) {
    const focusChanged = tr.effects.some((e) => e.is(setFocused))
    if (!tr.docChanged && !tr.selection && !tr.reconfigured && !focusChanged)
      return value.map(tr.changes)
    return buildTableDecorations(tr.state)
  },
  provide: (f) => [
    EditorView.decorations.from(f),
    EditorView.atomicRanges.of((view) => view.state.field(f, false) ?? Decoration.none),
  ],
})

/** Click handling for wikilinks and hashtags rendered by the plugin. */
export const linkClicks = EditorView.domEventHandlers({
  mousedown(event) {
    const target = event.target as HTMLElement | null
    const link = target?.closest?.('[data-wikilink]') as HTMLElement | null
    if (link) {
      event.preventDefault()
      requestOpenLink(link.dataset.wikilink ?? '', link.dataset.exists === '1')
      return true
    }
    const tag = target?.closest?.('[data-tag]') as HTMLElement | null
    if (tag) {
      event.preventDefault()
      dispatchEvent(new CustomEvent('slate:open-tag', { detail: { tag: tag.dataset.tag } }))
      return true
    }
    return false
  },
})
