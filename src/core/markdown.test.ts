import { describe, expect, it } from 'vitest'
import {
  calendarDateFor,
  excerptOf,
  findDue,
  isTaskLine,
  parseDue,
  parseFrontmatter,
  scanTags,
  scanTasks,
  scanWikiLinks,
  setFrontmatterKey,
  splitSizeFragment,
  stripInline,
  withDue,
} from './markdown'
import { safeSegment, startOfDay } from './util'

describe('frontmatter', () => {
  it('parses scalars, inline lists and block lists', () => {
    const fm = parseFrontmatter(
      ['---', 'title: Trip', 'pinned: true', 'tags: [travel, lisbon]', 'people:', '  - Ana', '  - Bo', '---', '', 'Body'].join('\n'),
    )
    expect(fm.data.title).toBe('Trip')
    expect(fm.data.pinned).toBe(true)
    expect(fm.data.tags).toEqual(['travel', 'lisbon'])
    expect(fm.data.people).toEqual(['Ana', 'Bo'])
    expect(fm.bodyStart).toBeGreaterThan(0)
  })

  it('ignores a --- that is not at the very start', () => {
    const fm = parseFrontmatter('Some text\n---\ntitle: no\n---\n')
    expect(fm.data.title).toBeUndefined()
    expect(fm.bodyStart).toBe(0)
  })

  it('round-trips a key without disturbing the body', () => {
    const doc = '---\ntitle: A\n---\n\nBody text\n'
    const out = setFrontmatterKey(doc, 'pinned', 'true')
    expect(out).toContain('pinned: true')
    expect(out).toContain('title: A')
    expect(out.endsWith('Body text\n')).toBe(true)
  })

  it('adds a block when the note has none', () => {
    const out = setFrontmatterKey('Just a body', 'pinned', 'true')
    expect(out.startsWith('---\npinned: true\n---')).toBe(true)
    expect(out).toContain('Just a body')
  })
})

describe('wikilinks', () => {
  it('finds plain links, aliases, anchors and embeds', () => {
    const links = scanWikiLinks('See [[Meeting Notes]] and [[Trip#Hotels|hotels]] plus ![[shot.png]]')
    expect(links).toHaveLength(3)
    expect(links[0].target).toBe('Meeting Notes')
    expect(links[1].target).toBe('Trip')
    expect(links[1].anchor).toBe('Hotels')
    expect(links[1].alias).toBe('hotels')
    expect(links[2].embed).toBe(true)
  })

  it('ignores links inside fenced and inline code', () => {
    const doc = ['Real [[One]]', '', '```', 'not [[Two]]', '```', '', 'also `[[Three]]` inline'].join('\n')
    const targets = scanWikiLinks(doc).map((l) => l.target)
    expect(targets).toEqual(['One'])
  })
})

describe('tags', () => {
  it('finds tags but not headings or code', () => {
    const doc = ['# Heading', 'Body with #travel and #work/active', '`#nope`', '', '```', '#alsonope', '```'].join('\n')
    const tags = scanTags(doc)
    expect(tags).toContain('travel')
    expect(tags).toContain('work/active')
    expect(tags).not.toContain('nope')
    expect(tags).not.toContain('alsonope')
    expect(tags).not.toContain('Heading')
  })
})

describe('tasks', () => {
  it('finds checked and unchecked items with due dates', () => {
    const doc = [
      '- [ ] Book flights 📅 2026-09-04',
      '- [x] Renew passport',
      '  - [ ] Nested @due(2026-10-01)',
      '1. [ ] Numbered item',
      '- not a task',
    ].join('\n')
    const tasks = scanTasks(doc)
    expect(tasks).toHaveLength(4)
    expect(tasks[0].done).toBe(false)
    expect(tasks[0].due).toBe(startOfDay(new Date(2026, 8, 4)))
    expect(tasks[1].done).toBe(true)
    expect(tasks[2].due).toBe(startOfDay(new Date(2026, 9, 1)))
    expect(tasks[3].text).toBe('Numbered item')
  })

  it('parses every supported due-date syntax', () => {
    expect(parseDue('do it 📅 2026-01-05')).toBeDefined()
    expect(parseDue('do it @due(2026-01-05)')).toBeDefined()
    expect(parseDue('do it due:2026-01-05')).toBeDefined()
    expect(parseDue('no date here')).toBeUndefined()
  })

  it('reads dates as local midnight, not UTC', () => {
    const t = parseDue('📅 2026-03-01')!
    expect(new Date(t).getDate()).toBe(1)
    expect(new Date(t).getMonth()).toBe(2)
  })

  it('reads the Dataview form too', () => {
    expect(parseDue('do it [due:: 2026-01-05]')).toBe(startOfDay(new Date(2026, 0, 5)))
  })

  it('reports where the marker sits, so the editor can replace just that', () => {
    const line = '- [ ] Book flights 📅 2026-09-04'
    const m = findDue(line)!
    expect(line.slice(m.from, m.to)).toBe('📅 2026-09-04')
    expect(m.date).toBe(startOfDay(new Date(2026, 8, 4)))
  })

  it('recognizes task lines and nothing else', () => {
    expect(isTaskLine('- [ ] a')).toBe(true)
    expect(isTaskLine('  1. [x] a')).toBe(true)
    expect(isTaskLine('- a')).toBe(false)
    expect(isTaskLine('[ ] a')).toBe(false)
  })
})

describe('withDue', () => {
  const sep = startOfDay(new Date(2026, 8, 4))

  it('appends a date to a task that has none', () => {
    expect(withDue('- [ ] Book flights', sep)).toBe('- [ ] Book flights 📅 2026-09-04')
  })

  it('replaces a date rather than accumulating one', () => {
    expect(withDue('- [ ] Book flights 📅 2026-01-01', sep)).toBe(
      '- [ ] Book flights 📅 2026-09-04',
    )
  })

  it('replaces a date written in any of the other syntaxes', () => {
    expect(withDue('- [ ] Renew @due(2026-01-01)', sep)).toBe('- [ ] Renew 📅 2026-09-04')
    expect(withDue('- [ ] Renew due:2026-01-01', sep)).toBe('- [ ] Renew 📅 2026-09-04')
    expect(withDue('- [ ] Renew [due:: 2026-01-01]', sep)).toBe('- [ ] Renew 📅 2026-09-04')
  })

  it('clears a date, and the space it was sitting on', () => {
    expect(withDue('- [ ] Book flights 📅 2026-09-04', undefined)).toBe('- [ ] Book flights')
    expect(withDue('- [ ] Book flights', undefined)).toBe('- [ ] Book flights')
  })

  it('leaves the rest of the line — indent, marker, tags — alone', () => {
    expect(withDue('  - [x] Ship it #work', sep)).toBe('  - [x] Ship it #work 📅 2026-09-04')
  })

  it('collapses a second stray marker instead of leaving it behind', () => {
    expect(withDue('- [ ] Odd 📅 2026-01-01 @due(2026-02-02)', sep)).toBe(
      '- [ ] Odd 📅 2026-09-04',
    )
  })

  it('handles a task with no text at all', () => {
    expect(withDue('- [ ] ', sep)).toBe('- [ ] 📅 2026-09-04')
    expect(withDue('- [ ]', sep)).toBe('- [ ] 📅 2026-09-04')
  })

  it('round-trips: what it writes, parseDue reads back', () => {
    expect(parseDue(withDue('- [ ] Anything', sep))).toBe(sep)
  })
})

describe('stripInline', () => {
  it('drops every due syntax from display text', () => {
    expect(stripInline('Book flights 📅 2026-09-04')).toBe('Book flights')
    expect(stripInline('Book flights [due:: 2026-09-04]')).toBe('Book flights')
  })
})

describe('excerpt', () => {
  it('skips headings and rules, and strips markup', () => {
    const doc = '# Title\n\n---\n\n**Bold** start with [[Link|alias]] here.'
    expect(excerptOf(doc)).toBe('Bold start with alias here.')
  })

  it('returns empty for a note with only a heading', () => {
    expect(excerptOf('# Only a title')).toBe('')
  })

  /*
   * A note that opens with a callout — which is how several of the starter
   * templates open — otherwise reads out its own punctuation in the list:
   * "[!NOTE] In one line".
   */
  it('reads a callout for what it says, not for its marker', () => {
    expect(excerptOf('# Ana Ruiz\n\n> [!NOTE] In one line\n> How you would introduce them.')).toBe(
      'In one line',
    )
    // A callout with no title of its own falls through to its first words.
    expect(excerptOf('# Ana Ruiz\n\n> [!NOTE]\n> How you would introduce them.')).toBe(
      'How you would introduce them.',
    )
  })
})

describe('calendar date', () => {
  it('prefers frontmatter, then a dated filename, then ctime', () => {
    const ct = startOfDay(new Date(2026, 0, 15))
    expect(calendarDateFor('a.md', { date: '2026-05-02' }, ct)).toBe(startOfDay(new Date(2026, 4, 2)))
    expect(calendarDateFor('Daily/2026-06-09.md', {}, ct)).toBe(startOfDay(new Date(2026, 5, 9)))
    expect(calendarDateFor('a.md', {}, ct)).toBe(ct)
  })
})

describe('paths and sizing', () => {
  it('strips characters that break on Windows or WebDAV', () => {
    expect(safeSegment('Q1: profit/loss?')).not.toMatch(/[:/?]/)
    expect(safeSegment('  ')).toBe('Untitled')
    expect(safeSegment('trailing.')).toBe('trailing')
    expect(safeSegment('CON')).toBe('_CON')
  })

  it('splits a width fragment off an embed URL', () => {
    expect(splitSizeFragment('a/b.png#w=420')).toEqual(['a/b.png', 420])
    expect(splitSizeFragment('a/b.png')).toEqual(['a/b.png', undefined])
  })
})
