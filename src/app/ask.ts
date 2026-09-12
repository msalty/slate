/**
 * Running one turn of a conversation: terms, search, answer.
 *
 * The seam between the vault's index and the model. The prompts and the note
 * format are pure and live in `core/ask.ts`; this is the part that reads files
 * and makes requests.
 */

import { streamText } from '../adapters/llm'
import { isConfigured, LlmError } from '../core/llm'
import {
  ALL,
  answerSystem,
  citedWithoutReading,
  isDerived,
  newConversation,
  noteScope,
  answerUser,
  historyFor,
  parseTerms,
  pinsOf,
  readTurns,
  sourceDescription,
  termsSystem,
  termsUser,
  type AskSource,
  type NoteScope,
  type Provenance,
} from '../core/ask'
import { notesMatching } from '../core/folders'
import { parseFrontmatter } from '../core/markdown'
import { settings } from '../core/settings'
import { estimateTokens } from '../core/summary'
import { parseQuery } from '../core/tagquery'
import { backlinkMap, createNote, getEntry, getText, resolveLink, search } from '../core/vault'
import type { NoteIndexEntry } from '../core/types'

/** Is there anywhere to send a question? The composer is absent without one. */
export function canAsk(): boolean {
  return isConfigured(settings.value.ai)
}

/**
 * Start a conversation, and hand back the path of the note it lives in.
 *
 * The first question is not asked here. The note is created, opened, and the
 * question goes in the composer — so the first turn runs through exactly the
 * same path as the twentieth, and there is one code path to get wrong instead
 * of two.
 */
export async function startConversation(
  source: string,
  firstQuestion: string,
  pins: string[] = [],
): Promise<string> {
  const { title, text } = newConversation({ question: firstQuestion, source, pins })
  return createNote(settings.value.generatedFolder, title, text)
}

export interface TurnResult {
  answer: string
  provenance: Provenance
}

export interface TurnOptions {
  /** Progress for the composer: what is happening right now, in words. */
  onStatus?: (text: string) => void
  /** The answer as it is written. */
  onChunk?: (text: string) => void
  signal?: AbortSignal
  /**
   * Search for these instead of asking the model what to look for.
   *
   * What "redo this, but search for something else" passes in. It skips the
   * first request entirely, which is the point: when the callout shows the
   * search was the weak link, spending another request asking the same model
   * for the same wrong terms is the one thing that cannot help.
   */
  terms?: string[]
}

/**
 * The set of notes a conversation is allowed to see.
 *
 * `all` is the whole vault; `note:` and `links:` name one note and its
 * neighbourhood; anything else is a Tag Folder rule, evaluated by the same
 * parser that powers Tag Folders. A Tag Folder rule that no longer parses —
 * somebody edited the frontmatter and got it slightly wrong — falls back to the
 * whole vault rather than silently answering from nothing, which is the failure
 * that would look like the feature being broken.
 */
export function scopedNotes(source: string): NoteIndexEntry[] | undefined {
  if (!source || source === ALL) return undefined
  const ns = noteScope(source)
  /*
   * A note scope that names a note the vault no longer has returns *nothing*,
   * not everything. The fallback above is right for a rule somebody mistyped —
   * a Tag Folder rule that will not parse is a syntax error, and answering from
   * the whole vault is the least surprising thing to do with one. A scope
   * naming a missing note is not a syntax error, and widening it to the vault
   * would be the exact surprise this rule exists to remove.
   */
  if (ns) return notesAround(ns)
  const parsed = parseQuery(source)
  if (!parsed.node) return undefined
  return notesMatching(parsed.node)
}

/** The note a scope names, and — for `links:` — everything one hop from it. */
function notesAround(ns: NoteScope): NoteIndexEntry[] {
  const path = resolveLink(ns.title)
  const entry = path ? getEntry(path) : undefined
  if (!entry) return []
  const out = [entry]
  if (ns.kind === 'note') return out

  const seen = new Set([entry.path])
  const add = (p: string | undefined) => {
    const e = p ? getEntry(p) : undefined
    if (!e || seen.has(e.path)) return
    seen.add(e.path)
    out.push(e)
  }
  // Out, then in. `entry.links` is what this note points at (embeds excluded,
  // so an image it shows is not a note it links to); the backlink map is
  // everything pointing back.
  for (const target of entry.links) add(resolveLink(target))
  for (const from of backlinkMap.value.get(entry.path) ?? []) add(from)
  return out
}

/**
 * Has the search anywhere to look, once the pins are accounted for?
 *
 * False when the scope holds nothing the pins are not already sending — which
 * is "ask about this note" narrowed to `note:`, where the note is pinned and is
 * the whole of what may be read. Two things hang off it: a turn in that state
 * does not spend a request asking a model what to search for, and the composer
 * does not offer a Redo whose whole promise is "searching for something else".
 *
 * Exported so those two agree by construction. A chip that offered a search the
 * turn would not run is the same class of lie as a callout that under-reports.
 */
export function searchesAnything(source: string, pinnedTitles: string[], self: string): boolean {
  const allowed = scopedNotes(source)
  if (!allowed) return true
  const pinned = new Set(resolvePins(pinnedTitles, self).entries.map((e) => e.path))
  return allowed.some((e) => !pinned.has(e.path))
}

/**
 * Search within the scope, most relevant first.
 *
 * Each term is searched separately and the results merged rather than searched
 * as one query: `search()` requires *every* term to be present, which is right
 * for a search box and wrong here — a note about the rollback and a note about
 * the index rebuild are both worth reading, and demanding both words appear in
 * one note finds neither.
 */
function findNotes(
  terms: string[],
  allowed: NoteIndexEntry[] | undefined,
  self: string,
  already: Set<string>,
): NoteIndexEntry[] {
  const permitted = allowed && new Set(allowed.map((n) => n.path))

  const best = new Map<string, { entry: NoteIndexEntry; score: number }>()
  for (const term of terms) {
    for (const hit of search(term, 40)) {
      if (permitted && !permitted.has(hit.entry.path)) continue
      // A pinned note is already going; finding it again would cost a slot and
      // send it twice, and would make the match count read higher than the
      // search actually earned.
      if (already.has(hit.entry.path)) continue
      // Never this conversation, and never anything the app wrote. A
      // conversation is the strongest keyword match for its own questions, so
      // without this it reads itself back and gets more confident every turn.
      if (hit.entry.path === self) continue
      const text = getText(hit.entry.path)
      if (text === undefined || isDerived(text)) continue
      const prev = best.get(hit.entry.path)
      // A note found by two different terms is more likely the one wanted than
      // one found by a single term very well, so the scores add.
      if (prev) prev.score += hit.score
      else best.set(hit.entry.path, { entry: hit.entry, score: hit.score })
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).map((h) => h.entry)
}

export interface ResolvedPins {
  /** In the order they were pinned — the order they will be sent in. */
  entries: NoteIndexEntry[]
  /** Named in the frontmatter, resolving to nothing. */
  missing: string[]
}

/**
 * Turn the titles in `include:` into notes.
 *
 * Unlike search, this does not apply the scope: a pin is an explicit
 * instruction, and silently refusing one because it sits outside `source:`
 * would be exactly the quiet failure the callout exists to prevent. It does not
 * apply `isDerived` either, for the same reason — the rule that keeps generated
 * notes out of *retrieval* is about what the search may reach for on its own,
 * not about what you may hand it deliberately.
 *
 * The conversation itself is the one thing that cannot be pinned. A note that
 * cites itself gets more confident every turn, and somebody who pinned the
 * conversation they were sitting in would have built that loop by accident.
 */
export function resolvePins(titles: string[], self: string): ResolvedPins {
  const entries: NoteIndexEntry[] = []
  const missing: string[] = []
  const seen = new Set<string>([self])
  for (const title of titles) {
    const path = resolveLink(title)
    const entry = path && getEntry(path)
    if (!entry) {
      missing.push(title)
      continue
    }
    if (seen.has(entry.path)) continue
    seen.add(entry.path)
    entries.push(entry)
  }
  return { entries, missing }
}

/** A gathered note, carrying the path so the caller can tell pins from hits. */
type Gathered = AskSource & { path: string }

/** Fill the budget with whole notes, best first. */
function gather(
  found: NoteIndexEntry[],
  budgetTokens: number,
  limit: number,
): { sources: Gathered[]; tokens: number } {
  // Room for the instructions, the conversation so far and the answer itself.
  const room = Math.max(500, Math.floor(budgetTokens * 0.6))
  const sources: Gathered[] = []
  let tokens = 0
  for (const entry of found.slice(0, limit)) {
    const text = getText(entry.path)
    if (text === undefined) continue
    const body = text.slice(parseFrontmatter(text).bodyStart).trim()
    if (!body) continue
    const cost = estimateTokens(body) + 8
    if (sources.length && tokens + cost > room) break
    sources.push({ title: entry.title, body, path: entry.path })
    tokens += cost
  }
  return { sources, tokens }
}

/**
 * Ask one question.
 *
 * Two requests: what to search for, then the answer. The first is small enough
 * that it is not worth streaming and short enough that a slow local model is
 * still bearable; the second streams into the note.
 */
export async function askTurn(
  question: string,
  noteText: string,
  source: string,
  selfPath: string,
  opts: TurnOptions = {},
): Promise<TurnResult> {
  const ai = settings.value.ai
  const limit = Math.max(1, ai.notesPerQuestion || 6)
  const history = historyFor(readTurns(noteText))
  const pins = resolvePins(pinsOf(noteText), selfPath)
  const pinnedPaths = new Set(pins.entries.map((e) => e.path))
  const allowed = scopedNotes(source)

  /*
   * A scope holding nothing the pins are not already sending has no search to
   * do. That is "ask about this note" scoped to the note alone: the note is
   * pinned, the searchable set is that same note, and asking a model what to
   * look for would be a whole request spent choosing terms for a search over
   * nothing. It saves the round trip and, more to the point, stops the callout
   * reporting a search that never had anywhere to look.
   *
   * The same test the composer uses to decide whether to offer Redo, computed
   * from the scope already resolved here rather than by calling it again.
   */
  const nothingToSearch = !!allowed && !allowed.some((e) => !pinnedPaths.has(e.path))

  let terms = opts.terms?.filter((t) => t.trim()) ?? []
  if (!terms.length && !nothingToSearch) {
    opts.onStatus?.('Working out what to look for…')
    const termReply = await streamText(ai, termsSystem(), termsUser(question, history), {
      signal: opts.signal,
    })
    terms = parseTerms(termReply)
    if (!terms.length) throw new LlmError('The model did not suggest anything to search for.')
  }

  if (terms.length) opts.onStatus?.(`Searching ${terms.map((t) => `“${t}”`).join(', ')}…`)
  const found = nothingToSearch ? [] : findNotes(terms, allowed, selfPath, pinnedPaths)
  /*
   * Pins first, so that when the limit or the budget runs out it is the weakest
   * search hit that goes rather than the note you asked for by name — and so
   * that they sit at the top of the material, where a model reading a long
   * prompt is most likely to use them.
   */
  const { sources, tokens } = gather([...pins.entries, ...found], ai.contextTokens, limit)

  const sentPaths = new Set(sources.map((s) => s.path))
  const pinsSent = pins.entries.filter((e) => sentPaths.has(e.path))

  opts.onStatus?.(
    sources.length
      ? `Reading ${sources.length} ${sources.length === 1 ? 'note' : 'notes'}…`
      : 'Nothing matched — answering anyway…',
  )

  const answer = await streamText(
    ai,
    answerSystem(sourceDescription(source), pinsSent.length),
    answerUser(question, sources, history),
    { signal: opts.signal, onChunk: opts.onChunk },
  )

  /*
   * `matched` stays what the *search* found, so the number keeps meaning what
   * it has always meant: how well the search did. Pins are not a search result
   * and counting them here would flatter it. They do count against the limit,
   * though, which is why the two below are measured over the whole candidate
   * list rather than over `found` alone.
   */
  const candidates = pins.entries.length + found.length
  /*
   * Checked rather than trusted. The instruction says never to invent a note
   * title; this is the only thing that finds out whether it was obeyed, and it
   * costs one scan of text already in hand.
   */
  const unread = citedWithoutReading(answer, sources.map((s) => s.title))
  return {
    answer: answer.trim(),
    provenance: {
      terms,
      matched: found.length,
      read: sources.map((s) => s.title),
      tokens,
      dropped: Math.max(0, Math.min(candidates, limit) - sources.length),
      beyondLimit: Math.max(0, candidates - limit),
      limit,
      pinned: pinsSent.map((e) => e.title),
      missingPins: pins.missing,
      pinsSkipped: pins.entries.length - pinsSent.length,
      citedNotRead: unread.filter((t) => !!resolveLink(t)),
      citedNotFound: unread.filter((t) => !resolveLink(t)),
    },
  }
}
