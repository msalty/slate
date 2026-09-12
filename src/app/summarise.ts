/**
 * Running a summary: the vault, the plan and the model, joined up.
 *
 * The pure half — what to send, in how many passes, and what the resulting note
 * looks like — is `core/summary.ts`. This is the part that reads files, makes
 * requests in order and reports progress, so it is the part that cannot be
 * tested by calling it.
 */

import { streamText } from '../adapters/llm'
import { LlmError, modelFor, presetFor, unfence } from '../core/llm'
import {
  batchUser,
  combineSystem,
  combineUser,
  planSummary,
  sourceFor,
  summaryNote,
  summarySystem,
  type Plan,
  type SummarySource,
} from '../core/summary'
import { settings } from '../core/settings'
import { createNote, getText } from '../core/vault'
import type { NoteIndexEntry } from '../core/types'

/** Read the notes and work out what it would take, without sending anything. */
export function planFor(entries: NoteIndexEntry[]): Plan {
  const sources: SummarySource[] = []
  for (const e of entries) {
    const text = getText(e.path)
    if (text !== undefined) sources.push(sourceFor(e, text))
  }
  return planSummary(sources, settings.value.ai.contextTokens)
}

export interface RunOptions {
  /** Called as each pass starts, so the dialog can say where it is. */
  onProgress?: (done: number, total: number) => void
  /** Text as it streams, for the pass currently running. */
  onChunk?: (text: string) => void
  signal?: AbortSignal
}

/**
 * Summarise, in as many passes as the plan called for.
 *
 * Sequential rather than parallel. Three requests at once would be quicker
 * against a hosted provider and would put a local model into swap; more to the
 * point, a failure halfway through a parallel run leaves you unable to say
 * which parts were covered, and this is a feature whose whole claim is that it
 * covered everything.
 */
export async function runSummary(
  what: string,
  plan: Plan,
  opts: RunOptions = {},
): Promise<string> {
  const ai = settings.value.ai
  const total = plan.batches.length + (plan.batches.length > 1 ? 1 : 0)
  const partials: string[] = []

  for (const [i, batch] of plan.batches.entries()) {
    opts.onProgress?.(i, total)
    const text = await streamText(ai, summarySystem(what), batchUser(batch), {
      // Only the last pass is worth watching arrive; the intermediate ones are
      // not what anybody is going to read.
      onChunk: total === 1 ? opts.onChunk : undefined,
      signal: opts.signal,
    })
    partials.push(unfence(text))
  }

  if (partials.length === 1) return partials[0]

  opts.onProgress?.(total - 1, total)
  const combined = await streamText(
    ai,
    combineSystem(what, partials.length),
    combineUser(partials),
    { onChunk: opts.onChunk, signal: opts.signal },
  )
  return unfence(combined)
}

/** Write the summary into a new note and answer with its path. */
export async function writeSummaryNote(
  what: string,
  body: string,
  noteCount: number,
): Promise<string> {
  const ai = settings.value.ai
  if (!body.trim()) throw new LlmError('The model returned an empty summary, so no note was made.')
  const note = summaryNote({
    what,
    body,
    model: modelFor(ai, 'text'),
    provider: presetFor(ai.provider)?.label ?? ai.provider,
    noteCount,
  })
  return createNote(settings.value.generatedFolder, note.title, note.text)
}
