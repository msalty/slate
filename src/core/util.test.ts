import { describe, expect, it } from 'vitest'
import {
  addDays,
  decodeLinkPath,
  dueLabel,
  encodeLinkPath,
  duePresets,
  dueTone,
  fitSegment,
  matchRanges,
  matchesAll,
  monthGrid,
  numberedFile,
  numberedSegment,
  safeSegment,
  searchTerms,
  startOfDay,
} from './util'

/** Local midnight for a plain "2026-09-02", without going via UTC. */
const day = (s: string) => startOfDay(new Date(`${s}T00:00:00`))

describe('addDays', () => {
  it('moves whole days and lands on midnight', () => {
    expect(addDays(day('2026-09-02'), 3)).toBe(day('2026-09-05'))
    expect(addDays(day('2026-09-02'), -3)).toBe(day('2026-08-30'))
  })

  it('crosses a month and a year end', () => {
    expect(addDays(day('2026-12-31'), 1)).toBe(day('2027-01-01'))
  })
})

describe('monthGrid', () => {
  it('starts on the Sunday of the first week and covers the month', () => {
    const g = monthGrid(day('2026-09-15'))
    expect(new Date(g[0]).getDay()).toBe(0)
    expect(g).toContain(day('2026-09-01'))
    expect(g).toContain(day('2026-09-30'))
    expect(g.length % 7).toBe(0)
  })

  it('trims a trailing week that belongs entirely to the next month', () => {
    // February 2027 starts on a Monday and has 28 days — five rows, not six.
    expect(monthGrid(day('2027-02-10'))).toHaveLength(35)
  })
})

describe('dueTone', () => {
  const today = day('2026-09-02')

  it('separates overdue, today, soon and later', () => {
    expect(dueTone(day('2026-09-01'), today)).toBe('over')
    expect(dueTone(today, today)).toBe('today')
    expect(dueTone(day('2026-09-04'), today)).toBe('soon')
    expect(dueTone(day('2026-09-05'), today)).toBe('later')
  })
})

describe('dueLabel', () => {
  const today = day('2026-09-02')

  it('uses words for the dates that have them', () => {
    expect(dueLabel(today, today)).toBe('Today')
    expect(dueLabel(day('2026-09-03'), today)).toBe('Tomorrow')
    expect(dueLabel(day('2026-09-01'), today)).toBe('Yesterday')
  })

  it('uses the weekday inside the coming week', () => {
    expect(dueLabel(day('2026-09-05'), today)).toBe('Sat')
  })

  it('falls back to a date, and only shows the year when it differs', () => {
    expect(dueLabel(day('2026-11-20'), today)).toBe('Nov 20')
    expect(dueLabel(day('2027-01-04'), today)).toMatch(/2027/)
  })
})

describe('duePresets', () => {
  it('offers today, tomorrow, the weekend and next week midweek', () => {
    const today = day('2026-09-02') // Wednesday
    expect(duePresets(today).map((p) => p.label)).toEqual([
      'Today',
      'Tomorrow',
      'This weekend',
      'Next week',
    ])
    const by = Object.fromEntries(duePresets(today).map((p) => [p.label, p.date]))
    expect(by['This weekend']).toBe(day('2026-09-05')) // the coming Saturday
    expect(by['Next week']).toBe(day('2026-09-07')) // the coming Monday
  })

  it('drops "This weekend" on a Friday, where it would just restate tomorrow', () => {
    const labels = duePresets(day('2026-09-04')).map((p) => p.label)
    expect(labels).not.toContain('This weekend')
    expect(labels).toEqual(['Today', 'Tomorrow', 'Next week'])
  })

  it('drops "This weekend" during the weekend, where it would be a lie', () => {
    for (const d of ['2026-09-05', '2026-09-06']) {
      expect(duePresets(day(d)).map((p) => p.label)).not.toContain('This weekend')
    }
  })

  it('never offers the same date twice, or a date in the past', () => {
    // Every day of one week, so each weekday shape is covered.
    for (let i = 0; i < 7; i++) {
      const today = addDays(day('2026-09-02'), i)
      const presets = duePresets(today)
      const dates = presets.map((p) => p.date)
      expect(new Set(dates).size).toBe(dates.length)
      for (const d of dates) expect(d).toBeGreaterThanOrEqual(today)
    }
  })

  it('always leads with today and tomorrow', () => {
    for (let i = 0; i < 7; i++) {
      const today = addDays(day('2026-09-02'), i)
      expect(duePresets(today).slice(0, 2).map((p) => p.label)).toEqual(['Today', 'Tomorrow'])
    }
  })
})

describe('searchTerms', () => {
  it('lowercases and splits on whitespace, dropping the empties', () => {
    expect(searchTerms('  Old   Draft ')).toEqual(['old', 'draft'])
    expect(searchTerms('   ')).toEqual([])
  })
})

describe('matchesAll', () => {
  it('needs every term, in any order', () => {
    const t = searchTerms('old draft')
    expect(matchesAll('The draft is old', t)).toBe(true)
    expect(matchesAll('An old note', t)).toBe(false)
  })

  it('matches everything when nothing was typed', () => {
    expect(matchesAll('anything at all', [])).toBe(true)
  })
})

describe('matchRanges', () => {
  it('finds every occurrence of every term', () => {
    expect(matchRanges('test a test', ['test'])).toEqual([
      { from: 0, to: 4 },
      { from: 7, to: 11 },
    ])
  })

  it('ignores case, and reports the range in the original', () => {
    const text = 'A Test of things'
    const [r] = matchRanges(text, ['test'])
    expect(text.slice(r.from, r.to)).toBe('Test')
  })

  it('merges overlapping terms rather than nesting them', () => {
    // Without the merge these would mark the same four letters twice, and
    // one <mark> would end up inside another.
    expect(matchRanges('testing', ['test', 'testing'])).toEqual([{ from: 0, to: 7 }])
    // 'esti' is 3-7 and 'sting' is 4-9; together they are 'esting', once.
    const [r] = matchRanges('a testing b', ['esti', 'sting'])
    expect('a testing b'.slice(r.from, r.to)).toBe('esting')
  })

  it('returns the ranges in order whatever order the terms came in', () => {
    expect(matchRanges('alpha beta', ['beta', 'alpha'])).toEqual([
      { from: 0, to: 5 },
      { from: 6, to: 10 },
    ])
  })

  it('answers nothing for no terms, no text, or no match', () => {
    expect(matchRanges('some text', [])).toEqual([])
    expect(matchRanges('', ['x'])).toEqual([])
    expect(matchRanges('some text', ['zebra'])).toEqual([])
  })

  it('stops at the cap rather than marking a thousand letters', () => {
    // 500 hits, capped at 20 — and being adjacent they merge into one range
    // covering those 20 letters, leaving the rest of the line plain.
    const out = matchRanges('e'.repeat(500), ['e'], 20)
    expect(out).toEqual([{ from: 0, to: 20 }])
  })

  it('caps separated matches too', () => {
    const text = 'e '.repeat(500)
    expect(matchRanges(text, ['e'], 20)).toHaveLength(20)
  })
})

describe('a segment that has to fit', () => {
  const lone = /[\uD800-\uDBFF]$/

  it('never cuts a character in half', () => {
    // An emoji is two UTF-16 units. A cut between them is not a character in
    // any encoding, and a sync backend writes it back as U+FFFD — so the name
    // on the other device is not the name here.
    const odd = `a${'🎉'.repeat(70)}`
    expect(lone.test(safeSegment(odd))).toBe(false)
    expect(safeSegment(odd).length).toBeLessThanOrEqual(120)
    expect(lone.test(fitSegment(odd, 100))).toBe(false)
  })

  it('leaves no trailing space or dot where the cut lands', () => {
    expect(fitSegment('abc def', 4)).toBe('abc')
    expect(fitSegment('abc.def', 4)).toBe('abc')
  })

  it('makes room for a counter rather than running past the limit', () => {
    const full = 'M'.repeat(120)
    expect(numberedSegment(full, 1)).toBe(full)
    expect(numberedSegment(full, 2)).toBe(`${'M'.repeat(118)} 2`)
    expect(numberedSegment(full, 13)).toBe(`${'M'.repeat(117)} 13`)
    // A short name is untouched apart from the counter.
    expect(numberedSegment('Standup', 2)).toBe('Standup 2')
  })

  it('puts a file’s counter before its extension, inside the limit', () => {
    expect(numberedFile('receipt.pdf', 1)).toBe('receipt.pdf')
    expect(numberedFile('receipt.pdf', 2)).toBe('receipt 2.pdf')
    const long = `${'M'.repeat(116)}.pdf`
    expect(numberedFile(long, 2)).toBe(`${'M'.repeat(114)} 2.pdf`)
    expect(numberedFile(long, 2).length).toBe(120)
    // No extension to keep, so it is a plain counter.
    expect(numberedFile('README', 3)).toBe('README 3')
  })
})

describe('a path as a link address', () => {
  /*
   * Every path comes back as itself. `%23` in a path used to be read as `#`
   * whether it had been one or not: a file literally called `receipt%23.pdf`
   * is written `receipt%2523.pdf`, and came back as `receipt#.pdf`.
   */
  const PATHS = [
    'receipt.pdf',
    'receipt#2.pdf',
    'receipt%23.pdf',
    'x %2523 y.png',
    'a%2Fb.png',
    '50% off.png',
    '%',
    '%%23',
    'café.png',
    'emoji 🎉.png',
    '(paren) [bracket].png',
    'attachments/2026/09/Scan #3 — final.pdf',
    "&=+$,;:@'!~*.png",
    'half \uD800 a character.png',
  ]

  it('decodes to exactly what was encoded, for every path', () => {
    for (const p of PATHS) expect(decodeLinkPath(encodeLinkPath(p)), p).toBe(p)
  })

  it('never writes a # an address would take for a fragment', () => {
    for (const p of PATHS) expect(encodeLinkPath(p), p).not.toContain('#')
  })

  it('still reads one written by hand', () => {
    expect(decodeLinkPath('receipt%232.pdf')).toBe('receipt#2.pdf')
    expect(decodeLinkPath('My%20Photo.png')).toBe('My Photo.png')
    // Half-encoded, and read as written rather than thrown.
    expect(decodeLinkPath('50%off.png')).toBe('50%off.png')
  })
})
