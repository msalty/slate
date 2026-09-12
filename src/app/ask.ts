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
  isDerived,
  newConversation,
  answerUser,
  historyFor,
  parseTerms,
  readTurns,
  sourceLabel,
  termsSystem,
  termsUser,
  type AskSource,
  type Provenance,
} from '../core/ask'
import { notesMatching } from '../core/folders'
import { parseFrontmatter } from '../core/markdown'
import { settings } from '../core/settings'
import { estimateTokens } from '../core/summary'
import { parseQuery } from '../core/tagquery'
import { createNote, getText, search } from '../core/vault'
import type { NoteIndexEntry } from '../core/types'

/** How many notes one question may be answered from, however much room there is. */
export const MAX_NOTES = 6

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
export async function startConversation(source: string, firstQuestion: string): Promise<string> {
  const { title, text } = newConversation({ question: firstQuestion, source })
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
}

/**
 * The set of notes a conversation is allowed to see.
 *
 * `all` is the whole vault; anything else is a Tag Folder rule, evaluated by the
 * same parser that powers Tag Folders. A rule that no longer parses — somebody
 * edited the frontmatter and got it slightly wrong — falls back to the whole
 * vault rather than silently answering from nothing, which is the failure that
 * would look like the feature being broken.
 */
export function scopedNotes(source: string): NoteIndexEntry[] | undefined {
  if (!source || source === ALL) return undefined
  const parsed = parseQuery(source)
  if (!parsed.node) return undefined
  return notesMatching(parsed.node)
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
function findNotes(terms: string[], source: string, self: string): NoteIndexEntry[] {
  const allowed = scopedNotes(source)
  const permitted = allowed && new Set(allowed.map((n) => n.path))

  const best = new Map<string, { entry: NoteIndexEntry; score: number }>()
  for (const term of terms) {
    for (const hit of search(term, 40)) {
      if (permitted && !permitted.has(hit.entry.path)) continue
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

/** Fill the budget with whole notes, best first. */
function gather(found: NoteIndexEntry[], budgetTokens: number): { sources: AskSource[]; tokens: number } {
  // Room for the instructions, the conversation so far and the answer itself.
  const room = Math.max(500, Math.floor(budgetTokens * 0.6))
  const sources: AskSource[] = []
  let tokens = 0
  for (const entry of found.slice(0, MAX_NOTES)) {
    const text = getText(entry.path)
    if (text === undefined) continue
    const body = text.slice(parseFrontmatter(text).bodyStart).trim()
    if (!body) continue
    const cost = estimateTokens(body) + 8
    if (sources.length && tokens + cost > room) break
    sources.push({ title: entry.title, body })
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
  const history = historyFor(readTurns(noteText))

  opts.onStatus?.('Working out what to look for…')
  const termReply = await streamText(ai, termsSystem(), termsUser(question, history), {
    signal: opts.signal,
  })
  const terms = parseTerms(termReply)
  if (!terms.length) throw new LlmError('The model did not suggest anything to search for.')

  opts.onStatus?.(`Searching ${terms.map((t) => `“${t}”`).join(', ')}…`)
  const found = findNotes(terms, source, selfPath)
  const { sources, tokens } = gather(found, ai.contextTokens)

  opts.onStatus?.(
    sources.length
      ? `Reading ${sources.length} ${sources.length === 1 ? 'note' : 'notes'}…`
      : 'Nothing matched — answering anyway…',
  )

  const answer = await streamText(
    ai,
    answerSystem(sourceLabel(source)),
    answerUser(question, sources, history),
    { signal: opts.signal, onChunk: opts.onChunk },
  )

  return {
    answer: answer.trim(),
    provenance: {
      terms,
      matched: found.length,
      read: sources.map((s) => s.title),
      tokens,
      dropped: Math.max(0, Math.min(found.length, MAX_NOTES) - sources.length),
    },
  }
}
