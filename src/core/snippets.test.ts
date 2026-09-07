/**
 * What counts as a snippet, and what a half-typed word reaches.
 *
 * The parser is the whole format — there is no schema and no editor, just a
 * note somebody typed — so the cases that matter are the ones a person writing
 * markdown by hand actually produces: prose above the first heading, a heading
 * they have not filled in yet, a stray blank line, a second copy of one they
 * are editing.
 */

import { describe, expect, it } from 'vitest'
import { matchSnippets, parseSnippets, previewOf } from './snippets'

const note = `# Snippets

Things I type too often.

## wiki
https://en.wikipedia.org/wiki/

## sig
Thanks,
Mike

## addr
123 Example St
`

describe('parseSnippets', () => {
  it('reads a heading as the trigger and what follows as the text', () => {
    expect(parseSnippets(note)).toEqual([
      { trigger: 'wiki', body: 'https://en.wikipedia.org/wiki/' },
      { trigger: 'sig', body: 'Thanks,\nMike' },
      { trigger: 'addr', body: '123 Example St' },
    ])
  })

  it('keeps the line breaks inside one, and trims the ones around it', () => {
    const [s] = parseSnippets('## sig\n\n\nThanks,\nMike\n\n\n')
    expect(s.body).toBe('Thanks,\nMike')
  })

  it('skips the prose above the first heading', () => {
    expect(parseSnippets('Just a note about nothing.\n')).toEqual([])
  })

  it('skips a heading with nothing under it yet', () => {
    expect(parseSnippets('## half\n\n## done\ntext\n').map((s) => s.trigger)).toEqual(['done'])
  })

  it('ignores headings that are not `##`, so the note can have a title', () => {
    expect(parseSnippets('# Snippets\ntext\n### deep\ntext\n')).toEqual([])
  })

  it('takes the later of two copies of the same trigger', () => {
    expect(parseSnippets('## sig\nold\n\n## sig\nnew\n')).toEqual([{ trigger: 'sig', body: 'new' }])
  })

  it('drops a trigger too short to be typed deliberately', () => {
    expect(parseSnippets('## a\ntext\n\n## ab\ntext\n').map((s) => s.trigger)).toEqual(['ab'])
  })

  it('has nothing to say about a note that is not there', () => {
    expect(parseSnippets('')).toEqual([])
  })
})

describe('previewOf', () => {
  it('shows the first line, and says when there is more', () => {
    expect(previewOf('one line')).toBe('one line')
    expect(previewOf('first\nsecond')).toBe('first…')
  })

  it('cuts a long one rather than filling the list with it', () => {
    expect(previewOf('x'.repeat(80))).toHaveLength(48)
  })
})

describe('matchSnippets', () => {
  it('needs enough typed to be deliberate', () => {
    expect(matchSnippets('')).toEqual([])
    expect(matchSnippets('w')).toEqual([])
  })
})
