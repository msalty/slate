/**
 * Text expansion: the phrases and addresses you type over and over.
 *
 * **The snippets are an ordinary note.** `Snippets.md` at the vault root is a
 * real markdown file holding real markdown, so a snippet is written, edited,
 * searched, versioned and synced exactly like everything else — there is no
 * snippet format to learn, no editor to build, and nothing to export. The same
 * bargain `Templates/` makes, for the same reason: the app already has a good
 * editor and it would be strange to ship a worse one inside a settings panel.
 *
 * A `##` heading is a trigger and everything under it is what the trigger
 * expands to:
 *
 * ```markdown
 * ## wiki
 * https://en.wikipedia.org/wiki/
 *
 * ## sig
 * Thanks,
 * Mike
 * ```
 *
 * One rule, so multi-line expansions cost nothing and no character has to be
 * escaped — a `|` or an em dash in a phrase would break a table or a list.
 *
 * **No sigil.** The trigger is whatever the heading says. Type `wiki` and the
 * completion offers it; name one `;wiki` and you type that instead. A leading
 * punctuation mark is a keyboard-layer switch away on a phone, which is a
 * strange toll to build into a feature whose whole purpose is typing less —
 * so the convention is yours to pick, per snippet. What keeps it from firing
 * on ordinary prose is that the list only opens when what you have typed is
 * the start of a trigger you actually wrote down.
 *
 * **And the whole thing is opt-in.** The note is never created for anybody:
 * no boot step makes it, no first note makes it, and a vault without one
 * behaves in every respect as though this file did not exist.
 */

import { computed } from '@preact/signals'
import { expandTemplate, type TemplateBody } from './templates'
import { getRaw, notes, revision } from './vault'

/** The one note snippets are read from. */
export const SNIPPETS_NOTE = 'Snippets.md'

export interface Snippet {
  /** The word typed to reach it — the heading, trimmed. */
  trigger: string
  /** What it expands to, tokens and all. */
  body: string
}

/**
 * The shortest trigger worth offering.
 *
 * A one-character trigger would put the list on screen through most of a
 * sentence, and dismissing a popup is exactly the work this feature exists to
 * save. Two is enough to be deliberate.
 */
const MIN_TRIGGER = 2

const HEADING = /^##[ \t]+(.+?)[ \t]*$/

/**
 * Split the note into snippets.
 *
 * Anything above the first `##` is prose — a title, a line about what the note
 * is for — and is skipped rather than treated as a nameless snippet. A heading
 * with nothing under it is skipped too: a trigger that expands to nothing is a
 * snippet somebody is in the middle of writing, not one to offer them.
 *
 * Later wins on a duplicate trigger, which is the rule that needs no
 * explaining when you have just pasted a second copy of one to edit.
 */
export function parseSnippets(text: string): Snippet[] {
  const found = new Map<string, string>()
  let trigger: string | undefined
  let body: string[] = []

  const flush = () => {
    if (trigger === undefined) return
    const clean = body.join('\n').replace(/^\n+/, '').replace(/\s+$/, '')
    if (clean) found.set(trigger, clean)
  }

  for (const line of text.split('\n')) {
    const m = HEADING.exec(line)
    if (m) {
      flush()
      trigger = m[1].trim()
      body = []
    } else if (trigger !== undefined) {
      body.push(line)
    }
  }
  flush()

  return [...found]
    .filter(([t]) => t.length >= MIN_TRIGGER)
    .map(([trigger, body]) => ({ trigger, body }))
}

/**
 * The snippets on offer, or an empty list when the note does not exist.
 *
 * An empty list is the "this vault does not use snippets" signal, the way an
 * empty `Templates/` is — there is no separate setting saying so.
 */
export const snippets = computed<Snippet[]>(() => {
  // Both, deliberately: the index tells this to re-run when the note is
  // created or deleted, the revision when its text changes underneath.
  notes.value
  revision.value
  const text = getRaw(SNIPPETS_NOTE)?.text
  return text ? parseSnippets(text) : []
})

export const hasSnippets = computed(() => snippets.value.length > 0)

/**
 * The snippets a half-typed word could still become, best first.
 *
 * Prefix matches only. A substring match would offer `address` to somebody
 * typing the middle of an unrelated word, and a trigger is a thing you know
 * the start of — you wrote it.
 */
export function matchSnippets(typed: string): Snippet[] {
  const q = typed.toLowerCase()
  if (q.length < MIN_TRIGGER) return []
  return snippets.value
    .filter((s) => s.trigger.toLowerCase().startsWith(q))
    .sort((a, b) => a.trigger.length - b.trigger.length || a.trigger.localeCompare(b.trigger))
}

/** What a snippet expands to now, with today's date in it and a caret. */
export function expandSnippet(s: Snippet, when = Date.now()): TemplateBody {
  // The same token vocabulary as a template — `{{date}}`, `{{time}}`,
  // `{{cursor}}` — because two placeholder languages in one app is one too
  // many. `title` has no meaning mid-note and fills in empty, which reads as
  // the typo it is rather than pasting the wrong note's name into a sentence.
  return expandTemplate(s.body, { title: '', when })
}

/** A one-line idea of what a snippet inserts, for the suggestion list. */
export function previewOf(body: string): string {
  const [first = ''] = body.split('\n')
  const more = body.includes('\n') ? '…' : ''
  return first.length > 48 ? `${first.slice(0, 47)}…` : `${first}${more}`
}
