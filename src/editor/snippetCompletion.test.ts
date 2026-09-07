/**
 * When a snippet is offered, and — mostly — when it is not.
 *
 * This is the only completion with no opening character of its own, so the
 * question it has to answer well is the negative one: a list that appears over
 * ordinary prose, or inside a link somebody is naming, is worse than no
 * feature. The cases below are the four ways it could go wrong.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'

type Completion = typeof import('./completion')

let seq = 0
let complete: Completion['snippetCompletion']

/**
 * A fresh vault, and the completion re-imported to read from it.
 *
 * The re-import is the point: the source closes over the snippets signal, so
 * a statically imported one would keep answering from whichever vault the
 * first test built.
 */
async function freshVault(snippetsNote?: string): Promise<void> {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = `slate-snippets-${++seq}`
  const vault = await import('../core/vault')
  await vault.initVault()
  if (snippetsNote !== undefined) await vault.createNote('', 'Snippets', snippetsNote)
  ;({ snippetCompletion: complete } = await import('./completion'))
}

/**
 * What the completion says about a document with the caret at its end.
 *
 * A bare state rather than the app's: this source reads the line in front of
 * the caret and nothing else, so the markdown parser and the whole extension
 * set would only be scenery.
 */
function at(doc: string) {
  return complete(new CompletionContext(EditorState.create({ doc }), doc.length, false))
}

describe('offering a snippet', () => {
  beforeEach(async () => {
    await freshVault('## wiki\nhttps://en.wikipedia.org/wiki/\n\n## sig\nThanks,\nMike\n')
  })

  it('offers one as soon as enough of its trigger is typed', () => {
    const result = at('See wik')
    expect(result?.options.map((o) => o.label)).toEqual(['wiki'])
    expect(result?.from).toBe('See '.length)
  })

  it('shows what it will insert, so the list says which is which', () => {
    expect(at('sig')?.options[0].detail).toBe('Thanks,…')
  })

  it('says nothing about a word that is not a trigger', () => {
    expect(at('See design')).toBeNull()
    expect(at('Some ordinary prose about nothing')).toBeNull()
  })

  it('does not fire on the tail of a longer word', () => {
    // "sig" is a trigger; "design" ends in it and is not.
    expect(at('design')).toBeNull()
  })

  it('leaves the other completions alone', () => {
    // A note, a file and a tag are being named. The marker is part of the run,
    // no trigger starts with one, so this source stays out of those lists.
    expect(at('[[wik')).toBeNull()
    expect(at('![[wik')).toBeNull()
    expect(at('#wik')).toBeNull()
  })

  it('takes punctuation glued to the front as part of the word', () => {
    // The cost of the one rule, and the right way round: a trigger is a thing
    // you type on its own.
    expect(at('("wik')).toBeNull()
  })
})

describe('a trigger that looks like a trigger', () => {
  beforeEach(async () => {
    await freshVault('## ;sig\nThanks,\nMike\n')
  })

  it('is reached by typing it, sigil and all', () => {
    const result = at('a ;si')
    expect(result?.options.map((o) => o.label)).toEqual([';sig'])
    // Replaced from the sigil, so accepting it leaves no stray punctuation.
    expect(result?.from).toBe('a '.length)
  })

  it('and is not reached by the word inside it', () => {
    expect(at('a si')).toBeNull()
  })
})

describe('a vault with no snippets note', () => {
  beforeEach(async () => {
    await freshVault()
  })

  it('offers nothing at all, which is the whole of the opt-in', () => {
    expect(at('wiki')).toBeNull()
    expect(at('anything')).toBeNull()
  })
})
