/**
 * Splitting a search box into a rule and the words around it.
 *
 * The load-bearing test is the first one: a query with no rule terms in it has
 * to come out the way it went in. Everything else here is a feature; that one
 * is every search anybody has ever typed into this box.
 */

import { describe, expect, it } from 'vitest'
import { parseSearch } from './searchquery'
import { describeQuery } from './tagquery'

describe('a query with no rule in it', () => {
  it('is all text and no rule', () => {
    const q = parseSearch('quarterly budget')
    expect(q.text).toBe('quarterly budget')
    expect(q.rule).toBe('')
    expect(q.node).toBeUndefined()
    expect(q.error).toBeUndefined()
  })

  it('keeps brackets, dashes and colons that are only punctuation', () => {
    for (const src of [
      'budget (2024)',
      're-open the roof question',
      'http://example.com/thing',
      'ratio 3:1',
      '-draft',
    ]) {
      expect(parseSearch(src)).toMatchObject({ text: src, rule: '' })
    }
  })

  it('leaves a lone # or a bare - alone rather than erroring on it', () => {
    // Both are things a half-typed query looks like, and neither is a rule.
    expect(parseSearch('#')).toMatchObject({ text: '#', rule: '' })
    expect(parseSearch('- ')).toMatchObject({ text: '-', rule: '' })
  })
})

describe('lifting the rule out', () => {
  it('takes a tag and leaves the words', () => {
    const q = parseSearch('#work budget')
    expect(q.rule).toBe('#work')
    expect(q.text).toBe('budget')
    expect(describeQuery(q.node!)).toBe('#work')
  })

  it('does not care where in the line the rule sits', () => {
    expect(parseSearch('budget #work')).toMatchObject({ rule: '#work', text: 'budget' })
    expect(parseSearch('the #work budget for #q3')).toMatchObject({
      rule: '#work #q3',
      text: 'the budget for',
    })
  })

  it('takes every key the rule language knows', () => {
    for (const term of [
      'folder:Clients',
      'in:Clients',
      'tag:work',
      'has:tasks',
      'is:open',
      'due:overdue',
    ]) {
      expect(parseSearch(`${term} roof`)).toMatchObject({ rule: term, text: 'roof' })
    }
  })

  it('reads a key with a quoted value as one term', () => {
    const q = parseSearch('folder:"Client work" invoice')
    expect(q.rule).toBe('folder:"Client work"')
    expect(q.text).toBe('invoice')
    expect(describeQuery(q.node!)).toBe('in Client work')
  })

  it('carries a negation with the term it negates', () => {
    expect(describeQuery(parseSearch('-#done roof').node!)).toBe('not #done')
    expect(describeQuery(parseSearch('!#done roof').node!)).toBe('not #done')
    expect(describeQuery(parseSearch('NOT #done roof').node!)).toBe('not #done')
    expect(parseSearch('-#done roof').text).toBe('roof')
  })

  it('ANDs separate terms, which is what adjacency already means', () => {
    const q = parseSearch('#work folder:Clients -#done invoice')
    expect(describeQuery(q.node!)).toBe('(#work and in Clients) and not #done')
    expect(q.text).toBe('invoice')
  })

  it('keeps an explicit OR with the terms on both sides of it', () => {
    const q = parseSearch('#work OR #home budget')
    expect(q.rule).toBe('#work OR #home')
    expect(describeQuery(q.node!)).toBe('#work or #home')
    expect(q.text).toBe('budget')
  })

  it('takes a parenthesised group whole', () => {
    const q = parseSearch('(#work OR #home) -#done roof')
    expect(describeQuery(q.node!)).toBe('(#work or #home) and not #done')
    expect(q.text).toBe('roof')
  })

  it('leaves brackets round words alone, however rule-shaped they look', () => {
    // "(budget OR tax)" is two words and an operator between them; reading it
    // as a rule would be inventing tags nobody has.
    expect(parseSearch('(budget OR tax)')).toMatchObject({ rule: '', text: '(budget OR tax)' })
  })

  it('does not strand an operator with nothing after it', () => {
    // The OR here joins a tag to a word, so it is not part of the rule at all.
    const q = parseSearch('#work OR budget')
    expect(q.rule).toBe('#work')
    expect(q.text).toBe('OR budget')
  })

  it('drops an operator left dangling at the end, mid-typing', () => {
    // One keystroke before "#work OR #home", and searching for the letters
    // "or" in the meantime would match most of the vault.
    expect(parseSearch('#work OR')).toMatchObject({ rule: '#work', text: '' })
    expect(parseSearch('#work AND')).toMatchObject({ rule: '#work', text: '' })
    // Only behind a rule: these are two ordinary words somebody is typing.
    expect(parseSearch('budget or')).toMatchObject({ rule: '', text: 'budget or' })
  })
})

describe('a rule with nothing to search for', () => {
  it('is a rule and an empty text half', () => {
    const q = parseSearch('#work')
    expect(q.rule).toBe('#work')
    expect(q.text).toBe('')
    expect(q.node).toBeDefined()
  })
})

describe('a rule that does not parse', () => {
  it('names the problem and hands the whole query back as text', () => {
    const q = parseSearch('is:maybe roof')
    expect(q.error).toBeTruthy()
    expect(q.node).toBeUndefined()
    // Nothing is filtered by a rule that was not understood, and nothing is
    // quietly filtered by half of one either.
    expect(q.text).toBe('is:maybe roof')
  })

  it('points at where the problem is', () => {
    const q = parseSearch('has:nothing')
    expect(q.error).toBeTruthy()
    expect(q.at).toBe(0)
  })
})
