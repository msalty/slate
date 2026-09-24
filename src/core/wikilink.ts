/**
 * The inside of a `[[wikilink]]`, read and written in one place.
 *
 * A note can be called `C# Notes`, and until this existed nothing could link
 * to it: `[[C# Notes]]` is the note `C` and its heading `Notes`, because `#`,
 * `|` and `]` all mean something between the brackets and there was no way to
 * say that one of them did not. Renaming a note to such a name rewrote every
 * link to it into a link to somewhere else.
 *
 * So a backslash escapes the next character: `[[C\# Notes]]` is the note
 * `C# Notes`. Only a backslash in front of one of the characters that needs it
 * is read as an escape — `[[Some\Thing]]` still means `Some\Thing` — so no link
 * written before this changes meaning, and anything CommonMark renders without
 * knowing what a wikilink is still shows `C# Notes`, since `\#` is an escape
 * there too.
 *
 * Obsidian allows none of these characters in a filename and has no escape for
 * them, so it cannot link to such a note whatever is written; a note named in
 * Slate without them links the same way in both.
 *
 * Every reader and writer of the syntax comes through here: the index, the
 * editor's grammar and its live preview, table cells, excerpts, pins, the
 * rename pass, autocomplete and paste. That is the point of it. A serializer
 * that one of them did not share is how `[[C\# Notes]]` gets written and then
 * read back by something else as a link to `C`.
 */

/** A backslash, and the three characters that end or divide a target. */
const TARGET_RESERVED = /[\\#|\]]/g
/** In a heading, `#` is only text: the first one already said where it starts. */
const ANCHOR_RESERVED = /[\\|\]]/g
const ESCAPE = /\\([\\#|\]])/g

/** A note name or path, written so it survives the brackets. */
export function escapeWikiTarget(s: string): string {
  return s.replace(TARGET_RESERVED, (c) => `\\${c}`)
}

/** A heading, written so it survives the brackets. */
export function escapeWikiAnchor(s: string): string {
  return s.replace(ANCHOR_RESERVED, (c) => `\\${c}`)
}

/** What an escaped part says. A backslash in front of anything else is kept. */
export function unescapeWiki(s: string): string {
  return s.replace(ESCAPE, '$1')
}

/**
 * Everything between `[[` and `]]`, escapes included, as a regex source.
 *
 * A backslash takes the character after it whatever it is — short of a line
 * end, since a wikilink never spans one — so an escaped `]` cannot close the
 * link early.
 */
export const WIKI_INNER = String.raw`(?:\\[^\n]|[^\\\]\n])*`

/** A whole `[[…]]` or `![[…]]`. Group 1 is the `!`, group 2 the inside. */
export const WIKI_SOURCE = String.raw`(!?)\[\[(${WIKI_INNER})\]\]`

/**
 * Where the escaping backslashes in `s` are — the ones `unescapeWiki` removes,
 * and so the ones live preview hides. A backslash in front of anything else is
 * text and stays on screen.
 */
export function escapePositions(s: string): number[] {
  const at: number[] = []
  for (let i = 0; i < s.length - 1; i++) {
    if (s[i] !== '\\') continue
    if ('\\#|]'.includes(s[i + 1])) at.push(i)
    i++
  }
  return at
}

/** The first `ch` in `s` that is not escaped, or -1. */
export function findUnescaped(s: string, ch: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++
    else if (s[i] === ch) return i
  }
  return -1
}

export interface WikiParts {
  /** The note, unescaped and trimmed. Empty for `[[#Heading]]`. */
  target: string
  /** The heading after the first `#`, unescaped and trimmed, if there is one. */
  anchor?: string
  /** Display text after the first `|`, as written, trimmed. */
  alias?: string
  /** What comes before the `|`, exactly as written — for hiding it in place. */
  head: string
}

/**
 * The inside of a wikilink, taken apart.
 *
 * The first unescaped `|` ends the target and starts the display text; before
 * it, the first unescaped `#` starts the heading. A `#` after that one is part
 * of the heading — `[[Notes#C# bindings]]` — which is why a heading is escaped
 * without it.
 *
 * Display text is left as written. It never had escapes, it is the part a
 * person typed to be read, and a rename carries it across untouched.
 */
export function splitWikiInner(inner: string): WikiParts {
  const pipe = findUnescaped(inner, '|')
  const head = pipe < 0 ? inner : inner.slice(0, pipe)
  const hash = findUnescaped(head, '#')
  const anchor = hash < 0 ? undefined : unescapeWiki(head.slice(hash + 1).trim())
  return {
    target: unescapeWiki((hash < 0 ? head : head.slice(0, hash)).trim()),
    ...(anchor ? { anchor } : {}),
    ...(pipe < 0 ? {} : { alias: inner.slice(pipe + 1).trim() }),
    head,
  }
}

/** A wikilink, written so that `splitWikiInner` reads back exactly these parts. */
export function formatWikiLink(l: {
  target: string
  anchor?: string
  alias?: string
  embed?: boolean
}): string {
  const anchor = l.anchor ? `#${escapeWikiAnchor(l.anchor)}` : ''
  const alias = l.alias !== undefined ? `|${l.alias}` : ''
  return `${l.embed ? '!' : ''}[[${escapeWikiTarget(l.target)}${anchor}${alias}]]`
}
