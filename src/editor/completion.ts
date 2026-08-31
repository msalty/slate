/**
 * Autocomplete for `[[wikilinks]]`, `![[embeds]]` and `#tags`.
 *
 * Linking is only as good as how fast you can reach for it, so the completion
 * fires on the opening `[[` with no keystroke delay and ranks by how the note
 * was most likely to be recalled: exact title, then prefix, then substring,
 * then recency.
 */

import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import { allTags, attachments, notes } from '../core/vault'
import { basename, mediaClass, relativeTime } from '../core/util'

function rank(title: string, q: string, mtime: number): number {
  const t = title.toLowerCase()
  let score = 0
  if (!q) score = 1
  else if (t === q) score = 1000
  else if (t.startsWith(q)) score = 500 - t.length
  else if (t.includes(q)) score = 200 - t.indexOf(q)
  else {
    // Initials match: "mn" finds "Meeting Notes".
    const initials = title
      .split(/[\s/_-]+/)
      .map((w) => w[0]?.toLowerCase() ?? '')
      .join('')
    if (initials.startsWith(q)) score = 120
    else return -1
  }
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
    validFor: /^[^\]\n|]*$/,
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

export function noteCompletionInfo(mtime: number): string {
  return relativeTime(mtime)
}

/** CodeMirror expects boosts in -99..99; our raw scores run much higher. */
function clampBoost(score: number): number {
  return Math.max(-99, Math.min(99, Math.round(score / 10)))
}
