/**
 * The parts of a rewrite that decide whether it is safe to put in a note.
 *
 * `stillMatches` is the one with teeth. Everything else here shapes a prompt or
 * decides what to show; that function is what stands between "a sync landed
 * while the dialog was open" and a rewrite pasted over the wrong paragraph.
 */

import { describe, expect, it } from 'vitest'
import {
  cleanTransformed,
  stillMatches,
  transformSystem,
  transformUser,
  TRANSFORMS,
  verdict,
} from './transform'

describe('the presets', () => {
  it('all have a distinct id, a label and something to hint with', () => {
    const ids = TRANSFORMS.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const t of TRANSFORMS) {
      expect(t.label.length, t.id).toBeGreaterThan(0)
      expect(t.hint.length, t.id).toBeGreaterThan(0)
      expect(t.instruction.length, t.id).toBeGreaterThan(20)
    }
  })
})

describe('the prompt', () => {
  it('carries the task, and the rules that keep the answer substitutable', () => {
    const s = transformSystem('Make it shorter')
    expect(s).toContain('Make it shorter')
    expect(s).toMatch(/nothing else/i)
    expect(s).toMatch(/never invent/i)
  })

  it('says the passage is material rather than instructions', () => {
    // The one line standing between a note that happens to say "ignore the
    // above" and a model that does.
    expect(transformSystem('x')).toMatch(/not instructions to you/i)
  })

  it('sends the selection bare, with nothing wrapped round it', () => {
    expect(transformUser('- [ ] call the vet')).toBe('- [ ] call the vet')
  })
})

describe('cleaning the reply', () => {
  it('takes off a fence round the whole answer', () => {
    expect(cleanTransformed('```markdown\n| a | b |\n```')).toBe('| a | b |')
  })

  it('leaves a fence that is part of the answer', () => {
    const code = 'Run this:\n\n```sh\nls -la\n```'
    expect(cleanTransformed(code)).toBe(code)
  })

  it('leaves a preamble alone rather than guessing', () => {
    expect(cleanTransformed('Sure! Here you go:\n\nThe text')).toBe('Sure! Here you go:\n\nThe text')
  })
})

describe('whether a reply is worth offering', () => {
  it('calls an empty reply empty rather than proposing to delete the passage', () => {
    expect(verdict('some text', '')).toBe('empty')
    expect(verdict('some text', '   \n ')).toBe('empty')
  })

  it('calls an identical reply unchanged — a proofread that found nothing', () => {
    expect(verdict('No errors here.', 'No errors here.')).toBe('unchanged')
    expect(verdict('No errors here.', '  No errors here.\n')).toBe('unchanged')
  })

  it('passes a real change through', () => {
    expect(verdict('teh cat', 'the cat')).toBe('ok')
  })
})

describe('the range is still the range', () => {
  const doc = 'One\nTwo\nThree\n'

  it('agrees when nothing has moved', () => {
    expect(stillMatches(doc, 4, 7, 'Two')).toBe(true)
  })

  it('refuses when the text at those offsets is now something else', () => {
    // What a sync pull landing mid-dialog looks like: same offsets, other words.
    const pulled = 'One\nZZZ\nThree\n'
    expect(stillMatches(pulled, 4, 7, 'Two')).toBe(false)
  })

  it('refuses when the note got shorter than the range', () => {
    expect(stillMatches('One\n', 4, 7, 'Two')).toBe(false)
  })

  it('refuses when an insertion above pushed the passage along', () => {
    const grown = 'Zero\nOne\nTwo\nThree\n'
    expect(stillMatches(grown, 4, 7, 'Two')).toBe(false)
  })
})
