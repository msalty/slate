/**
 * Notes that look related to this one, from the links and tags already indexed.
 *
 * **The graph you did not draw.** What points at a note is already answered, at
 * the end of the note, by Linked mentions — so a note this one links to, or
 * that links to it, is deliberately *not* offered here. It would be the same
 * list twice, and the half worth having is the other half: the note you would
 * have linked if you had remembered it existed.
 *
 * Two signals, and both are worth as much as they are *surprising*:
 *
 * **Shared tags, weighted by how rare the tag is.** A tag on half the vault
 * says nothing — everything is about work — and counting it the same as a tag
 * on three notes is the single fastest way to turn this into "other notes,
 * roughly". So each shared tag is worth `log(N / how many notes carry it)`,
 * which is zero for a tag everything has and large for one almost nothing does.
 *
 * **Shared neighbours, weighted the same way.** If this note and that one both
 * link to `[[Working Agreements]]`, they are probably about the same thing —
 * unless Working Agreements is linked by sixty notes, in which case they have
 * a filing cabinet in common and nothing else. Co-citation, discounted by how
 * promiscuous the note in the middle is.
 *
 * A folder in common is worth a nudge and no more. It is real evidence — people
 * file things together on purpose — and also the weakest thing here, because a
 * folder of forty notes would otherwise relate all of them to each other.
 *
 * **Everything is pure.** No signals, no vault, no DOM: it takes a list of
 * notes and answers about one of them, which is what lets the same scoring run
 * inside the app and over a folder of markdown from a script — see
 * `scripts/related.ts`. A ranking nobody can look at is a ranking nobody can
 * disagree with.
 */

import { normPath } from './util'

/** Everything the scoring reads. A `NoteIndexEntry` satisfies it as it is. */
export interface RelatedInput {
  path: string
  title: string
  folder: string
  tags: string[]
  /** Wikilink targets as written, which is what the index holds. */
  links: string[]
}

export interface RelatedNote<T extends RelatedInput = RelatedInput> {
  note: T
  score: number
  /**
   * What put it here, strongest first — `#roofing`, `via Working Agreements`.
   *
   * Carried rather than derived so the list can say why, which is the only way
   * anybody can tell a good answer from a plausible one.
   */
  why: string[]
}

/**
 * A tag and everything it is nested under: `work/active` is also `work`.
 *
 * The same reading the sidebar and the rule language already use, so two notes
 * tagged `#work/active` and `#work/archived` have `work` in common — which is
 * true, and much weaker than sharing the leaf, because `work` is on far more
 * notes and is discounted accordingly.
 */
function tagChain(tag: string): string[] {
  const parts = tag.split('/')
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'))
}

function expandTags(tags: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const t of tags) for (const step of tagChain(t.toLowerCase())) out.add(step)
  return out
}

/**
 * How much one shared thing is worth: `log(N / df)`, the ordinary inverse
 * document frequency, floored at zero so a thing everything has is worth
 * nothing rather than slightly negative.
 */
function idf(total: number, df: number): number {
  if (df <= 0) return 0
  return Math.max(0, Math.log(total / df))
}

/** Weights, in the units `idf` produces. */
const TAG_WEIGHT = 1
const LINK_WEIGHT = 1.4
const FOLDER_BONUS = 0.35

/**
 * The two bars a signal can clear, and what each one buys.
 *
 * **These are the whole calibration.** There was a third — a minimum on the
 * total score — until a probe over a real vault showed a slider for it
 * changing nothing at all: anything clearing the bars below already scores
 * more than twice what that minimum asked for, so it could never bind. A
 * constant that cannot have an effect is worse than no constant, because it
 * reads like a safeguard.
 *
 * Both of these came out of running the scoring over a vault and reading it,
 * which is what `scripts/related.ts` is for. Two failures showed up, and they
 * are the same failure twice:
 *
 * **One shared tag is a category, not a relation.** Rarity cannot tell you
 * which you are looking at — `#inbox` and `#roofing` can sit on the same
 * number of notes, and one is a subject while the other is a tray. The tail of
 * every list was notes sharing one bookkeeping tag: Reading list, Car
 * insurance and Roof survey, related because all three were in the inbox.
 *
 * **And two weak signals do not add up to one good one.** Cutting the first
 * failure by demanding corroboration left a second: "Q1 budget is related to
 * Gift ideas, because both cite Working Agreements and both are tagged
 * #work". Two pieces of evidence, both of them filing.
 *
 * So: a signal has to be worth `log 8` — on at most an eighth of your notes —
 * before it counts as evidence at all, and two of those are a relation.
 * Anything below that is filing rather than subject matter: it still adds to
 * the score, and orders the answers, but it cannot justify one.
 *
 * `log 20` is the bar for standing alone, without corroboration: a tag or a
 * cited note that at most a twentieth of the vault carries really is a
 * subject. `#roofing` on four notes of a hundred clears it; `#work` never
 * will, in any vault where the word means anything.
 *
 * Measured after the weights, so a link counts slightly more readily than a
 * tag. Citing something is a deliberate act; tagging is often a reflex.
 *
 * **Both are `log(1 / fraction)`, which is why they are single numbers rather
 * than one per vault size.** `log 8` *is* "one note in eight", at thirty notes
 * and at thirty thousand — see the test that says so.
 */
export const EVIDENCE = Math.log(8)
export const STRONG = Math.log(20)

export interface RelatedOptions {
  limit?: number
  /**
   * How rare a signal has to be to count as evidence, and to stand alone
   * without a second opinion — both as `log(1 / fraction of the vault)`.
   *
   * Exposed so the probe can move them and watch what appears, which is the
   * only way to decide where they belong. Nothing in the app passes them.
   */
  evidence?: number
  strong?: number
}

interface Index<T extends RelatedInput> {
  byPath: Map<string, T>
  tagDf: Map<string, number>
  /** path -> the notes it links to; and how many notes point at each one. */
  outOf: Map<string, Set<string>>
  inDegree: Map<string, number>
  total: number
}

/**
 * Counting how common every tag and every cited note is takes a pass over the
 * whole vault, and the answer is the same for every note asked about — so it
 * is built once per list rather than once per question.
 *
 * Keyed on the array itself, weakly: the vault hands out a new array when it
 * changes and the old one becomes garbage, which is exactly the lifetime this
 * wants. Asking about one note stays a pass over the vault; asking about all
 * of them, which is what the probe and the prototype script both do, stops
 * being a pass over the vault *per note*.
 */
const indexCache = new WeakMap<object, Index<never>>()

function indexOf<T extends RelatedInput>(notes: readonly T[]): Index<T> {
  const hit = indexCache.get(notes as unknown as object) as Index<T> | undefined
  if (hit) return hit

  const byPath = new Map(notes.map((n) => [n.path, n]))
  const byTitle = new Map<string, string>()
  for (const n of notes) {
    const key = n.title.toLowerCase()
    if (!byTitle.has(key)) byTitle.set(key, n.path)
  }
  /** A wikilink target as written -> the path it means, when it means one. */
  const resolve = (target: string): string | undefined => {
    const t = target.trim()
    if (!t) return undefined
    const np = normPath(t)
    if (byPath.has(np)) return np
    if (byPath.has(`${np}.md`)) return `${np}.md`
    return byTitle.get(t.toLowerCase())
  }

  const tagDf = new Map<string, number>()
  const outOf = new Map<string, Set<string>>()
  const inDegree = new Map<string, number>()
  for (const n of notes) {
    for (const t of expandTags(n.tags)) tagDf.set(t, (tagDf.get(t) ?? 0) + 1)
    const out = new Set<string>()
    for (const l of n.links) {
      const p = resolve(l)
      if (p && p !== n.path) out.add(p)
    }
    outOf.set(n.path, out)
    for (const p of out) inDegree.set(p, (inDegree.get(p) ?? 0) + 1)
  }

  const index: Index<T> = { byPath, tagDf, outOf, inDegree, total: notes.length }
  indexCache.set(notes as unknown as object, index as unknown as Index<never>)
  return index
}

/**
 * The notes most like `path`, best first.
 *
 * Returns an empty list — not a bad list — when nothing is corroborated.
 */
export function relatedNotes<T extends RelatedInput>(
  notes: readonly T[],
  path: string,
  opts: RelatedOptions = {},
): Array<RelatedNote<T>> {
  const limit = opts.limit ?? 8
  const evidenceBar = opts.evidence ?? EVIDENCE
  const strongBar = opts.strong ?? STRONG
  if (notes.length < 2) return []
  const { byPath, tagDf, outOf, inDegree, total } = indexOf(notes)
  const me = byPath.get(path)
  if (!me) return []

  /* ---- what this note already knows about --------------------------- */

  const myTags = expandTags(me.tags)
  const myOut = outOf.get(me.path) ?? new Set<string>()
  /**
   * Every note already joined to this one by a link, either way round.
   *
   * Excluded from the answer, because they are what Linked mentions and the
   * note's own text already say — but kept as *evidence*, since a note two
   * hops away is reached through exactly these.
   */
  const adjacent = new Set<string>(myOut)
  for (const n of notes) if (outOf.get(n.path)?.has(me.path)) adjacent.add(n.path)

  /* ---- score everything else ---------------------------------------- */

  const out: Array<RelatedNote<T>> = []
  for (const n of notes) {
    if (n.path === me.path || adjacent.has(n.path)) continue

    let score = 0
    /*
     * `evidence` is what counts towards corroboration; a folder is not. Two
     * notes filed together is a real nudge and a terrible second opinion —
     * it is the thing most likely to agree with whatever the first signal
     * said, since people file by subject. Letting it corroborate turned every
     * note in a folder that cited a hub into a full list of eight.
     */
    const reasons: Array<{ text: string; worth: number; evidence: boolean }> = []

    for (const t of expandTags(n.tags)) {
      if (!myTags.has(t)) continue
      const worth = TAG_WEIGHT * idf(total, tagDf.get(t) ?? 0)
      if (worth <= 0) continue
      score += worth
      reasons.push({ text: `#${t}`, worth, evidence: true })
    }

    /*
     * Notes they both point at. Not notes that point at them both — that is
     * the same relation read backwards and would double-count a pair sitting
     * under one hub, which is the commonest shape in any vault with an index
     * note in it.
     */
    for (const hop of outOf.get(n.path) ?? []) {
      if (!myOut.has(hop)) continue
      const worth = LINK_WEIGHT * idf(total, inDegree.get(hop) ?? 0)
      if (worth <= 0) continue
      score += worth
      reasons.push({ text: `via ${byPath.get(hop)?.title ?? hop}`, worth, evidence: true })
    }

    if (me.folder && n.folder === me.folder) {
      score += FOLDER_BONUS
      reasons.push({ text: `in ${me.folder}`, worth: FOLDER_BONUS, evidence: false })
    }

    /*
     * Corroborated, or overwhelming. One ordinary signal is the shape every
     * bad answer took when this was run over a real vault, so one ordinary
     * signal is not an answer.
     */
    const evidence = reasons.filter((r) => r.evidence && r.worth >= evidenceBar)
    if (evidence.length < 2 && !evidence.some((r) => r.worth >= strongBar)) continue
    out.push({
      note: n,
      score,
      why: reasons.sort((a, b) => b.worth - a.worth).map((r) => r.text),
    })
  }

  /*
   * Title order breaks a tie, so the list is stable between renders rather
   * than reordering itself whenever two notes score identically — which, with
   * integer-ish tag scores, they often do.
   */
  return out
    .sort((a, b) => b.score - a.score || a.note.title.localeCompare(b.note.title))
    .slice(0, limit)
}
