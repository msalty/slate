/**
 * What ⌘K is being asked for, and the collections it can jump to.
 *
 * The sidebar used to be the only door to a folder, a Tag Folder or a tag,
 * which is what forced it to be a complete index of the vault — every folder
 * and every tag on screen at all times, in case one of them was the one you
 * wanted. A palette that reaches them is what lets the sidebar go back to
 * being a shortlist of the places you actually use.
 *
 * A leading character says which kind of thing is wanted, because "work" is
 * usually a folder *and* a tag *and* a word inside thirty notes:
 *
 *   work    all of it — collections first, then the notes that mention it
 *   #work   tags only
 *   /Work   folders only
 *   >sync   commands only
 *
 * A bare `#`, `/` or `>` lists everything of that kind: tags and folders
 * busiest first — the closest thing the app has to a tag browser — and the
 * commands in the order they are declared, which is the only way to read the
 * whole list. All three fall out of the same code.
 *
 * `>` for commands is the convention every other palette uses, so it is the
 * one people arrive already knowing.
 */

import { allTags } from '../core/vault'
import {
  folderTree,
  showsTasks,
  smartFolderAncestors,
  smartFolderCounts,
  smartFolderList,
  type FolderNode,
} from '../core/folders'
import { dirname, matchesAll, searchTerms } from '../core/util'
import type { Scope } from './state'

export type PlaceKind = 'folder' | 'smart' | 'tag'

export interface Place {
  /** Unique across all three kinds, so it can key a list. */
  id: string
  kind: PlaceKind
  /** The name you would have typed to find it. */
  label: string
  /** Which kind it is, where it sits, and how much is in it. */
  sub: string
  /** Emoji the user gave a Tag Folder, shown the way the sidebar shows it. */
  emoji?: string
  target: Scope
}

/** How many places a plain search contributes before the notes start. */
const PLAIN_LIMIT = 6

/**
 * Where a query is asking for places and nothing else, there are no notes to
 * make room for, so the cap only exists to keep the list from being endless.
 */
const PREFIXED_LIMIT = 40

/**
 * What the box is asking for: everything at once, one kind of collection, or
 * the commands.
 */
export type PaletteMode = 'everything' | 'places' | 'commands'

export interface PaletteQuery {
  mode: PaletteMode
  /** Which kinds of collection to look through; empty in command mode. */
  kinds: PlaceKind[]
  /** What was typed, with any prefix taken off. */
  term: string
}

/**
 * One parser for every prefix, so nothing can disagree about what a leading
 * character means. Anything reading the box — the results, the row list, the
 * message shown when nothing matches — comes through here.
 */
export function parsePaletteQuery(raw: string): PaletteQuery {
  const q = raw.trim()
  if (q.startsWith('#')) return { mode: 'places', kinds: ['tag'], term: q.slice(1).trim() }
  if (q.startsWith('/')) return { mode: 'places', kinds: ['folder'], term: q.slice(1).trim() }
  if (q.startsWith('>')) return { mode: 'commands', kinds: [], term: q.slice(1).trim() }
  return { mode: 'everything', kinds: ['folder', 'smart', 'tag'], term: q }
}

/** What to say when a query of this shape matched nothing at all. */
export function emptyPaletteMessage(raw: string): string {
  const { mode, kinds } = parsePaletteQuery(raw)
  /*
   * A prefixed query asked for one kind of thing, and telling somebody who
   * typed `#budge` to press Enter on "New note" answers a question they did
   * not ask — that row is not even in the list to press Enter on.
   */
  if (mode === 'commands') return 'No commands match.'
  if (mode === 'places') return kinds[0] === 'tag' ? 'No tags match.' : 'No folders match.'
  return 'Nothing matches. Press Enter on “New note” to start one.'
}

/**
 * Lower is better; `undefined` is not a match at all.
 *
 * Every term has to land somewhere in `haystack` — the same rule note search
 * and the Files list follow, so a two-word query behaves the way it does
 * everywhere else. The whole query is then measured against the *name* alone,
 * which is what puts a folder called "Work" above one called "Homework", and
 * both above one that only matched on its parent's name or on its rule.
 */
function rank(name: string, haystack: string, term: string, terms: string[]): number | undefined {
  if (!matchesAll(haystack, terms)) return undefined
  const n = name.toLowerCase()
  const q = term.toLowerCase()
  // A bare prefix matches everything equally; the count tiebreak below orders it.
  if (!q) return 3
  if (n === q) return 0
  if (n.startsWith(q)) return 1
  if (n.includes(q)) return 2
  return 3
}

/** Every real folder, flattened. The root is "All Notes" and has its own row. */
function folderNodes(): FolderNode[] {
  const out: FolderNode[] = []
  const walk = (n: FolderNode) => {
    if (n.path) out.push(n)
    n.children.forEach(walk)
  }
  walk(folderTree.value)
  return out
}

function countOf(n: number, noun: 'note' | 'task'): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/**
 * Collections matching what has been typed, best first.
 *
 * Ties break on how much is inside — a tag on forty notes before one on a
 * single note. That ordering is deliberate and the sidebar's tag cloud does
 * not have it: alphabetical is the right order to *read* a list of tags in and
 * the wrong order to *guess* one in.
 */
export function matchPlaces(raw: string): Place[] {
  const { mode, kinds, term } = parsePaletteQuery(raw)
  // `>` is asking for the commands; no collection is an answer to it.
  if (mode === 'commands') return []
  /*
   * Nothing typed and no prefix: the palette opens on a few commands and a
   * dozen recent notes, and dropping the whole vault's folders in underneath
   * them would be the sidebar's own problem moved into a dialog.
   */
  if (!term && mode === 'everything') return []

  const terms = searchTerms(term)
  const scored: Array<{ place: Place; rank: number; size: number }> = []

  if (kinds.includes('folder')) {
    for (const node of folderNodes()) {
      const r = rank(node.name, node.path, term, terms)
      if (r === undefined) continue
      const parent = dirname(node.path)
      scored.push({
        rank: r,
        size: node.count,
        place: {
          id: `folder:${node.path}`,
          kind: 'folder',
          label: node.name,
          sub: `${parent ? `Folder in ${parent}` : 'Folder'} · ${countOf(node.count, 'note')}`,
          target: { kind: 'folder', path: node.path },
        },
      })
    }
  }

  if (kinds.includes('smart')) {
    for (const node of smartFolderList.value) {
      const sf = node.folder
      /*
       * The rule counts as part of the name here: "which folder is the one
       * gathering #urgent?" is a question people have about their own Tag
       * Folders, and the rule is the only place the answer is written down.
       */
      const r = rank(sf.name, `${sf.name} ${sf.query}`, term, terms)
      if (r === undefined) continue
      const count = smartFolderCounts.value.get(sf.id) ?? 0
      const parent = smartFolderAncestors(sf.id).at(-1)
      scored.push({
        rank: r,
        size: count,
        place: {
          id: `smart:${sf.id}`,
          kind: 'smart',
          label: sf.name,
          emoji: sf.icon ?? '🏷️',
          sub: `${parent ? `Tag Folder in ${parent.name}` : 'Tag Folder'} · ${countOf(
            count,
            showsTasks(sf) ? 'task' : 'note',
          )}`,
          target: { kind: 'smart', id: sf.id },
        },
      })
    }
  }

  if (kinds.includes('tag')) {
    for (const t of allTags.value) {
      const r = rank(t.tag, t.tag, term, terms)
      if (r === undefined) continue
      scored.push({
        rank: r,
        size: t.count,
        place: {
          id: `tag:${t.tag}`,
          kind: 'tag',
          label: `#${t.tag}`,
          sub: `Tag · ${countOf(t.count, 'note')}`,
          target: { kind: 'tag', tag: t.tag },
        },
      })
    }
  }

  scored.sort(
    (a, b) =>
      a.rank - b.rank ||
      b.size - a.size ||
      a.place.label.localeCompare(b.place.label, undefined, { numeric: true }),
  )
  return scored.slice(0, mode === 'places' ? PREFIXED_LIMIT : PLAIN_LIMIT).map((s) => s.place)
}
