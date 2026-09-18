/**
 * Autocomplete for `[[wikilinks]]`, `![[embeds]]`, `#tags`, callout types and
 * text snippets.
 *
 * Linking is only as good as how fast you can reach for it, so the completion
 * fires on the opening `[[` with no keystroke delay and ranks by how the note
 * was most likely to be recalled: exact title, then prefix, then substring,
 * then recency.
 */

import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import { allTags, attachments, getText, notes, resolveLink } from '../core/vault'
import { expandSnippet, matchSnippets, previewOf, type Snippet } from '../core/snippets'
import { scanHeadings } from '../core/markdown'
import { basename, mediaClass, relativeTime } from '../core/util'
import { CALLOUT_NAMES, calloutSpec } from './callout'

/**
 * Exact, then prefix, then substring, then initials — and lately-touched first
 * among equals.
 *
 * `mtime` is optional because recency is a sensible tiebreak between two notes
 * and no question at all about two headings *inside* one: they were written
 * whenever the note was, and what orders them is where they sit in it.
 */
function rank(title: string, q: string, mtime?: number): number {
  const t = title.toLowerCase()
  let score = 0
  if (!q) score = 1
  else if (t === q) score = 1000
  else if (t.startsWith(q)) score = 500 - t.length
  else if (t.includes(q)) score = 200 - t.indexOf(q)
  else {
    // Initials match: "mn" finds "Meeting Notes", "fc" finds "Flight costs".
    const initials = title
      .split(/[\s/_-]+/)
      .map((w) => w[0]?.toLowerCase() ?? '')
      .join('')
    if (initials.startsWith(q)) score = 120
    else return -1
  }
  if (mtime === undefined) return score
  return score + Math.max(0, 40 - (Date.now() - mtime) / (86_400_000 * 7))
}

/**
 * Insert a completed target and close the link.
 *
 * `closeBrackets` may already have auto-inserted the `]]` when the user typed
 * `[[`, so anything the completion adds has to absorb it — otherwise accepting
 * a suggestion leaves `[[Note]]]]` behind.
 */
function applyTarget(text: string) {
  return (view: EditorView, _c: Completion, from: number, to: number) => {
    const after = view.state.doc.sliceString(to, to + 2)
    const end = after === ']]' ? to + 2 : to
    view.dispatch({
      changes: { from, to: end, insert: `${text}]]` },
      selection: { anchor: from + text.length + 2 },
      userEvent: 'input.complete',
    })
  }
}

/**
 * The headings of whichever note a `[[…#` names, as completions.
 *
 * Two notes it can be asking about, and they are read from different places on
 * purpose. `[[#` is *this* note, so its headings come off the buffer — the
 * heading you typed a moment ago is offerable before it has been saved, which
 * is exactly when you want to link to it. `[[Trip#` is another note, so its
 * headings come off the vault, which is the only copy of it there is.
 *
 * `detail` carries the heading this one sits under rather than its level. The
 * completion list cannot indent, and "H3" says less about where you are going
 * than the name of the section above it.
 */
function headingOptions(context: CompletionContext, target: string, q: string): Completion[] {
  const text = target
    ? (() => {
        const path = resolveLink(target)
        return path ? getText(path) : undefined
      })()
    : context.state.doc.toString()
  if (!text) return []

  const headings = scanHeadings(text)
  const options: Completion[] = []
  /** The nearest heading above this one that outranks it. */
  const parentOf = (i: number): string | undefined => {
    for (let j = i - 1; j >= 0; j--) if (headings[j].level < headings[i].level) return headings[j].text
    return undefined
  }
  headings.forEach((h, i) => {
    const s = rank(h.text, q)
    if (s < 0) return
    /*
     * Document order, inside the -99..99 that boosts have to live in.
     *
     * `clampBoost` divides by ten and rounds, which is right for note scores
     * running into the thousands and fatal here: every heading in an unfiltered
     * `[[Trip#` ranks the same, the fractional tiebreak rounded away, and
     * CodeMirror fell back to sorting the labels alphabetically. An outline
     * read in alphabetical order is not an outline.
     *
     * So the tier is expressed directly, twenty apart, and position contributes
     * at most nineteen — enough to order the top of any note, never enough to
     * lift a worse match above a better one. Past the twentieth heading the
     * positions tie, which only matters for a query that matched half a long
     * note.
     */
    const tier = s >= 1000 ? 60 : s >= 400 ? 40 : s >= 100 ? 20 : 0
    options.push({
      label: h.text,
      detail: parentOf(i),
      boost: Math.min(99, tier + Math.max(0, 19 - i)),
      /*
       * Only the heading is inserted, never the target with it. The list is
       * anchored after the `#` — which is what lets the completion filter on
       * the heading as it is typed — and it leaves the note half exactly as it
       * was written, case, spacing and all.
       */
      apply: applyTarget(h.text),
    })
  })
  return options
}

export function wikiCompletion(context: CompletionContext): CompletionResult | null {
  // Match an unclosed [[ or ![[ on the current line.
  const before = context.matchBefore(/!?\[\[[^\]\n]*/)
  if (!before) return null
  const isEmbed = before.text.startsWith('!')
  const typed = before.text.slice(isEmbed ? 3 : 2)
  // Once the user has typed a pipe they are writing an alias, not a target.
  if (typed.includes('|')) return null
  const q = typed.toLowerCase()
  const from = before.from + (isEmbed ? 3 : 2)

  /*
   * A `#` says the note has been named and a place in it is being named now —
   * the same statement the `|` above makes about the alias, and answered the
   * same way: the list stops being about notes and becomes about headings.
   *
   * Links only. `![[Note#Heading]]` does not embed a section — that is a
   * different feature and not one that exists — so offering the headings there
   * would be completing somebody into an embed that resolves to nothing.
   */
  const hash = typed.indexOf('#')
  if (hash >= 0) {
    if (isEmbed) return null
    const target = typed.slice(0, hash).trim()
    const options = headingOptions(context, target, typed.slice(hash + 1).toLowerCase())
    if (!options.length) return null
    return { from: from + hash + 1, options: options.slice(0, 60), validFor: /^[^\]\n|]*$/ }
  }

  const options: Completion[] = []

  if (isEmbed) {
    // Embeds usually mean attachments, so those come first.
    for (const a of attachments.value) {
      const name = basename(a.path)
      const s = rank(name, q, a.mtime)
      if (s < 0) continue
      options.push({
        label: name,
        detail: mediaClass(a.path),
        apply: applyTarget(a.path),
        boost: clampBoost(s),
      })
    }
  }

  let hasPrefixMatch = false
  for (const n of notes.value) {
    const s = rank(n.title, q, n.mtime)
    if (s < 0) continue
    if (q && n.title.toLowerCase().startsWith(q)) hasPrefixMatch = true
    options.push({
      label: n.title,
      detail: n.folder || undefined,
      info: n.excerpt || undefined,
      apply: applyTarget(n.title),
      boost: clampBoost(isEmbed ? s / 2 : s),
    })
  }

  // Offer to create a note that doesn't exist yet — the fastest way to outline
  // first and fill in later.
  //
  // It is suppressed whenever an existing note already starts with what was
  // typed. Otherwise typing "[[Lisbon" while a note called "Lisbon Trip"
  // exists would put an exact-label "Lisbon" candidate at the top of the list,
  // and pressing Enter would create a duplicate stub instead of linking.
  if (typed.trim() && !hasPrefixMatch && !notes.value.some((n) => n.title.toLowerCase() === q)) {
    options.push({
      label: typed.trim(),
      detail: 'Create new note',
      apply: applyTarget(typed.trim()),
      boost: -99,
    })
  }

  return {
    from,
    options: options.slice(0, 60),
    /*
     * `#` deliberately invalidates this result.
     *
     * While a result is valid CodeMirror re-filters it in place rather than
     * asking the source again — so with `#` allowed here, typing it kept the
     * *note* list alive and quietly filtered it down to nothing. The headings
     * branch above never ran, and `[[Trip#` showed an empty list.
     */
    validFor: /^[^\]\n|#]*$/,
  }
}

/**
 * Text snippets: a trigger you wrote in `Snippets.md`, and what it stands for.
 *
 * The only completion here with no opening character of its own, which is the
 * whole point — a sigil is a keyboard-layer switch away on a phone, a strange
 * toll to build into the feature whose job is typing less.
 *
 * One rule holds it together: **what has been typed since the last space must
 * be the start of a trigger.** A vault with no snippets never sees a list, a
 * vault with three sees one for three words, and everything that would
 * otherwise need a special case falls out of it —
 *
 *   - `[[wik`, `![[wik` and `#wik` are a note, a file and a tag being named.
 *     The run includes the marker, no trigger begins with one, so this source
 *     stays out of a list it has no business in.
 *   - `design` is not `sig`. The run is the whole word, not its tail.
 *   - `;sig` reaches a snippet named `;sig`, for anyone who wants their
 *     triggers to look like triggers. The sigil is part of the name, not a
 *     syntax this has to know about.
 *
 * The cost of the same rule is that punctuation glued to the front — `("wiki`
 * — is part of the run and so matches nothing. That is the right way round: a
 * trigger is a thing you type on its own, and the alternative is a list of
 * characters to treat as invisible, which is where the special cases come back.
 */
export function snippetCompletion(context: CompletionContext): CompletionResult | null {
  const before = context.matchBefore(/\S+/)
  if (!before) return null

  const hits = matchSnippets(before.text)
  if (!hits.length) return null

  return {
    from: before.from,
    options: hits.map((s) => ({
      label: s.trigger,
      detail: previewOf(s.body),
      apply: applySnippet(s),
      // Above a note or a tag that happens to share the name: those are things
      // the vault has, this is a rule you wrote down, and the rule is meant.
      boost: 40,
    })),
    validFor: /^\S*$/,
  }
}

/**
 * Swap the trigger for the text, and put the caret where the snippet says.
 *
 * `{{cursor}}` is honoured mid-note exactly as it is in a new note from a
 * template — a snippet that expands to a mail header wants the caret on the
 * empty line under it, not at the end of the block.
 */
function applySnippet(s: Snippet) {
  return (view: EditorView, _c: Completion, from: number, to: number) => {
    const { text, caret } = expandSnippet(s)
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + caret },
      userEvent: 'input.complete',
    })
  }
}

export function tagCompletion(context: CompletionContext): CompletionResult | null {
  const before = context.matchBefore(/#[A-Za-z0-9_][A-Za-z0-9/_-]*/)
  if (!before) return null
  if (before.from > 0) {
    const prev = context.state.doc.sliceString(before.from - 1, before.from)
    // A "#" at the start of a line is a heading, not a tag.
    if (!/[\s(>]/.test(prev)) return null
  } else return null

  const q = before.text.slice(1).toLowerCase()
  return {
    from: before.from + 1,
    options: allTags.value
      .filter((t) => t.tag.toLowerCase().includes(q))
      .slice(0, 40)
      .map((t) => ({ label: t.tag, detail: `${t.count}` })),
    validFor: /^[A-Za-z0-9/_-]*$/,
  }
}

/**
 * The callout types, offered as soon as `[!` is typed at the head of a quote.
 *
 * This is the whole discovery story for callouts, and it is deliberately here
 * rather than on the formatting bar: the bar exists only in rich text, while
 * the completion works in all three modes — and it puts the list where the
 * syntax is being written instead of asking anyone to go looking for a button.
 *
 * The `detail` column names the colour family an alias lands in, so the five
 * colours behind two dozen names are visible rather than a surprise.
 */
export function calloutCompletion(context: CompletionContext): CompletionResult | null {
  const before = context.matchBefore(/\[![A-Za-z]*/)
  if (!before) return null
  // Only at the head of a blockquote: quote markers in front of it and nothing
  // else. Anywhere further into the line it is ordinary text in brackets.
  const line = context.state.doc.lineAt(before.from)
  if (!/^(?:[ \t]*>)+[ \t]*$/.test(line.text.slice(0, before.from - line.from))) return null

  const q = before.text.slice(2).toLowerCase()
  const options: Completion[] = []
  for (const name of CALLOUT_NAMES) {
    if (q && !name.startsWith(q)) continue
    const spec = calloutSpec(name)!
    options.push({
      label: name,
      // Canonical types are their own family; saying so twice is noise.
      detail: spec.kind === name ? undefined : spec.kind,
      apply: applyCallout(name),
    })
  }
  if (!options.length) return null
  return { from: before.from + 2, options, validFor: /^[A-Za-z]*$/ }
}

/**
 * Finish the marker and leave the caret where the title goes.
 *
 * `closeBrackets` has very likely auto-inserted the `]` already — typing `[`
 * does that — so the completion has to absorb it or accepting a suggestion
 * leaves `[!note]]` behind, which is not a callout at all.
 */
function applyCallout(name: string) {
  return (view: EditorView, _c: Completion, from: number, to: number) => {
    const end = view.state.doc.sliceString(to, to + 1) === ']' ? to + 1 : to
    const insert = `${name}] `
    view.dispatch({
      changes: { from, to: end, insert },
      selection: { anchor: from + insert.length },
      userEvent: 'input.complete',
    })
  }
}

export function noteCompletionInfo(mtime: number): string {
  return relativeTime(mtime)
}

/** CodeMirror expects boosts in -99..99; our raw scores run much higher. */
function clampBoost(score: number): number {
  return Math.max(-99, Math.min(99, Math.round(score / 10)))
}
