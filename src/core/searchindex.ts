/**
 * The search index: what stops a search from reading every note.
 *
 * Searching was a linear scan — lowercase every note's whole text, run
 * `indexOf` for every term, keep what matched. Predictable, exactly as accurate
 * as it looks, and fine to a few thousand notes; past that it is megabytes of
 * string work on every keystroke.
 *
 * **This changes what gets *read*, never what gets *found*.** It is a filter in
 * front of the same scan, not a ranking of its own: it narrows the vault to the
 * notes that can possibly match and hands them to the scorer unchanged. A query
 * returns the same notes in the same order as it always did — which is the only
 * reason an index is worth having here at all. An index that is *nearly* right
 * about which notes contain a word is a search you cannot trust.
 *
 * So the narrowing is allowed to be *loose* but never *wrong*: it may hand over
 * a note the scan then rejects, and may decline to narrow at all, but a note
 * that matches is never left out. See `searchCandidates`.
 *
 * **How it can be exact.** The index is over *runs of non-whitespace*: the
 * lowercased text cut at every space, tab and newline, with no stemming, no
 * punctuation stripping and no word rules. A query is cut the same way, so no
 * search term ever contains whitespace — and a string with no whitespace in it
 * can only appear inside one run. So "a note contains this term" is exactly "a
 * run of that note contains this term", and substring matching survives whole:
 * `ear` still finds "search", `o.b` still finds "foo.bar".
 *
 * Which makes a search two passes instead of one, over two much smaller things:
 * the *vocabulary* — every distinct run in the vault, a fraction of its text
 * once duplicates are gone, and one that stops growing long before the vault
 * does — and then the handful of notes those runs point at.
 *
 * **Built in slices, in the app's idle time, and never on the critical path.**
 * Reading a large vault into an index is real work — a second or so for a very
 * large one — and doing it inside the first keystroke in the search box would
 * cost more than it ever saved back. So the build starts after boot, runs a few
 * milliseconds at a time, and until it finishes searching simply reads
 * everything the way it always did. Nothing waits for it and nothing is wrong
 * without it.
 *
 * It costs memory roughly the size of the vault's distinct vocabulary, which is
 * the honest price of not reading everything.
 */

/** run -> the paths of the notes it appears in. */
const postings = new Map<string, Set<string>>()

/** path -> the runs it contributed, so a re-index can take them back out. */
const runsByPath = new Map<string, string[]>()

/** Every key of `postings` as an array to scan. Rebuilt when it goes stale. */
let vocabulary: string[] | null = null

/**
 * The last term scanned for at each position in the query, and what matched it.
 *
 * Typing a query means searching for `m`, `me`, `mee`, `meet` in turn, and a
 * run containing "meet" certainly contains "mee" — so each keystroke re-filters
 * the previous answer instead of the whole vocabulary. Kept per *word* of the
 * query, or `pine cones` would clear the cache `pine` had just filled and every
 * term of a two-word query would scan everything. Thrown away whenever the
 * vocabulary changes, which is any edit to any note.
 */
let lastScan: Array<{ term: string; runs: string[] } | undefined> = []

/**
 * `idle` — nothing indexed and nothing being indexed; searching reads
 * everything. `building` — the maps are filling up, and are already being kept
 * current as notes change, but cannot answer a query yet. `ready` — complete,
 * and the authority on which notes contain a term.
 */
type Phase = 'idle' | 'building' | 'ready'

let phase: Phase = 'idle'

/** What the build has left to get through. Notes, by path, still to be read. */
let pending: Map<string, string> | null = null

/** The character codes `split(/\s+/)` cuts on, for the scan in `indexNote`. */
const WS = new Set([32, 9, 10, 13, 11, 12, 0xa0, 0x2028, 0x2029, 0xfeff])

/** Complete, and safe to answer a query from. */
export function searchIndexReady(): boolean {
  return phase === 'ready'
}

/** Started, and so not to be started again. */
export function searchIndexBuilding(): boolean {
  return phase === 'building'
}

/** Everything the index holds, for a vault that has just been replaced. */
export function resetSearchIndex(): void {
  postings.clear()
  runsByPath.clear()
  pending = null
  vocabulary = null
  lastScan = []
  phase = 'idle'
}

/**
 * Begin a build from a snapshot of every note: `path -> title and text`.
 *
 * Nothing is read here. The work happens in `buildSearchIndexSlice`, and from
 * this moment on the index also tracks every change as it is made — a note
 * saved mid-build is taken *out* of the queue and indexed from what it now
 * says, so the build can never overwrite a newer version with the snapshot's.
 */
export function startSearchIndex(snapshot: Map<string, string>): void {
  resetSearchIndex()
  phase = 'building'
  pending = snapshot
}

/**
 * Read some of the queue. Returns true when there is nothing left to read.
 *
 * The caller decides when to come back — see `warmSearchIndex` in the vault,
 * which spends the app's idle time on it.
 */
export function buildSearchIndexSlice(budgetMs = 8): boolean {
  if (phase !== 'building' || !pending) return true
  const until = Date.now() + budgetMs
  for (const [path, text] of pending) {
    // Deleting the entry the loop is standing on is safe, and is what keeps a
    // save arriving mid-build from being read twice.
    pending.delete(path)
    ingest(path, text)
    if (Date.now() >= until) break
  }
  if (pending.size) return false
  pending = null
  phase = 'ready'
  return true
}

/** Build the whole thing now. For tests, and for a vault small enough not to care. */
export function buildSearchIndex(notes: Iterable<[string, string]>): void {
  startSearchIndex(new Map(notes))
  while (!buildSearchIndexSlice(Number.POSITIVE_INFINITY));
}

/**
 * Take one note's runs in, replacing whatever it contributed before.
 *
 * A no-op while the index is idle, so a vault nobody has searched yet pays
 * nothing for saves.
 */
export function indexNote(path: string, text: string): void {
  if (phase === 'idle') return
  // Whatever the snapshot said about this note is now out of date.
  pending?.delete(path)
  ingest(path, text)
}

function ingest(path: string, text: string): void {
  remove(path)
  const runs = new Set<string>()
  // One pass, no regex: `split(/\s+/)` allocates an array of every run in the
  // note including the duplicates, which is the bulk of a note's text.
  const lower = text.toLowerCase()
  let start = -1
  for (let i = 0; i <= lower.length; i++) {
    const ws = i === lower.length || WS.has(lower.charCodeAt(i))
    if (ws) {
      if (start >= 0) runs.add(lower.slice(start, i))
      start = -1
    } else if (start < 0) start = i
  }

  const list: string[] = []
  for (const run of runs) {
    let set = postings.get(run)
    if (!set) {
      set = new Set()
      postings.set(run, set)
      vocabulary = null
    }
    set.add(path)
    list.push(run)
  }
  runsByPath.set(path, list)
  lastScan = []
}

/** Forget a note: deleted, or moved away under another path. */
export function dropNote(path: string): void {
  if (phase === 'idle') return
  pending?.delete(path)
  remove(path)
}

function remove(path: string): void {
  const runs = runsByPath.get(path)
  if (!runs) return
  runsByPath.delete(path)
  for (const run of runs) {
    const set = postings.get(run)
    if (!set) continue
    set.delete(path)
    if (!set.size) {
      postings.delete(run)
      vocabulary = null
    }
  }
  lastScan = []
}

/**
 * The paths worth scoring for these terms, or undefined for "read everything".
 *
 * The index **narrows**; the scan still decides. What comes back is a set the
 * matching notes are guaranteed to be inside — usually exactly them, and never
 * missing one — because every term is checked again per note by the scan that
 * follows. That guarantee is the whole contract: a filter that can *drop* a
 * matching note is a search you cannot trust, while one that occasionally
 * hands over a few extra notes only costs the time to read them.
 *
 * `ceiling` is what that licence is for. A term in half the vault narrows
 * nothing, and building a set of every note to say so is pure loss — the scan
 * has to read them all either way. So a term whose posting lists run past the
 * ceiling is abandoned mid-union and simply left to the scan; if every term is
 * like that, this returns undefined and nothing is built at all. Which is the
 * honest shape of it: the index is worth its bookkeeping for the word you
 * remember writing once, and worth nothing for the word you write constantly.
 */
export function searchCandidates(
  terms: readonly string[],
  ceiling = Number.POSITIVE_INFINITY,
): Set<string> | undefined {
  if (phase !== 'ready' || !terms.length) return undefined
  let out: Set<string> | undefined
  for (const [slot, term] of terms.entries()) {
    const hit = pathsContaining(term, slot, out ? Number.POSITIVE_INFINITY : ceiling)
    // Over the ceiling: this term is no use as a filter, but another might be.
    if (!hit) continue
    if (!out) out = hit
    else for (const p of out) if (!hit.has(p)) out.delete(p)
    // Every term has to match, so an empty intersection is a finished answer.
    if (!out.size) return out
  }
  return out
}

/**
 * Undefined once the union passes `ceiling` — abandoned rather than finished,
 * because the answer past that point is not worth what it costs to assemble.
 * An intersection against a set already in hand has no ceiling: it can only
 * shrink, and shrinking is the whole point.
 */
function pathsContaining(term: string, slot: number, ceiling: number): Set<string> | undefined {
  const out = new Set<string>()
  for (const run of runsContaining(term, slot)) {
    for (const path of postings.get(run) ?? []) {
      out.add(path)
      if (out.size > ceiling) return undefined
    }
  }
  return out
}

function runsContaining(term: string, slot: number): string[] {
  const last = lastScan[slot]
  const from = last && term.startsWith(last.term) ? last.runs : words()
  const out: string[] = []
  for (const run of from) if (run.includes(term)) out.push(run)
  lastScan[slot] = { term, runs: out }
  return out
}

function words(): string[] {
  if (!vocabulary) vocabulary = [...postings.keys()]
  return vocabulary
}

/** How many distinct runs the index is holding, for tests and diagnostics. */
export function searchIndexSize(): number {
  return postings.size
}
