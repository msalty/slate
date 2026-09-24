/**
 * Reading and writing the inside of a wikilink.
 *
 * The contract is one sentence: whatever `formatWikiLink` writes, every reader
 * reads back as exactly the parts it was given. A note called `C# Notes`
 * could not be linked to before this — `[[C# Notes]]` is the note `C` and its
 * heading `Notes` — and renaming a note to such a name turned every link to it
 * into a link to somewhere else.
 */

import { describe, expect, it } from 'vitest'
import { markdown } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { scanWikiLinks, stripInline } from './markdown'
import { escapePositions, formatWikiLink, splitWikiInner, unescapeWiki } from './wikilink'
import { pinsOf, pinTitle, withPins } from './ask'
import { WikiLink } from '../editor/wikilink-syntax'

/* Everything that has caught a link out, or could. */
const TARGETS = [
  'Plain',
  'C# Notes',
  'A]B',
  'Ends with ]',
  'x|y',
  'Status [draft]',
  'Work/C# Notes',
  'a\\b',
  'a\\#b',
  'trailing \\',
  '#leading',
]
const ANCHORS = [undefined, 'Costs', 'C# bindings', 'Revenue | costs', 'Status [draft]', 'a\\b']
const ALIASES = [
  undefined,
  'shown text',
  '',
  'Status [draft]',
  'ends with ]',
  'a\\b',
  'a\\#b',
  'trailing \\',
  'a|b|c',
  '#not a heading',
]

describe('a link written by formatWikiLink', () => {
  it('reads back as exactly the parts it was given, for every awkward name', () => {
    for (const target of TARGETS) {
      for (const anchor of ANCHORS) {
        for (const alias of ALIASES) {
          for (const embed of [false, true]) {
            const link = formatWikiLink({ target, anchor, alias, embed })
            const [read] = scanWikiLinks(`before ${link} after`)
            expect(read, link).toBeDefined()
            expect(read.target, link).toBe(target)
            expect(read.anchor, link).toBe(anchor)
            expect(read.alias, link).toBe(alias)
            expect(read.embed, link).toBe(embed)
          }
        }
      }
    }
  })

  it('keeps display text with a ] in it inside the link', () => {
    // Was `[[Plan|Status [draft]]]`: display text `Status [draft`, and a `]` left over.
    const link = formatWikiLink({ target: 'Plan', alias: 'Status [draft]' })
    expect(link).toBe('[[Plan|Status [draft\\]]]')
    const text = `see ${link} after`
    const [read] = scanWikiLinks(text)
    expect(read.alias).toBe('Status [draft]')
    expect(text.slice(read.to)).toBe(' after')
  })

  it('is one link, ending where it should, however many brackets are in it', () => {
    const text = `${formatWikiLink({ target: 'Ends with ]' })} and ${formatWikiLink({ target: 'Plain' })}`
    expect(scanWikiLinks(text).map((l) => l.target)).toEqual(['Ends with ]', 'Plain'])
  })

  it('is found whole by the editor’s grammar too', () => {
    // The one reader that finds the end of a link character by character.
    const doc = `see ${formatWikiLink({ target: 'Ends with ]' })} and ${formatWikiLink({ target: 'A]B' })}`
    const state = EditorState.create({ doc, extensions: markdown({ extensions: [WikiLink] }) })
    const found: string[] = []
    syntaxTree(state).iterate({
      enter: (n) => {
        if (n.name === 'WikiLink') found.push(splitWikiInner(doc.slice(n.from + 2, n.to - 2)).target)
      },
    })
    expect(found).toEqual(['Ends with ]', 'A]B'])
  })
})

describe('what live preview hides', () => {
  const unhidden = (written: string) => {
    const hide = new Set(escapePositions(written))
    return [...written].filter((_, i) => !hide.has(i)).join('')
  }

  it('is exactly the backslashes unescaping removes, so the link reads as its name', () => {
    for (const target of TARGETS) {
      const written = formatWikiLink({ target }).slice(2, -2)
      expect(unhidden(written), written).toBe(unescapeWiki(written))
      expect(unhidden(written), written).toBe(target)
    }
  })

  it('and as its display text, when it has some', () => {
    for (const alias of ALIASES) {
      if (alias === undefined) continue
      const inner = formatWikiLink({ target: 'Plan', alias }).slice(2, -2)
      // What is shown is everything after the first `|` that is not an escape.
      const written = inner.slice(inner.indexOf('|') + 1)
      expect(unhidden(written), inner).toBe(alias)
    }
  })
})

describe('links written before there was an escape', () => {
  it('mean what they always meant', () => {
    const read = (s: string) => scanWikiLinks(s)[0]
    expect(read('[[Note#Heading]]')).toMatchObject({ target: 'Note', anchor: 'Heading' })
    // A `#` inside the heading is the heading's.
    expect(read('[[Notes#C# bindings]]')).toMatchObject({ target: 'Notes', anchor: 'C# bindings' })
    expect(read('[[#Costs]]')).toMatchObject({ target: '', anchor: 'Costs' })
    expect(read('[[Note|shown]]')).toMatchObject({ target: 'Note', alias: 'shown' })
    expect(read('![[img.png|400]]')).toMatchObject({ target: 'img.png', alias: '400', embed: true })
    // A backslash in front of anything but `\ # | ]` is only a backslash.
    expect(read('[[Some\\Thing]]')).toMatchObject({ target: 'Some\\Thing' })
    // And the bare `#` still starts a heading: this is the note `C`.
    expect(read('[[C# Notes]]')).toMatchObject({ target: 'C', anchor: 'Notes' })
  })

  it('and still are not links when they never were', () => {
    expect(scanWikiLinks('[[]] and [[|alias]]')).toEqual([])
  })
})

describe('everything else that reads one', () => {
  it('shows an escaped name as the name, in excerpts and task rows', () => {
    expect(stripInline('see [[C\\# Notes]] and [[A\\]B|the other one]]')).toBe(
      'see C# Notes and the other one',
    )
  })

  it('pins the note it names, not the note in front of the #', () => {
    expect(pinTitle('[[C\\# Notes]]')).toBe('C# Notes')
    // Written by the pinning code itself, and read back the same.
    const text = withPins('# Chat\n', ['C# Notes', 'Status [draft]'])
    expect(pinsOf(text)).toEqual(['C# Notes', 'Status [draft]'])
  })
})
