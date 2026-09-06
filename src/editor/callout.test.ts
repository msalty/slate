/**
 * Callout parsing.
 *
 * Every assertion here is about a *line of markdown*, because that is what the
 * file holds — the styling is a consequence, and a note that leaves this app
 * has to still be an ordinary blockquote.
 */

import { describe, expect, it } from 'vitest'
import { ICONS, parseCallout, withCalloutFold } from './callout'

describe('recognition', () => {
  it('reads GitHub\'s five alert types', () => {
    for (const [name, kind] of [
      ['NOTE', 'note'],
      ['TIP', 'tip'],
      ['IMPORTANT', 'important'],
      ['WARNING', 'warning'],
      ['CAUTION', 'caution'],
    ] as const) {
      expect(parseCallout(`> [!${name}]`)?.spec.kind).toBe(kind)
    }
  })

  it('is case-insensitive', () => {
    expect(parseCallout('> [!note]')?.spec.kind).toBe('note')
    expect(parseCallout('> [!Note]')?.spec.kind).toBe('note')
    expect(parseCallout('> [!NoTe]')?.spec.kind).toBe('note')
  })

  it('aliases the wider vocabulary onto the five colours', () => {
    expect(parseCallout('> [!info]')?.spec.kind).toBe('note')
    expect(parseCallout('> [!success]')?.spec.kind).toBe('tip')
    expect(parseCallout('> [!question]')?.spec.kind).toBe('important')
    expect(parseCallout('> [!todo]')?.spec.kind).toBe('warning')
    expect(parseCallout('> [!bug]')?.spec.kind).toBe('caution')
  })

  it('keeps an alias\'s own glyph even though it shares a colour', () => {
    expect(parseCallout('> [!bug]')?.spec.icon).toBe('bug')
    expect(parseCallout('> [!caution]')?.spec.icon).toBe('caution')
    expect(parseCallout('> [!question]')?.spec.icon).toBe('question')
    expect(parseCallout('> [!important]')?.spec.icon).toBe('important')
  })

  it('has a drawable glyph for every type it accepts', () => {
    for (const name of ['note', 'info', 'abstract', 'example', 'quote', 'tip', 'success', 'important', 'question', 'warning', 'todo', 'caution', 'bug']) {
      const spec = parseCallout(`> [!${name}]`)?.spec
      expect(spec, name).toBeDefined()
      expect(ICONS[spec!.icon], name).toBeTruthy()
    }
  })

  /*
   * The whole point of leaning on GitHub's syntax: an unknown name is not a
   * broken callout, it is a blockquote — which is exactly what GitHub renders
   * and what every other tool has always rendered.
   */
  it('leaves an unknown type as an ordinary blockquote', () => {
    expect(parseCallout('> [!nonsense]')).toBeUndefined()
    expect(parseCallout('> [!]')).toBeUndefined()
    expect(parseCallout('> just a quote')).toBeUndefined()
    expect(parseCallout('[!note] not in a quote')).toBeUndefined()
  })
})

describe('the marker range', () => {
  const marker = (line: string) => {
    const c = parseCallout(line)!
    return line.slice(c.markerFrom, c.markerTo)
  }

  it('covers the marker and the one space after it', () => {
    expect(marker('> [!NOTE] Remember')).toBe('[!NOTE] ')
    // Nothing after it means nothing to swallow.
    expect(marker('> [!NOTE]')).toBe('[!NOTE]')
  })

  it('swallows only one space, so an indented title keeps its indent', () => {
    expect(marker('> [!NOTE]   Spaced')).toBe('[!NOTE] ')
  })

  it('takes Obsidian\'s fold character with it rather than leaving a dash', () => {
    expect(marker('> [!NOTE]- Folded')).toBe('[!NOTE]- ')
    expect(marker('> [!NOTE]+ Open')).toBe('[!NOTE]+ ')
  })

  it('starts after the quote markers, however many there are', () => {
    expect(marker('> > [!TIP] Nested')).toBe('[!TIP] ')
    expect(marker('>[!TIP] Tight')).toBe('[!TIP] ')
    expect(marker('  > [!TIP] Indented')).toBe('[!TIP] ')
  })
})

/*
 * The fold lives in the line, which is the only place it could live without
 * inventing state: a fold kept in the editor would be gone on reload, differ
 * between two windows onto the same note, and never reach another device.
 */
describe('the fold character', () => {
  it('reads Obsidian\'s two, and their absence', () => {
    expect(parseCallout('> [!NOTE]- Folded')?.fold).toBe('-')
    expect(parseCallout('> [!NOTE]+ Open')?.fold).toBe('+')
    expect(parseCallout('> [!NOTE] Plain')?.fold).toBe('')
  })

  it('points at where the character is, or would go', () => {
    const at = (line: string) => parseCallout(line)!.foldAt
    expect('> [!NOTE]- x'.slice(at('> [!NOTE]- x'))).toBe('- x')
    expect('> [!NOTE] x'.slice(at('> [!NOTE] x'))).toBe(' x')
  })

  it('folds a callout by writing the character in', () => {
    expect(withCalloutFold('> [!NOTE] Remember', '-')).toBe('> [!NOTE]- Remember')
    expect(withCalloutFold('> [!NOTE]+ Remember', '-')).toBe('> [!NOTE]- Remember')
    expect(withCalloutFold('> > [!TIP]', '-')).toBe('> > [!TIP]-')
  })

  /*
   * Unfolding removes the character rather than writing a `+`. A callout
   * nobody has folded and one somebody has unfolded are the same callout, and
   * a `+` would leave every callout ever collapsed marked for life.
   */
  it('unfolds by taking it out again', () => {
    expect(withCalloutFold('> [!NOTE]- Remember', '')).toBe('> [!NOTE] Remember')
    expect(withCalloutFold('> [!NOTE]+ Remember', '')).toBe('> [!NOTE] Remember')
  })

  it('leaves a line it cannot parse exactly as it found it', () => {
    expect(withCalloutFold('> [!nonsense] x', '-')).toBe('> [!nonsense] x')
    expect(withCalloutFold('plain text', '-')).toBe('plain text')
    // Already in the state asked for: not a rewrite, the same string.
    expect(withCalloutFold('> [!NOTE]- x', '-')).toBe('> [!NOTE]- x')
  })

  it('round-trips through both states', () => {
    const line = '> [!WARNING] Friday deploys'
    expect(withCalloutFold(withCalloutFold(line, '-'), '')).toBe(line)
  })
})

describe('the title', () => {
  it('is whatever follows the marker', () => {
    expect(parseCallout('> [!WARNING] Friday deploys')?.title).toBe('Friday deploys')
  })

  it('is empty when the author wrote none, so the type name can stand in', () => {
    expect(parseCallout('> [!WARNING]')?.title).toBe('')
    expect(parseCallout('> [!WARNING]   ')?.title).toBe('')
    expect(parseCallout('> [!WARNING]')?.spec.label).toBe('Warning')
  })
})
