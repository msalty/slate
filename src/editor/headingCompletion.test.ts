// @vitest-environment jsdom
/**
 * `[[Note#` — the headings of the note being linked to.
 *
 * The `#` is the same statement the `|` is: the note has been named, and what
 * is being named now is a place inside it. So the list stops being about notes
 * and becomes about headings, and the interesting cases are the seams — which
 * note's headings, read from where, and what happens to the text already typed
 * when one is accepted.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

type Completion = typeof import('./completion')

let seq = 0
let complete: Completion['wikiCompletion']

/** A vault holding one note with a shape worth navigating. */
async function freshVault(): Promise<void> {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = `slate-headings-${++seq}`
  const vault = await import('../core/vault')
  await vault.initVault()
  await vault.createNote(
    '',
    'Trip',
    [
      '# Trip',
      '',
      'Booked.',
      '',
      '## Costs',
      '',
      '### Flights',
      '',
      '### Hotel',
      '',
      '```bash',
      '# not a heading',
      '```',
      '',
      '#travel',
      '',
      '## Packing',
      '',
      // Two headings a wikilink has no way to name — see the tests below.
      '## Revenue | costs',
      '',
      '## Status [draft]',
      '',
    ].join('\n'),
  )
  ;({ wikiCompletion: complete } = await import('./completion'))
}

/** What the completion offers for a document with the caret at its end. */
function at(doc: string) {
  return complete(new CompletionContext(EditorState.create({ doc }), doc.length, false))
}

const labels = (doc: string) => at(doc)?.options.map((o) => o.label)

describe('completing a heading in another note', () => {
  beforeEach(freshVault)

  it('offers that note’s headings once the # is typed, in the order they appear', () => {
    expect(labels('See [[Trip#')).toEqual(['Trip', 'Costs', 'Flights', 'Hotel', 'Packing'])
  })

  /*
   * Boosts are integers in -99..99, and the note scores they are normally made
   * from run into the thousands — so a tiebreak expressed as a fraction of one
   * rounded to nothing, and CodeMirror sorted the labels alphabetically
   * instead. An outline in alphabetical order is not an outline.
   */
  it('ranks an unfiltered outline by position and not by the alphabet', () => {
    const boosts = at('See [[Trip#')?.options.map((o) => o.boost) ?? []
    expect(boosts).toHaveLength(5)
    expect(boosts.every((b, i) => i === 0 || b! < boosts[i - 1]!)).toBe(true)
  })

  it('still puts a better match above an earlier one', () => {
    // "Packing" is last in the note and the only thing that matches; nothing
    // about its position should stop it being the answer.
    expect(labels('See [[Trip#pack')).toEqual(['Packing'])
  })

  it('leaves out what is not a heading, the way the outline does', () => {
    const l = labels('See [[Trip#') ?? []
    expect(l).not.toContain('not a heading')
    expect(l).not.toContain('travel')
  })

  it('narrows on the words as they are typed', () => {
    expect(labels('See [[Trip#fli')).toEqual(['Flights'])
    // Initials reach it too, the same as they reach a note's title.
    expect(labels('See [[Trip#hot')).toEqual(['Hotel'])
  })

  it('says which section each one sits under, since a list cannot indent', () => {
    const by = new Map(at('See [[Trip#')?.options.map((o) => [o.label, o.detail]))
    expect(by.get('Flights')).toBe('Costs')
    expect(by.get('Costs')).toBe('Trip')
    // The top-level heading is under nothing, and says nothing.
    expect(by.get('Trip')).toBeUndefined()
  })

  it('anchors the list after the #, so the note half is never rewritten', () => {
    // Which is also what lets the completion filter on the heading alone as it
    // is typed: from here, the text is the heading and not "Trip#fli".
    expect(at('See [[Trip#fli')?.from).toBe('See [[Trip#'.length)
  })

  it('stays out of an embed, which cannot hold a section anyway', () => {
    // `![[Trip#Costs]]` embeds nothing — offering the headings there would be
    // completing somebody into a broken embed, and falling through to the note
    // list offered to create a note called "Trip#".
    expect(at('See ![[Trip#')).toBeNull()
  })

  it('says nothing for a note that is not there, and offers to create nothing', () => {
    // There are no headings to list, and "Nowhere#" is not a note anybody
    // meant to make — which is what the note list underneath used to offer.
    expect(at('See [[Nowhere#')).toBeNull()
  })

  /*
   * `[[Note#Anchor]]` ends its anchor at a `]` and splits it at a `|`, and
   * there is no escape for either — so a heading carrying one cannot be named
   * by a link at all. `[[#Revenue | costs]]` parses as the anchor "Revenue"
   * with the alias "costs", and `[[#Status [draft]]]` truncates to "Status
   * [draft". Both resolve to nothing.
   *
   * Offering them completed somebody into a link that could never work, which
   * is the same mistake as offering headings inside an embed. The outline
   * still reaches these headings — ⌘⇧O navigates rather than writing a link —
   * so what is lost is linking to them, which was never possible.
   */
  it('will not offer a heading no link could name', () => {
    const l = labels('See [[Trip#') ?? []
    expect(l).not.toContain('Revenue | costs')
    expect(l).not.toContain('Status [draft]')
    expect(l).toContain('Packing')
  })

  it('and says nothing at all when only those would have matched', () => {
    expect(at('See [[Trip#revenue')).toBeNull()
    expect(at('See [[Trip#status')).toBeNull()
  })

  it('goes back to notes once the # is gone', () => {
    expect(labels('See [[Tri')).toContain('Trip')
  })

  /*
   * The trap this whole feature turns on. While a completion result is valid,
   * CodeMirror re-filters it in place rather than asking the source again — so
   * with `#` allowed through, typing it kept the *note* list alive, filtered it
   * to nothing, and `[[Trip#` showed an empty list.
   */
  it('lets the # invalidate the note list, or the headings never get asked for', () => {
    const validFor = at('See [[Tri')?.validFor as RegExp
    expect(validFor.test('Trip')).toBe(true)
    expect(validFor.test('Trip#')).toBe(false)
  })
})

describe('completing a heading in this note', () => {
  beforeEach(freshVault)

  it('offers the headings of the note being typed in', () => {
    expect(labels('# Here\n\n## Costs\n\n## Packing\n\nSee [[#')).toEqual(['Here', 'Costs', 'Packing'])
  })

  it('reads them off the buffer, so one typed a moment ago is offerable', () => {
    // The vault has never seen this heading — that is the point. Linking to
    // the section you are in the middle of writing is the common case.
    expect(labels('## Just typed\n\nSee [[#just')).toEqual(['Just typed'])
  })
})

describe('accepting one', () => {
  beforeEach(freshVault)

  /** Accept the first option and hand back the document it produced. */
  function accept(doc: string): string {
    const view = new EditorView({ state: EditorState.create({ doc, selection: { anchor: doc.length } }) })
    try {
      const result = at(doc)!
      const option = result.options[0]
      ;(option.apply as (v: EditorView, c: unknown, f: number, t: number) => void)(
        view,
        option,
        result.from,
        doc.length,
      )
      return view.state.doc.toString()
    } finally {
      view.destroy()
    }
  }

  it('writes the heading and closes the link, keeping the note as typed', () => {
    expect(accept('See [[Trip#fli')).toBe('See [[Trip#Flights]]')
    // Lower case, as somebody would actually type it — and left that way.
    expect(accept('See [[trip#fli')).toBe('See [[trip#Flights]]')
  })

  it('absorbs the brackets that were auto-inserted with the [[', () => {
    const view = new EditorView({
      state: EditorState.create({ doc: 'See [[Trip#fli]]', selection: { anchor: 'See [[Trip#fli'.length } }),
    })
    try {
      const result = complete(new CompletionContext(view.state, 'See [[Trip#fli'.length, false))!
      const option = result.options[0]
      ;(option.apply as (v: EditorView, c: unknown, f: number, t: number) => void)(
        view,
        option,
        result.from,
        'See [[Trip#fli'.length,
      )
      expect(view.state.doc.toString()).toBe('See [[Trip#Flights]]')
    } finally {
      view.destroy()
    }
  })

  it('writes a bare anchor for a heading in this note', () => {
    expect(accept('## Costs\n\nSee [[#cos')).toBe('## Costs\n\nSee [[#Costs]]')
  })
})
