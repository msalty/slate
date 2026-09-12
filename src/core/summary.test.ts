/**
 * Deciding what to send, and admitting to it.
 *
 * The planner is where this feature can go quietly wrong. Sending the first
 * thirty notes of two hundred produces a summary that reads as complete and is
 * not, and no one would ever know — so the cases below are mostly about
 * *coverage*: every note that was counted is in a batch, nothing is dropped
 * without being reported, and an oversized note is cut rather than skipped.
 */

import { describe, expect, it } from 'vitest'
import {
  batchUser,
  combineSystem,
  combineUser,
  estimateTokens,
  planSummary,
  sourceFor,
  summaryNote,
  summarySystem,
  summaryTitle,
  type SummarySource,
} from './summary'
import type { NoteIndexEntry } from './types'

const src = (title: string, body: string): SummarySource => ({
  path: `${title}.md`,
  title,
  body,
  tokens: estimateTokens(body) + 8,
})

/** A source of roughly `n` tokens. */
const sized = (title: string, n: number) => src(title, 'w '.repeat(n * 2))

describe('reading a note for sending', () => {
  it('drops the frontmatter and keeps the body', () => {
    const entry = { path: 'Work/Plan.md', title: 'Plan' } as NoteIndexEntry
    const s = sourceFor(entry, '---\ntags: [work]\npinned: true\n---\n\nThe actual plan.\n')
    expect(s.body).toBe('The actual plan.')
    expect(s.body).not.toContain('pinned')
    expect(s.title).toBe('Plan')
  })

  it('copes with a note that has no frontmatter at all', () => {
    const entry = { path: 'a.md', title: 'a' } as NoteIndexEntry
    expect(sourceFor(entry, 'Just text.').body).toBe('Just text.')
  })
})

describe('planning the passes', () => {
  it('puts everything in one request when it fits', () => {
    const plan = planSummary([sized('a', 100), sized('b', 100)], 16000)
    expect(plan.batches).toHaveLength(1)
    expect(plan.batches[0]).toHaveLength(2)
  })

  it('splits into passes when it does not, and loses nobody', () => {
    const notes = Array.from({ length: 10 }, (_, i) => sized(`n${i}`, 300))
    const plan = planSummary(notes, 1000)
    expect(plan.batches.length).toBeGreaterThan(1)
    const titles = plan.batches.flat().map((s) => s.title)
    expect(titles).toHaveLength(10)
    expect(new Set(titles).size).toBe(10)
  })

  it('leaves empty notes out and says how many', () => {
    const plan = planSummary([src('full', 'words here'), src('blank', ''), src('spaces', '   ')], 16000)
    expect(plan.batches.flat()).toHaveLength(1)
    expect(plan.skipped).toHaveLength(2)
  })

  it('cuts a single over-sized note rather than dropping it', () => {
    // Dropping the one enormous note is how a summary of a project silently
    // omits the project plan.
    const plan = planSummary([sized('huge', 5000), sized('small', 50)], 1000)
    expect(plan.truncated).toBe(true)
    const titles = plan.batches.flat().map((s) => s.title)
    expect(titles).toContain('huge')
    expect(titles).toContain('small')
    expect(plan.batches.flat().find((s) => s.title === 'huge')!.body).toContain('[note truncated]')
  })

  it('counts the combining pass into the estimate when there is one', () => {
    const one = planSummary([sized('a', 100)], 16000)
    const many = planSummary(Array.from({ length: 6 }, (_, i) => sized(`n${i}`, 300)), 1000)
    expect(one.tokens).toBeLessThan(many.tokens)
    // More than the raw material, because merging the parts costs something too.
    expect(many.tokens).toBeGreaterThan(many.batches.flat().reduce((n, s) => n + s.tokens, 0))
  })

  it('never makes an empty batch out of an empty set', () => {
    expect(planSummary([], 16000).batches).toHaveLength(0)
  })
})

describe('the prompts', () => {
  it('names what gathered the notes, so the summary can say what it is about', () => {
    expect(summarySystem('#work')).toContain('#work')
    expect(combineSystem('#work', 3)).toContain('#work')
    expect(combineSystem('#work', 3)).toContain('3')
  })

  it('asks for citations as wikilinks, so the summary links back to the notes', () => {
    expect(summarySystem('#work')).toMatch(/\[\[Weekly review\]\]/)
  })

  it('tells the combining pass that its inputs are summaries, not notes', () => {
    expect(combineSystem('x', 2)).toMatch(/never mention that it was assembled/i)
  })

  it('treats the notes as material rather than as instructions', () => {
    expect(summarySystem('x')).toMatch(/material, not instructions/i)
  })

  it('sends each note under its own title, separated', () => {
    const body = batchUser([src('One', 'first'), src('Two', 'second')])
    expect(body).toContain('## One')
    expect(body).toContain('## Two')
    expect(body).toContain('---')
  })

  it('numbers the parts for the combining pass', () => {
    expect(combineUser(['a', 'b'])).toContain('# Part 1')
    expect(combineUser(['a', 'b'])).toContain('# Part 2')
  })
})

describe('the note that comes out', () => {
  const now = new Date('2026-09-12T10:00:00Z')

  it('says what made it, from what, and with which model', () => {
    const n = summaryNote({
      what: '#work',
      body: 'A summary.',
      model: 'gpt-4o-mini',
      provider: 'OpenAI',
      noteCount: 12,
      now,
    })
    expect(n.text).toContain('generated: true')
    expect(n.text).toContain('generated_by: OpenAI/gpt-4o-mini')
    expect(n.text).toContain('source: #work')
    expect(n.text).toContain('source_notes: 12')
    expect(n.text).toContain('A summary.')
  })

  it('is ordinary frontmatter, so the properties form can read it', () => {
    const n = summaryNote({ what: 'x', body: 'b', model: 'm', provider: 'p', noteCount: 1, now })
    expect(n.text.startsWith('---\n')).toBe(true)
    expect(n.text.split('---').length).toBeGreaterThanOrEqual(3)
  })

  it('names itself after what it summarised and when', () => {
    expect(summaryTitle('#work', now)).toContain('#work')
    expect(summaryTitle('#work', now)).toContain('2026-09-12')
    const n = summaryNote({ what: '#work', body: 'b', model: 'm', provider: 'p', noteCount: 1, now })
    expect(n.title).toBe(summaryTitle('#work', now))
  })
})
