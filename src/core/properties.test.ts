import { describe, expect, it } from 'vitest'
import { eventFor, parseFrontmatter } from './markdown'
import {
  addProperty,
  coerceValue,
  hasSeconds,
  isRealDate,
  readProperties,
  removeProperty,
  renameProperty,
  sanitizeKey,
  setPropertyValue,
  splitList,
  uniqueKey,
} from './properties'

const doc = [
  '---',
  'title: Trip',
  'pinned: true',
  'date: 2024-12-03',
  'nights: 4',
  'tags: [travel, lisbon]',
  'people:',
  '  - Ana',
  '  - Bo',
  '---',
  '',
  '# Trip',
  '',
  'Body text.',
  '',
].join('\n')

describe('reading properties', () => {
  it('keeps the file order and reads each kind', () => {
    const props = readProperties(doc)
    expect(props.map((p) => p.key)).toEqual(['title', 'pinned', 'date', 'nights', 'tags', 'people'])
    expect(props.map((p) => p.kind)).toEqual([
      'text',
      'checkbox',
      'date',
      'number',
      'list',
      'list',
    ])
    expect(props[4].items).toEqual(['travel', 'lisbon'])
    expect(props[5].value).toBe('Ana, Bo')
  })

  it('reads nothing from a note without frontmatter', () => {
    expect(readProperties('Just a body\n')).toEqual([])
    expect(readProperties('Body\n---\ntitle: no\n---\n')).toEqual([])
  })

  it('reads a property with no value yet', () => {
    const props = readProperties('---\nstatus:\n---\n\nBody\n')
    expect(props).toEqual([{ key: 'status', value: '', items: null, kind: 'text' }])
  })
})

describe('editing a property', () => {
  it('rewrites only the line it touches', () => {
    const out = setPropertyValue(doc, 'title', 'Lisbon')
    expect(out).toBe(doc.replace('title: Trip', 'title: Lisbon'))
  })

  it('keeps a block list written as a block list', () => {
    const out = setPropertyValue(doc, 'people', ['Ana', 'Bo', 'Cy'])
    expect(out).toContain('people:\n  - Ana\n  - Bo\n  - Cy\n')
    expect(out).toContain('tags: [travel, lisbon]')
  })

  it('keeps an inline list inline', () => {
    const out = setPropertyValue(doc, 'tags', ['travel'])
    expect(out).toContain('tags: [travel]')
  })

  it('quotes a value that would not survive being written bare', () => {
    const out = setPropertyValue(doc, 'title', '- 09:00 start')
    expect(parseFrontmatter(out).data.title).toBe('- 09:00 start')
  })

  it('leaves a number and a date unquoted', () => {
    const out = setPropertyValue(setPropertyValue(doc, 'nights', '-3'), 'date', '2025-01-09')
    expect(out).toContain('nights: -3')
    expect(out).toContain('date: 2025-01-09')
  })

  it('empties a value without dropping the key', () => {
    const out = setPropertyValue(doc, 'title', '')
    expect(out).toContain('\ntitle:\n')
    expect(readProperties(out)[0]).toEqual({ key: 'title', value: '', items: null, kind: 'text' })
  })
})

describe('adding a property', () => {
  it('appends to a block that already exists', () => {
    const out = addProperty(doc, 'status', 'draft')
    expect(out).toContain('people:\n  - Ana\n  - Bo\nstatus: draft\n---')
    expect(out.endsWith('Body text.\n')).toBe(true)
  })

  it('writes the block a note has never had', () => {
    const out = addProperty('# Notes\n\nBody\n', 'status', 'draft')
    expect(out).toBe('---\nstatus: draft\n---\n\n# Notes\n\nBody\n')
    expect(parseFrontmatter(out).data.status).toBe('draft')
  })

  it('starts an empty note off with just the block', () => {
    expect(addProperty('', 'status', '')).toBe('---\nstatus:\n---\n\n')
  })

  it('sets an existing key rather than writing it twice', () => {
    const out = addProperty(doc, 'title', 'Lisbon')
    expect(out.match(/^title:/gm)?.length).toBe(1)
    expect(out).toContain('title: Lisbon')
  })
})

describe('renaming and removing', () => {
  it('renames in place, keeping the value and the order', () => {
    const out = renameProperty(doc, 'nights', 'sleeps')
    expect(readProperties(out).map((p) => p.key)).toEqual([
      'title',
      'pinned',
      'date',
      'sleeps',
      'tags',
      'people',
    ])
    expect(readProperties(out)[3].value).toBe('4')
  })

  it('refuses a name the note is already using', () => {
    expect(renameProperty(doc, 'nights', 'title')).toBe(doc)
  })

  it('removes one property and leaves the rest alone', () => {
    const out = removeProperty(doc, 'pinned')
    expect(out).toBe(doc.replace('pinned: true\n', ''))
  })

  it('takes the whole block away with the last property', () => {
    const one = '---\nstatus: draft\n---\n\n# Notes\n\nBody\n'
    expect(removeProperty(one, 'status')).toBe('# Notes\n\nBody\n')
  })
})

describe('lines the form does not understand', () => {
  it('keeps a comment where it was', () => {
    const withComment = '---\n# written by hand\ntitle: A\n# about the tags\ntags: [x]\n---\n\nBody\n'
    const out = setPropertyValue(withComment, 'title', 'B')
    expect(out).toBe(withComment.replace('title: A', 'title: B'))
  })
})

describe('changing a property s kind', () => {
  const p = (value: string, items: string[] | null = null) =>
    ({ key: 'k', value, items, kind: 'text' }) as const

  it('turns text into the other kinds', () => {
    expect(coerceValue(p('travel, lisbon'), 'list')).toEqual(['travel', 'lisbon'])
    expect(coerceValue(p('yes'), 'checkbox')).toBe('true')
    expect(coerceValue(p('nothing like a boolean'), 'checkbox')).toBe('false')
    expect(coerceValue(p('12'), 'number')).toBe('12')
    expect(coerceValue(p('not a number'), 'number')).toBe('0')
    expect(coerceValue(p('2024-12-03'), 'date')).toBe('2024-12-03')
  })

  it('flattens a list back into text', () => {
    expect(coerceValue({ key: 'k', value: 'a, b', items: ['a', 'b'], kind: 'list' }, 'text')).toBe(
      'a, b',
    )
  })
})

describe('keys', () => {
  it('makes a typed name one the file can hold', () => {
    expect(sanitizeKey('  Due date  ')).toBe('Due-date')
    expect(sanitizeKey('what?!')).toBe('what')
  })

  it('finds a name the note is not using', () => {
    expect(uniqueKey(['title'])).toBe('property')
    expect(uniqueKey(['property', 'property-2'])).toBe('property-3')
  })

  it('splits a typed list', () => {
    expect(splitList(' a , ,b ')).toEqual(['a', 'b'])
  })
})

/**
 * Times in the properties form.
 *
 * `start:` and `end:` are written in a format nobody should have to remember,
 * so the form hands over a picker. The rules worth pinning are the two that
 * protect the file from the widget: a value the field cannot hold is left as
 * text rather than blanked, and switching kinds keeps the day.
 */
describe('date and time properties', () => {
  const kindOfKey = (text: string, key: string) =>
    readProperties(text).find((p) => p.key === key)?.kind

  it('reads a written-out time as a time', () => {
    expect(kindOfKey('---\nstart: 2026-09-21T09:30\n---\n', 'start')).toBe('datetime')
    expect(kindOfKey('---\nstart: 2026-09-21T09:30:15\n---\n', 'start')).toBe('datetime')
  })

  it('still reads a bare date as a date, which is what an all-day event is', () => {
    expect(kindOfKey('---\nstart: 2026-09-21\n---\n', 'start')).toBe('date')
  })

  it('offers a time for an empty start or end, which has nothing to go on', () => {
    expect(kindOfKey('---\nstart:\n---\n', 'start')).toBe('datetime')
    expect(kindOfKey('---\nend:\n---\n', 'end')).toBe('datetime')
    expect(kindOfKey('---\ndate:\n---\n', 'date')).toBe('date')
  })

  it('and spells them the way the app reads them, which is exactly', () => {
    /*
     * Frontmatter is case-sensitive and so is every reader of it: `eventFor`
     * looks for `start`, never for `Start`. Offering a time field for `Start:`
     * was offering a picker for a key nothing in the app will ever read.
     */
    expect(kindOfKey('---\nStart:\n---\n', 'Start')).toBe('text')
    expect(kindOfKey('---\nDUE:\n---\n', 'DUE')).toBe('text')
    expect(eventFor({ Start: '2026-09-21T09:00' })).toBeUndefined()
  })

  it('but the value always wins once there is one', () => {
    // Somebody's novel. `start: chapter three` is prose, not a broken date.
    expect(kindOfKey('---\nstart: chapter three\n---\n', 'start')).toBe('text')
    expect(kindOfKey('---\nstart: 12\n---\n', 'start')).toBe('number')
  })

  it('leaves a key the app knows nothing about alone', () => {
    expect(kindOfKey('---\nnotes:\n---\n', 'notes')).toBe('text')
  })

  it('keeps a space-separated time as text, rather than blanking the field', () => {
    // A `datetime-local` field cannot hold "2026-09-21 09:30" and would show
    // the row as empty, which reads as the value having been lost.
    expect(kindOfKey('---\nstart: 2026-09-21 09:30\n---\n', 'start')).toBe('text')
  })

  it('converts that space form when the kind is asked for explicitly', () => {
    const p = readProperties('---\nstart: 2026-09-21 09:30\n---\n')[0]
    expect(coerceValue(p, 'datetime')).toBe('2026-09-21T09:30')
  })

  it('adds a time to a date rather than discarding the day', () => {
    const p = readProperties('---\nstart: 2026-09-21\n---\n')[0]
    expect(coerceValue(p, 'datetime')).toMatch(/^2026-09-21T\d{2}:\d{2}$/)
  })

  it('and takes the time off without losing the day either', () => {
    const p = readProperties('---\nstart: 2026-09-21T09:30\n---\n')[0]
    expect(coerceValue(p, 'date')).toBe('2026-09-21')
  })

  it('writes a time back unquoted, so the agenda can still read it', () => {
    const next = setPropertyValue('---\nstart:\n---\n\nBody.\n', 'start', '2026-09-21T09:30')
    expect(next).toContain('start: 2026-09-21T09:30')
    expect(eventFor(parseFrontmatter(next).data)?.start).toBe(
      new Date(2026, 8, 21, 9, 30).getTime(),
    )
  })

  it('says when a value carries seconds, so the field can be told to show them', () => {
    expect(hasSeconds('2026-09-21T09:30:15')).toBe(true)
    expect(hasSeconds('2026-09-21T09:30')).toBe(false)
    expect(hasSeconds('2026-09-21')).toBe(false)
  })
})

/**
 * A list item is not necessarily free of commas, and a date-shaped value is not
 * necessarily a date.
 */
describe('values the form has to hold without breaking', () => {
  const kindOfKey = (text: string, key: string) =>
    readProperties(text).find((p) => p.key === key)?.kind

  it('keeps a comma inside quotes on the way in', () => {
    const p = readProperties('---\naliases: ["Doe, Jane", JD]\n---\n')[0]
    expect(p.items).toEqual(['Doe, Jane', 'JD'])
  })

  it('and puts the quotes back on the way out, so it survives an edit', () => {
    // The field shows what the file holds. Shown as `Doe, Jane` it re-split
    // into two names on the next keystroke, and the link it was for stopped
    // resolving.
    const p = readProperties('---\naliases: ["Doe, Jane", JD]\n---\n')[0]
    expect(p.value).toBe('"Doe, Jane", JD')
    expect(splitList(p.value)).toEqual(['Doe, Jane', 'JD'])
  })

  it('writes one back into the file quoted', () => {
    const next = setPropertyValue('---\naliases: [JD]\n---\n', 'aliases', ['Doe, Jane', 'JD'])
    expect(next).toContain('aliases: ["Doe, Jane", JD]')
    expect(parseFrontmatter(next).data.aliases).toEqual(['Doe, Jane', 'JD'])
  })

  it('leaves an ordinary list exactly as it was', () => {
    const p = readProperties('---\ntags: [demo, test]\n---\n')[0]
    expect(p.value).toBe('demo, test')
    expect(setPropertyValue('---\ntags: [a]\n---\n', 'tags', ['demo', 'test'])).toContain(
      'tags: [demo, test]',
    )
  })

  it('keeps a date-shaped impossibility as text rather than a blank field', () => {
    // A `datetime-local` handed 2026-13-01 shows nothing, so the row reads as
    // empty over a file that still holds the value — and the next thing typed
    // overwrites something the form said was not there.
    expect(isRealDate('2026-13-01T09:00')).toBe(false)
    expect(isRealDate('2026-02-30')).toBe(false)
    expect(isRealDate('2026-09-21T24:00')).toBe(false)
    expect(isRealDate('2026-09-21T09:00')).toBe(true)
    expect(isRealDate('2028-02-29')).toBe(true)
    expect(kindOfKey('---\nstart: 2026-13-01T09:00\n---\n', 'start')).toBe('text')
    expect(kindOfKey('---\ndate: 2026-02-30\n---\n', 'date')).toBe('text')
  })
})

/**
 * What a quoted value survives: the quotes coming off, and going back on.
 */
describe('quoted values, both directions', () => {
  it('reads the escapes the writer put in', () => {
    // Taking only the quotes off left literal backslashes in the name, and the
    // next write escaped them again — every save doubling them.
    const written = setPropertyValue('---\naliases: [x]\n---\n', 'aliases', ['Doe, "Jane"'])
    expect(parseFrontmatter(written).data.aliases).toEqual(['Doe, "Jane"'])
    expect(readProperties(written)[0].items).toEqual(['Doe, "Jane"'])
  })

  it('and writing what it read back gives the same line', () => {
    const once = setPropertyValue('---\naliases: [x]\n---\n', 'aliases', ['Doe, "Jane"', 'JD'])
    const twice = setPropertyValue(once, 'aliases', readProperties(once)[0].items!)
    expect(twice).toBe(once)
  })

  it('reads a single-quoted value the way YAML does', () => {
    expect(parseFrontmatter("---\ntitle: 'it''s here'\n---\n").data.title).toBe("it's here")
  })

  it('leaves a value JSON will not take as it is written', () => {
    // A Windows path is not an escape sequence, and is not an error either.
    expect(parseFrontmatter('---\npath: "C:\\Users"\n---\n').data.path).toBe('C:\\Users')
  })

  it('calls a space-separated time a real date, because the app reads one', () => {
    // "Cannot be edited with a picker" and "is not a date" are different
    // things, and the form was saying the second about a value it reads fine.
    expect(isRealDate('2026-09-21 09:30')).toBe(true)
    expect(eventFor({ start: '2026-09-21 09:30' })).toBeDefined()
    // Still text, though: a `datetime-local` cannot hold that spelling.
    expect(readProperties('---\nstart: 2026-09-21 09:30\n---\n')[0].kind).toBe('text')
  })
})
