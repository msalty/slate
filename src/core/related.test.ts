/**
 * What "related" is allowed to mean.
 *
 * These cannot tell you whether the ranking is any *good* — that needs real
 * notes and somebody who knows what the answer should be, which is what
 * `scripts/related.ts` is for. What they pin down is everything that would make
 * a good ranking impossible, and the two things running it over a vault showed
 * it getting wrong: one bookkeeping tag counting as a relation, and two weak
 * signals adding up to one that looked strong.
 *
 * **Everything here is about proportions, not counts.** The rules are written
 * in `log(N/df)`, which depends only on the fraction of the vault carrying a
 * thing — so "a tag on two notes" means nothing on its own and the fixtures all
 * say how big the vault around it is. A tag on two notes out of ten is on a
 * fifth of everything and is filing; the same tag out of sixty is a subject.
 */

import { describe, expect, it } from 'vitest'
import { relatedNotes, type RelatedInput } from './related'

/** A note, with the fields that matter and sane defaults for the rest. */
function note(
  title: string,
  bits: { tags?: string[]; links?: string[]; folder?: string } = {},
): RelatedInput {
  return {
    path: `${bits.folder ? `${bits.folder}/` : ''}${title}.md`,
    title,
    folder: bits.folder ?? '',
    tags: bits.tags ?? [],
    links: bits.links ?? [],
  }
}

/** A vault of unremarkable notes to be a fraction *of*. */
function filler(n: number, tags: string[] = []): RelatedInput[] {
  return Array.from({ length: n }, (_, i) => note(`Filler ${i}`, { tags }))
}

const titles = (rs: ReturnType<typeof relatedNotes>) => rs.map((r) => r.note.title)

describe('what it will not offer', () => {
  it('never offers the note itself', () => {
    const vault = [note('A', { tags: ['roofing'] }), note('B', { tags: ['roofing'] }), ...filler(58)]
    expect(titles(relatedNotes(vault, 'A.md'))).toEqual(['B'])
  })

  it('never offers a note this one already links to', () => {
    // That is what the note's own text says, and what Linked mentions says at
    // the end of it. The half worth having is the half you did not draw.
    const vault = [
      note('A', { tags: ['roofing'], links: ['B'] }),
      note('B', { tags: ['roofing'] }),
      ...filler(58),
    ]
    expect(relatedNotes(vault, 'A.md')).toEqual([])
  })

  it('nor one that links to it', () => {
    const vault = [
      note('A', { tags: ['roofing'] }),
      note('B', { tags: ['roofing'], links: ['A'] }),
      ...filler(58),
    ]
    expect(relatedNotes(vault, 'A.md')).toEqual([])
  })

  it('answers nothing for a note with nothing in common', () => {
    const vault = [note('A', { tags: ['roofing'] }), note('B', { tags: ['baking'] }), ...filler(58)]
    expect(relatedNotes(vault, 'A.md')).toEqual([])
  })

  it('answers nothing for a vault too small to have a relation in it', () => {
    expect(relatedNotes([note('A')], 'A.md')).toEqual([])
    expect(relatedNotes([], 'A.md')).toEqual([])
  })

  it('answers nothing for a note it has never heard of', () => {
    expect(relatedNotes([note('A'), note('B')], 'Nowhere.md')).toEqual([])
  })
})

/*
 * The two findings. Both came out of reading the prototype's output over a
 * vault rather than out of thinking about it, and both are the same mistake:
 * treating filing as though it were subject matter.
 */
describe('filing is not subject matter', () => {
  it('will not relate two notes on one middling tag', () => {
    // The observed failure: `#inbox` on a sixteenth of the vault scored as
    // well as a real topic would, relating Reading list to Car insurance to
    // Roof survey. One signal of that strength is now not an answer.
    const vault = [
      note('Reading list', { tags: ['inbox'] }),
      note('Car insurance', { tags: ['inbox'] }),
      note('Roof survey', { tags: ['inbox'] }),
      ...filler(47),
    ]
    expect(relatedNotes(vault, 'Reading list.md')).toEqual([])
  })

  it('though a tag on a twentieth of the vault does stand on its own', () => {
    /*
     * Where the line is, stated rather than left implied — because nothing in
     * the data distinguishes a subject from a tray, and this is the guess
     * being made on the reader's behalf. A tag that rare is almost always a
     * subject; one any commoner needs a second opinion.
     */
    const vault = [
      note('Reading list', { tags: ['inbox'] }),
      note('Car insurance', { tags: ['inbox'] }),
      note('Roof survey', { tags: ['inbox'] }),
      ...filler(57),
    ]
    expect(titles(relatedNotes(vault, 'Reading list.md'))).toEqual(['Car insurance', 'Roof survey'])
  })

  it('nor on two weak signals propping each other up', () => {
    // "Q1 budget is related to Gift ideas, because both cite Working
    // Agreements and both are tagged #work." Two pieces of evidence, both of
    // them filing. Corroboration only counts when the things corroborating
    // are worth something on their own.
    const vault = [
      note('Q1 budget', { tags: ['work'], links: ['Working Agreements'] }),
      note('Gift ideas', { tags: ['work'], links: ['Working Agreements'] }),
      note('Working Agreements'),
      // A third of the vault is tagged #work and cites the same hub.
      ...Array.from({ length: 20 }, (_, i) =>
        note(`Other ${i}`, { tags: ['work'], links: ['Working Agreements'] }),
      ),
      ...filler(37),
    ]
    expect(relatedNotes(vault, 'Q1 budget.md')).toEqual([])
  })

  it('but two signals that each mean something is a relation', () => {
    // Neither tag is rare enough to stand alone; together they are an answer.
    const vault = [
      note('Roof survey', { tags: ['roofing', 'slate'] }),
      note('Slate sourcing', { tags: ['roofing', 'slate'] }),
      ...Array.from({ length: 10 }, (_, i) => note(`Roof ${i}`, { tags: ['roofing', 'slate'] })),
      ...filler(88),
    ]
    const hits = relatedNotes(vault, 'Roof survey.md')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].why).toEqual(['#roofing', '#slate'])
  })
})

describe('a tag is worth what it is rare', () => {
  /**
   * Sixty notes tagged `#work`, two of them also tagged `#roofing`.
   *
   * The failure this is here to catch: counting both the same, so every note
   * in the vault is "related" to every other one by virtue of all being about
   * work. A tag that common carries no information at all.
   */
  const vault = [
    ...Array.from({ length: 58 }, (_, i) => note(`Work ${i}`, { tags: ['work'] })),
    note('Roof A', { tags: ['work', 'roofing'] }),
    note('Roof B', { tags: ['work', 'roofing'] }),
  ]

  it('puts the note sharing the rare tag first', () => {
    const hits = relatedNotes(vault, 'Roof A.md')
    expect(hits[0].note.title).toBe('Roof B')
    expect(hits[0].why[0]).toBe('#roofing')
  })

  it('and does not offer the fifty-eight that only share the common one', () => {
    expect(titles(relatedNotes(vault, 'Roof A.md'))).toEqual(['Roof B'])
  })

  it('so a tag on everything cannot carry a note on its own', () => {
    const everything = Array.from({ length: 60 }, (_, i) => note(`N${i}`, { tags: ['inbox'] }))
    expect(relatedNotes(everything, 'N0.md')).toEqual([])
  })

  /*
   * The reason the thresholds are one number each rather than a number per
   * vault size: an idf depends only on the fraction carrying the thing, so
   * `log(N / (N/20))` is `log 20` at every N.
   */
  it('means the same thing in a small vault and a large one', () => {
    const build = (n: number) => [
      note('A', { tags: ['roofing'] }),
      note('B', { tags: ['roofing'] }),
      ...filler(n),
    ]
    expect(titles(relatedNotes(build(58), 'A.md'))).toEqual(['B'])
    expect(titles(relatedNotes(build(2998), 'A.md'))).toEqual(['B'])

    // And a tag on half the vault is cut at either size.
    const half = (n: number) => [
      ...Array.from({ length: n / 2 }, (_, i) => note(`X${i}`, { tags: ['common'] })),
      ...Array.from({ length: n / 2 }, (_, i) => note(`Y${i}`, { tags: ['other'] })),
    ]
    expect(relatedNotes(half(60), 'X0.md')).toEqual([])
    expect(relatedNotes(half(3000), 'X0.md')).toEqual([])
  })
})

describe('tags nest, the way they do everywhere else', () => {
  it('counts a shared parent when the leaves differ', () => {
    const vault = [
      note('A', { tags: ['work/roofing'] }),
      note('B', { tags: ['work/plumbing'] }),
      ...filler(58, ['home']),
    ]
    const hits = relatedNotes(vault, 'A.md')
    expect(titles(hits)).toEqual(['B'])
    expect(hits[0].why).toContain('#work')
  })

  it('but the leaf is worth more than the parent, being rarer', () => {
    const vault = [
      note('A', { tags: ['work/roofing'] }),
      note('Same leaf', { tags: ['work/roofing'] }),
      note('Same parent', { tags: ['work/plumbing'] }),
      ...filler(57, ['home']),
    ]
    const hits = relatedNotes(vault, 'A.md')
    expect(titles(hits)).toEqual(['Same leaf', 'Same parent'])
    expect(hits[0].score).toBeGreaterThan(hits[1].score)
    /*
     * Sharing the leaf means sharing the parent too — which is why the parent
     * is *not* listed as well. It is implied rather than independent, and this
     * test used to assert both, which was the bug written down as a promise.
     */
    expect(hits[0].why).toEqual(['#work/roofing'])
    expect(hits[1].why).toEqual(['#work'])
  })
})

describe('notes that point at the same thing', () => {
  it('relates two notes that cite a third, without either citing the other', () => {
    const vault = [
      note('A', { links: ['Charter'] }),
      note('B', { links: ['Charter'] }),
      note('Charter'),
      ...filler(57),
    ]
    const hits = relatedNotes(vault, 'A.md')
    expect(titles(hits)).toEqual(['B'])
    expect(hits[0].why).toContain('via Charter')
  })

  it('discounts a note everything links to, which joins nothing', () => {
    // An index note linked by the whole vault is a filing cabinet: two notes
    // both pointing at it have that in common and nothing else.
    const vault = Array.from({ length: 60 }, (_, i) => note(`N${i}`, { links: ['Index'] }))
    vault.push(note('Index'))
    expect(relatedNotes(vault, 'N0.md')).toEqual([])
  })

  it('counts the hop from the citing end, and not from the cited one', () => {
    const vault = [note('A'), note('B', { links: ['A'] }), note('C', { links: ['A'] }), ...filler(57)]
    // Asked about A: B and C both point straight at it, so both are what
    // Linked mentions already says and neither is offered here.
    expect(relatedNotes(vault, 'A.md')).toEqual([])
    // Asked about B: C is a note citing the same thing B cites, which is the
    // whole co-citation signal and exactly what this is for.
    expect(titles(relatedNotes(vault, 'B.md'))).toEqual(['C'])
  })
})

describe('a folder in common', () => {
  it('is a nudge, not a relation', () => {
    const vault = [
      note('A', { folder: 'Clients' }),
      note('B', { folder: 'Clients' }),
      note('C', { folder: 'Clients' }),
      ...filler(57),
    ]
    // Filed together and nothing else: not enough to say anything about.
    expect(relatedNotes(vault, 'Clients/A.md')).toEqual([])
  })

  it('and cannot be the second opinion that makes a weak signal into an answer', () => {
    // People file by subject, so a shared folder is the thing most likely to
    // agree with whatever the first signal said — which makes it the worst
    // possible corroboration. `#work` here is on a third of the vault.
    const vault = [
      note('A', { tags: ['work'], folder: 'Work' }),
      note('B', { tags: ['work'], folder: 'Work' }),
      ...Array.from({ length: 18 }, (_, i) => note(`W${i}`, { tags: ['work'], folder: 'Work' })),
      ...filler(40),
    ]
    expect(relatedNotes(vault, 'Work/A.md')).toEqual([])
  })

  it('but it breaks a tie between two otherwise equal notes', () => {
    const vault = [
      note('A', { tags: ['roofing'], folder: 'Clients' }),
      note('Near', { tags: ['roofing'], folder: 'Clients' }),
      note('Far', { tags: ['roofing'], folder: 'Archive' }),
      ...filler(57),
    ]
    expect(titles(relatedNotes(vault, 'Clients/A.md'))).toEqual(['Near', 'Far'])
  })

  it('and the vault root is not a folder anybody chose', () => {
    // Everything starts there; sharing it means nothing.
    const vault = [note('A', { tags: ['x'] }), note('B', { tags: ['y'] }), ...filler(58)]
    expect(relatedNotes(vault, 'A.md')).toEqual([])
  })
})

describe('the shape of the answer', () => {
  /** Twelve notes sharing two tags, in a vault big enough for both to count. */
  const vault = [
    ...Array.from({ length: 12 }, (_, i) => note(`Roof ${i}`, { tags: ['roofing', 'slate'] })),
    ...filler(188, ['baking']),
  ]

  it('is capped, and the cap is askable', () => {
    expect(relatedNotes(vault, 'Roof 0.md')).toHaveLength(8)
    expect(relatedNotes(vault, 'Roof 0.md', { limit: 3 })).toHaveLength(3)
  })

  it('is ordered best first', () => {
    const scores = relatedNotes(vault, 'Roof 0.md').map((r) => r.score)
    expect(scores.every((s, i) => i === 0 || s <= scores[i - 1])).toBe(true)
  })

  it('breaks ties by title, so the list does not shuffle between renders', () => {
    const once = titles(relatedNotes(vault, 'Roof 0.md'))
    const again = titles(relatedNotes([...vault].reverse(), 'Roof 0.md'))
    expect(again).toEqual(once)
  })

  it('says why every note is in it', () => {
    for (const hit of relatedNotes(vault, 'Roof 0.md')) expect(hit.why.length).toBeGreaterThan(0)
  })
})

describe('a nested tag is one signal, not two', () => {
  /*
   * `#status/inbox` is `status` and `status/inbox`, and both were counted as
   * independent evidence — so nesting a bookkeeping tag was enough to
   * manufacture the corroboration that plain `#inbox` correctly failed to
   * find. An ancestor is not a second opinion about its own descendant.
   */
  const plain = [
    note('Reading list', { tags: ['inbox'] }),
    note('Car insurance', { tags: ['inbox'] }),
    ...filler(18),
  ]
  const nested = [
    note('Reading list', { tags: ['status/inbox'] }),
    note('Car insurance', { tags: ['status/inbox'] }),
    ...filler(18),
  ]

  it('answers the same whether the tag is nested or not', () => {
    expect(relatedNotes(plain, 'Reading list.md')).toEqual([])
    expect(relatedNotes(nested, 'Reading list.md')).toEqual([])
  })

  it('says the most specific shared tag once, not the whole chain', () => {
    const vault = [
      note('A', { tags: ['work/roofing'] }),
      note('B', { tags: ['work/roofing'] }),
      ...filler(58, ['home']),
    ]
    const hits = relatedNotes(vault, 'A.md')
    expect(titles(hits)).toEqual(['B'])
    expect(hits[0].why).toEqual(['#work/roofing'])
  })

  it('but still counts a parent that is genuinely all they share', () => {
    const vault = [
      note('A', { tags: ['work/roofing'] }),
      note('B', { tags: ['work/plumbing'] }),
      ...filler(58, ['home']),
    ]
    expect(relatedNotes(vault, 'A.md')[0]?.why).toEqual(['#work'])
  })
})
