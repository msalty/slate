/**
 * Folding a change that arrived from elsewhere into a buffer someone is typing
 * in. The property under test is the sync engine's first rule, applied one
 * level up: no content disappears, whichever side it came from.
 */

import { describe, expect, it } from 'vitest'
import { minimalEdit, rebaseBuffer } from './rebase'

describe('rebaseBuffer', () => {
  it('takes the incoming text when the buffer has no unsaved edits', () => {
    const base = 'one\ntwo\n'
    const r = rebaseBuffer(base, base, 'one\ntwo\nthree\n')
    expect(r.text).toBe('one\ntwo\nthree\n')
    expect(r.changed).toBe(true)
    expect(r.conflicted).toBe(false)
  })

  it('does nothing when the buffer already holds the incoming text', () => {
    const r = rebaseBuffer('one\n', 'one\ntwo\n', 'one\ntwo\n')
    expect(r.changed).toBe(false)
    expect(r.text).toBe('one\ntwo\n')
  })

  it('leaves an ahead-of-the-vault buffer alone when nothing arrived', () => {
    const base = 'one\n'
    const r = rebaseBuffer(base, 'one\ntyping…', base)
    expect(r.changed).toBe(false)
    expect(r.text).toBe('one\ntyping…')
  })

  it('keeps unsaved keystrokes and the incoming edit when they do not overlap', () => {
    const base = 'title\n\nbody\n\nfooter\n'
    const r = rebaseBuffer(base, 'title\n\nbody, still typing\n\nfooter\n', 'title\n\nbody\n\nfooter\nsynced line\n')
    expect(r.conflicted).toBe(false)
    expect(r.text).toContain('still typing')
    expect(r.text).toContain('synced line')
  })

  it('marks both versions in place when they overlap, losing neither', () => {
    const base = 'Hotel: pending\n'
    const r = rebaseBuffer(base, 'Hotel: Chiado apartment\n', 'Hotel: Alfama guesthouse\n')
    expect(r.conflicted).toBe(true)
    expect(r.text).toContain('Chiado apartment')
    expect(r.text).toContain('Alfama guesthouse')
    expect(r.text).toContain('your unsaved edit')
  })
})

describe('minimalEdit', () => {
  it('reports nothing for identical text', () => {
    expect(minimalEdit('same', 'same')).toBeUndefined()
  })

  it('narrows to just the changed span, so the caret elsewhere does not move', () => {
    const a = 'alpha\nbravo\ncharlie\n'
    const b = 'alpha\nBRAVO\ncharlie\n'
    expect(minimalEdit(a, b)).toEqual({ from: 6, to: 11, insert: 'BRAVO' })
  })

  it('describes a pure insertion as an empty range', () => {
    const e = minimalEdit('ab', 'aXb')!
    expect(e.from).toBe(1)
    expect(e.to).toBe(1)
    expect(e.insert).toBe('X')
  })

  it('describes a pure deletion as an empty insert', () => {
    expect(minimalEdit('aXb', 'ab')).toEqual({ from: 1, to: 2, insert: '' })
  })

  it('round-trips: applying the edit reproduces the target', () => {
    const pairs: Array<[string, string]> = [
      ['', 'hello'],
      ['hello', ''],
      ['one\ntwo\n', 'one\ntwo\nthree\n'],
      ['aaa', 'aaaa'],
      ['abcabc', 'abc'],
      ['🎉 party\n', '🎈 party\n'],
      ['note 🎉\n', 'note 🎉🎈\n'],
    ]
    for (const [a, b] of pairs) {
      const e = minimalEdit(a, b)
      const applied = e ? a.slice(0, e.from) + e.insert + a.slice(e.to) : a
      expect(applied).toBe(b)
    }
  })

  it('never splits a surrogate pair', () => {
    const e = minimalEdit('🎉', '🎈')!
    // Both halves of the astral character are inside the replaced range.
    expect(e.from).toBe(0)
    expect(e.to).toBe(2)
    expect(e.insert).toBe('🎈')
  })
})
