/**
 * A search box that speaks the Tag Folder rule language.
 *
 * The rule language already exists — it is what a Tag Folder is made of — and
 * it answers the questions a plain substring search cannot: *which* notes, as
 * opposed to which *words*. `#work`, `folder:Clients`, `has:tasks`,
 * `due:overdue` are all things people want from a search box and none of them
 * are text you could ever find by typing them.
 *
 * So the box takes both, in one line, mixed in any order:
 *
 *   #work budget          notes tagged #work, searched for "budget"
 *   folder:Clients -#done invoice
 *   has:tasks roof
 *   #work OR #home        rule only, no text at all
 *
 * **The rule filters; the words still search.** Nothing about the text half
 * changes: the same scorer ranks it, the same snippets come back, the same
 * words are marked in the rows. The rule is applied on top, which is why a
 * query with no rule terms in it behaves exactly as it did before this module
 * existed — the overwhelmingly common case, and the one that must not move.
 *
 * ## Why this is a splitter and not a parser
 *
 * `tagquery` reads a bare word as a tag: `budget` parses to `#budget`, which
 * is the right reading in a field whose entire purpose is a rule and the wrong
 * one in a box people type prose into. Handing the whole query to `parseQuery`
 * would turn every ordinary search into a tag search for a tag nobody has.
 *
 * So the split happens first, on *shape* rather than on meaning: a token is a
 * rule term only when it says so out loud — a leading `#`, or one of the
 * language's own keys with a colon after it. Everything else is prose. The
 * pieces that do say so are handed back to `parseQuery` as a rule of their own,
 * so the language itself stays the only thing that decides what a rule means:
 * hierarchical tags, `AND`/`OR` precedence, the error messages and the offsets
 * they point at are all its, unchanged.
 *
 * Separate rule pieces are joined by adjacency, which the language already
 * reads as AND — `#work budget -#done` is `#work AND NOT #done`, with "budget"
 * searched for. An explicit `OR` or a parenthesised group binds the terms
 * around it into one piece, so `#work OR #home budget` filters to either tag
 * rather than quietly ANDing one of them onto the other.
 *
 * ## When the rule doesn't parse
 *
 * Half a rule is a normal thing to have on screen: `#a OR` is what `#a OR #b`
 * looks like a keystroke earlier. Rather than blank the list or search for the
 * literal text of a rule fragment, a rule that doesn't parse leaves `text` as
 * the *whole* query — the behaviour of the box before any of this — and hands
 * back the error for the caller to show. Nothing is quietly filtered by a rule
 * that isn't understood, and nothing is quietly not filtered either.
 */

import { parseQuery, type QueryNode } from './tagquery'

/** The keys `tagquery` knows, which is what makes `key:value` a rule term. */
const KEYS = ['folder', 'in', 'tag', 'has', 'is', 'due']

const KEY_TERM = new RegExp(`^(?:${KEYS.join('|')}):\\S`, 'i')

export interface SearchQuery {
  /** The prose half, for the scorer and for marking words in a row. */
  text: string
  /** The rule half, as rule source — empty when the query has no rule terms. */
  rule: string
  /** That rule, parsed. Absent when there is no rule, or it didn't parse. */
  node?: QueryNode
  /** Why the rule didn't parse, when it didn't. */
  error?: string
  /** Where in `rule` the error is, for a caret under it. */
  at?: number
}

type Kind = 'rule' | 'op' | 'text' | 'lparen' | 'rparen'

interface Tok {
  kind: Kind
  /** Only set for `op`, so a run knows AND/OR from NOT. */
  op?: 'AND' | 'OR' | 'NOT'
  from: number
  to: number
  text: string
}

/**
 * Cut the query into tokens, the way the rule language cuts one.
 *
 * Parentheses are their own tokens so a group can be recognised, and a quoted
 * value is kept whole so `folder:"Client work"` survives a split on whitespace
 * — the one place the language allows a space inside a term.
 */
function scan(src: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '(' || c === ')') {
      toks.push({
        kind: c === '(' ? 'lparen' : 'rparen',
        from: i,
        to: i + 1,
        text: c,
      })
      i++
      continue
    }
    const from = i
    let quoted = false
    while (i < src.length && (quoted || !/[\s()]/.test(src[i]))) {
      if (src[i] === '"') quoted = !quoted
      i++
    }
    const text = src.slice(from, i)
    toks.push({ kind: classify(text), op: operator(text), from, to: i, text })
  }
  return toks
}

function operator(word: string): 'AND' | 'OR' | 'NOT' | undefined {
  const upper = word.toUpperCase()
  return upper === 'AND' || upper === 'OR' || upper === 'NOT' ? upper : undefined
}

/**
 * What one word is.
 *
 * A rule term has to announce itself: `#something`, or a key the language
 * knows with a value after the colon. A leading `-` or `!` negates whatever
 * follows, and negates a rule term only — `-budget` is a word somebody typed a
 * dash in front of, not a rule about a tag called "budget".
 */
function classify(word: string): Kind {
  if (operator(word)) return 'op'
  const bare = /^[-!]/.test(word) ? word.slice(1) : word
  if (bare.startsWith('#') && bare.length > 1) return 'rule'
  if (KEY_TERM.test(bare)) return 'rule'
  return 'text'
}

/** The `)` closing the `(` at `i`, or -1 when there isn't one. */
function closing(toks: Tok[], i: number): number {
  let depth = 0
  for (let j = i; j < toks.length; j++) {
    if (toks[j].kind === 'lparen') depth++
    else if (toks[j].kind === 'rparen' && --depth === 0) return j
  }
  return -1
}

/**
 * Is the token at `j` a negation of whatever comes next?
 *
 * `NOT` is a word and arrives as an operator. `-` and `!` usually arrive
 * *inside* the word they negate — `-#done` is one token, and `classify`
 * already strips the mark to read it — but in front of a bracket they cannot,
 * because a bracket ends a word. So `-(#work OR #home)` scanned as a bare `-`
 * and a group, the dash was classified as ordinary text, and the rule came out
 * as the *positive* group with a `-` searched for beside it: a filter quietly
 * meaning the opposite of what was typed.
 *
 * Only when it is glued to what it negates. `budget - #work` is prose with a
 * dash in it, and a space is the whole difference between a negation and a
 * hyphen somebody typed.
 */
function negates(toks: Tok[], j: number): boolean {
  const t = toks[j]
  if (!t) return false
  if (t.op === 'NOT') return true
  if (t.kind !== 'text' || (t.text !== '-' && t.text !== '!')) return false
  return toks[j + 1]?.from === t.to
}

/**
 * The token after the rule unit starting at `i`, or -1 if none starts there.
 *
 * A unit is a rule term or a parenthesised group, either one behind as many
 * negations as were typed. A group counts only when everything inside it is
 * rule material and at least one of those is an actual term — `(budget OR tax)`
 * is two words in brackets, and treating it as a rule would be reading a wish
 * into it.
 */
function unitEnd(toks: Tok[], i: number): number {
  let j = i
  while (negates(toks, j)) j++
  const t = toks[j]
  if (!t) return -1
  if (t.kind === 'rule') return j + 1
  if (t.kind !== 'lparen') return -1

  const close = closing(toks, j)
  if (close < 0) return -1
  const inner = toks.slice(j + 1, close)
  if (!inner.some((x) => x.kind === 'rule')) return -1
  if (!inner.every((x) => x.kind !== 'text')) return -1
  return close + 1
}

/**
 * Pull the rule terms out of a search query, leaving the prose behind.
 *
 * Both halves come back whatever the query looks like: a query of pure prose
 * has no rule, a query of pure rule has no text, and one with neither is two
 * empty strings.
 */
export function parseSearch(src: string): SearchQuery {
  const toks = scan(src)
  const pieces: string[] = []
  /** The source ranges the rule took, so the text half is what is left of it. */
  const taken: Array<[number, number]> = []

  let i = 0
  while (i < toks.length) {
    const end = unitEnd(toks, i)
    if (end < 0) {
      i++
      continue
    }
    /*
     * Extend the piece across an explicit AND/OR joining it to another unit.
     * Adjacency needs no extending — two pieces side by side are ANDed when
     * they are put back together — but an operator left stranded at the end of
     * a piece would be a rule that cannot parse.
     */
    let run = end
    for (;;) {
      const op = toks[run]
      if (!op || op.kind !== 'op' || op.op === 'NOT') break
      const next = unitEnd(toks, run + 1)
      if (next < 0) break
      run = next
    }
    pieces.push(src.slice(toks[i].from, toks[run - 1].to))
    taken.push([toks[i].from, toks[run - 1].to])
    i = run

    /*
     * An AND or OR at the very end of the box, directly behind the rule, is
     * the keystroke before its right-hand side rather than a word to search
     * for: `#work OR` is what `#work OR #home` looks like a moment earlier.
     * Dropped rather than searched for, because searching for the letters "or"
     * matches most of the vault and the rule is what the line is about. It
     * only applies behind a rule — `budget or` is two ordinary words.
     */
    const trailing = toks[i]
    if (trailing?.kind === 'op' && trailing.op !== 'NOT' && i === toks.length - 1) {
      taken.push([trailing.from, trailing.to])
      i++
    }
  }

  /*
   * Cut out of the source rather than rebuilt from the words that were left,
   * so everything the rule did not take comes through exactly as typed —
   * brackets and all. Rebuilding it token by token turned a search for
   * "budget (2024)" into three terms, one of which was an open bracket.
   */
  let text = src
  for (const [from, to] of taken) {
    text = text.slice(0, from) + ' '.repeat(to - from) + text.slice(to)
  }
  text = text.replace(/\s+/g, ' ').trim()
  const rule = pieces.join(' ')
  if (!rule) return { text, rule: '' }

  const parsed = parseQuery(rule)
  if (!parsed.node) {
    // The rule is not understood, so nothing is filtered by it and the query
    // is read the way it was read before any of this: as text.
    return { text: src.trim(), rule, error: parsed.error, at: parsed.at }
  }
  return { text, rule, node: parsed.node }
}
