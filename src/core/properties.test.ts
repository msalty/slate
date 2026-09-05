import { describe, expect, it } from 'vitest'
import { parseFrontmatter } from './markdown'
import {
  addProperty,
  coerceValue,
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
