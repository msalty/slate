/**
 * Linked mentions, grouped by who wrote them.
 *
 * A contact's note is linked from the few notes you wrote about her and from
 * every meeting she was in, and an importer writes the meetings: two hundred
 * of them in one flat list put your three notes somewhere in the middle. So
 * your own come first, and each importer's are a group of their own, counted —
 * the list says there were two hundred meetings without making you scroll
 * past them to find what you wrote.
 */

import type { NoteIndexEntry } from './types'

export interface MentionGroups {
  /** Notes you wrote, in the order they came. */
  own: NoteIndexEntry[]
  /** One group per `source:`, by name, each newest first. */
  external: Array<{ source: string; notes: NoteIndexEntry[] }>
}

/**
 * When a mention happened, for ordering an importer's group: an event by when
 * it starts — a meeting is remembered by its day, and an importer rewriting
 * last month's standup does not make it recent — anything else by its edit.
 */
function when(e: NoteIndexEntry): number {
  return e.event?.start ?? e.mtime
}

export function groupMentions(entries: readonly NoteIndexEntry[]): MentionGroups {
  const own: NoteIndexEntry[] = []
  const bySource = new Map<string, NoteIndexEntry[]>()
  for (const e of entries) {
    if (e.source === undefined) {
      own.push(e)
      continue
    }
    const list = bySource.get(e.source)
    if (list) list.push(e)
    else bySource.set(e.source, [e])
  }
  const external = [...bySource]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([source, notes]) => ({
      source,
      notes: notes.sort((a, b) => when(b) - when(a) || (a.path < b.path ? -1 : 1)),
    }))
  return { own, external }
}
