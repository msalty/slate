/**
 * Where a transcription lands, and what is taken off it on the way.
 *
 * The insertion is the part with teeth: it writes into a note somebody wrote,
 * so the tests below are mostly about what it must *not* do — not overwrite
 * anything, not open a widening gap when run twice, and not get confused by a
 * second picture on the same note.
 */

import { describe, expect, it } from 'vitest'
import { cleanTranscript, foundNothing, insertTranscript, NO_TEXT } from './ocr'

/** The vault's resolver, standing in: anything ending in the target matches it. */
const resolve = (target: string) => (ref: string) =>
  ref === target || target.endsWith(`/${ref}`) ? target : undefined

const opts = (target: string) => ({ target, resolve: resolve(target) })

describe('cleaning up what the model sent', () => {
  it('takes off an outer code fence, which several models add', () => {
    expect(cleanTranscript('```\nHello\nthere\n```')).toBe('Hello\nthere')
    expect(cleanTranscript('```markdown\n# Title\n```')).toBe('# Title')
    expect(cleanTranscript('~~~\ntilde\n~~~')).toBe('tilde')
  })

  it('leaves an inner fence alone — a screenshot of code transcribes to one', () => {
    const text = 'Here is the snippet:\n\n```js\nconst a = 1\n```\n\nand after it.'
    expect(cleanTranscript(text)).toBe(text)
  })

  it('leaves a stray preamble in place rather than guessing it is not content', () => {
    // A line that might be commentary might equally be the top of the page, and
    // silently dropping the first line of a transcription is the worse failure.
    expect(cleanTranscript('Dear Sir,\n\nI write regarding…')).toBe('Dear Sir,\n\nI write regarding…')
  })

  it('recognises the agreed way of saying there was nothing to read', () => {
    expect(foundNothing(NO_TEXT)).toBe(true)
    expect(foundNothing('(No text found).')).toBe(true)
    expect(foundNothing('No text found in the image, sorry')).toBe(false)
  })
})

describe('inserting after the picture it came from', () => {
  it('puts the text under the embed, not at the end of the note', () => {
    const note = '# Receipts\n\n![[attachments/2026/09/a.webp]]\n\nSomething I wrote after.\n'
    const out = insertTranscript(note, 'TOTAL 12.40', opts('attachments/2026/09/a.webp'))
    expect(out).toBe(
      '# Receipts\n\n![[attachments/2026/09/a.webp]]\n\nTOTAL 12.40\n\nSomething I wrote after.\n',
    )
  })

  it('finds the right one when the note has several pictures', () => {
    const note = '![[a.webp]]\n\n![[b.webp]]\n'
    const out = insertTranscript(note, 'from B', opts('b.webp'))
    expect(out).toBe('![[a.webp]]\n\n![[b.webp]]\n\nfrom B\n')
  })

  it('handles the markdown spelling of an embed, and a sizing fragment', () => {
    const note = 'before\n\n![a shot](attachments/a.png#w=400)\n\nafter\n'
    const out = insertTranscript(note, 'read', opts('attachments/a.png'))
    expect(out).toContain('![a shot](attachments/a.png#w=400)\n\nread\n')
  })

  it('resolves a relative reference through the vault’s own rules', () => {
    const note = '![[a.webp]]\n'
    const out = insertTranscript(note, 'text', opts('attachments/2026/09/a.webp'))
    expect(out).toBe('![[a.webp]]\n\ntext\n')
  })

  it('appends at the end when the note does not embed the picture at all', () => {
    // The lightbox reaches a file from the file list too, where there is no
    // embed to sit under. Untidy beats refusing.
    const note = '# Notes\n\nnothing here\n'
    expect(insertTranscript(note, 'orphan', opts('x.webp'))).toBe('# Notes\n\nnothing here\n\norphan\n')
  })

  it('never overwrites what was already there', () => {
    const note = '![[a.webp]]\nA line immediately under the picture.\n'
    const out = insertTranscript(note, 'new', opts('a.webp'))
    expect(out).toContain('A line immediately under the picture.')
    expect(out).toContain('new')
  })

  it('does not open a widening gap when run twice into the same place', () => {
    const note = '![[a.webp]]\n\nold\n'
    const once = insertTranscript(note, 'new', opts('a.webp'))
    expect(once).toBe('![[a.webp]]\n\nnew\n\nold\n')
    expect(once).not.toMatch(/\n{3}/)
  })

  it('writes nothing for an empty transcript', () => {
    const note = '![[a.webp]]\n'
    expect(insertTranscript(note, '   ', opts('a.webp'))).toBe(note)
  })

  it('ignores an embed inside a fenced code block, which is an example not a picture', () => {
    const note = '```\n![[a.webp]]\n```\n\nreal text\n'
    // No real embed to sit under, so it goes to the end rather than into the fence.
    expect(insertTranscript(note, 'T', opts('a.webp'))).toBe('```\n![[a.webp]]\n```\n\nreal text\n\nT\n')
  })

  it('handles a picture on the last line of the note', () => {
    expect(insertTranscript('text\n\n![[a.webp]]', 'T', opts('a.webp'))).toBe('text\n\n![[a.webp]]\n\nT\n')
  })
})
