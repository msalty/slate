import { describe, expect, it } from 'vitest'
import {
  describeQuery,
  evaluateQuery,
  folderInQuery,
  parseQuery,
  tagsInQuery,
  type QueryContext,
} from './tagquery'

function ctx(over: Partial<QueryContext> = {}): QueryContext {
  return {
    tags: [],
    folder: '',
    hasTasks: false,
    hasImages: false,
    hasAttachments: false,
    hasLinks: false,
    ...over,
  }
}

function run(src: string, c: QueryContext): boolean {
  const { node, error } = parseQuery(src)
  if (!node) throw new Error(`parse failed: ${error}`)
  return evaluateQuery(node, c)
}

describe('parsing', () => {
  it('accepts an empty rule as "everything"', () => {
    const { node } = parseQuery('   ')
    expect(node).toEqual({ t: 'all' })
  })

  it('treats adjacency as AND', () => {
    expect(run('#work #active', ctx({ tags: ['work', 'active'] }))).toBe(true)
    expect(run('#work #active', ctx({ tags: ['work'] }))).toBe(false)
  })

  it('accepts an explicit AND', () => {
    expect(run('#work AND #active', ctx({ tags: ['work', 'active'] }))).toBe(true)
  })

  it('gives OR lower precedence than AND', () => {
    // Parsed as (#a AND #b) OR #c
    expect(run('#a AND #b OR #c', ctx({ tags: ['c'] }))).toBe(true)
    expect(run('#a AND #b OR #c', ctx({ tags: ['a'] }))).toBe(false)
    expect(run('#a AND #b OR #c', ctx({ tags: ['a', 'b'] }))).toBe(true)
  })

  it('honours parentheses', () => {
    expect(run('#a AND (#b OR #c)', ctx({ tags: ['a', 'c'] }))).toBe(true)
    expect(run('#a AND (#b OR #c)', ctx({ tags: ['b', 'c'] }))).toBe(false)
  })

  it('supports NOT, bare - and !', () => {
    const c = ctx({ tags: ['work', 'archived'] })
    expect(run('#work NOT #archived', c)).toBe(false)
    expect(run('#work -#archived', c)).toBe(false)
    expect(run('#work !#archived', c)).toBe(false)
    expect(run('#work NOT #done', c)).toBe(true)
  })

  it('handles the example from the brief', () => {
    const q = '#thisTag AND #thatTag NOT #tagToExclude'
    expect(run(q, ctx({ tags: ['thistag', 'thattag'] }))).toBe(true)
    expect(run(q, ctx({ tags: ['thistag', 'thattag', 'tagtoexclude'] }))).toBe(false)
    expect(run(q, ctx({ tags: ['thistag'] }))).toBe(false)
  })

  it('makes the hash optional', () => {
    expect(run('work AND active', ctx({ tags: ['work', 'active'] }))).toBe(true)
  })

  it('is case-insensitive on tags and operators', () => {
    expect(run('#WORK and #Active', ctx({ tags: ['work', 'ACTIVE'] }))).toBe(true)
  })

  it('lets a hash escape the operator keywords', () => {
    // "#and" is a tag, not the AND operator.
    expect(run('#and', ctx({ tags: ['and'] }))).toBe(true)
  })

  it('keeps a hyphen inside a word literal', () => {
    expect(run('#half-done', ctx({ tags: ['half-done'] }))).toBe(true)
    expect(run('#a -#b', ctx({ tags: ['a'] }))).toBe(true)
  })
})

describe('hierarchical tags', () => {
  it('matches a parent tag against its children', () => {
    expect(run('#work', ctx({ tags: ['work/active'] }))).toBe(true)
    expect(run('#work/active', ctx({ tags: ['work/active'] }))).toBe(true)
  })

  it('does not match on a mere prefix', () => {
    expect(run('#work', ctx({ tags: ['workshop'] }))).toBe(false)
  })

  it('does not match a child query against a parent tag', () => {
    expect(run('#work/active', ctx({ tags: ['work'] }))).toBe(false)
  })
})

describe('non-tag predicates', () => {
  it('filters by folder, including nested', () => {
    expect(run('folder:Work', ctx({ folder: 'Work' }))).toBe(true)
    expect(run('folder:Work', ctx({ folder: 'Work/Clients' }))).toBe(true)
    expect(run('folder:Work', ctx({ folder: 'Personal' }))).toBe(false)
    expect(run('in:Work', ctx({ folder: 'Work' }))).toBe(true)
  })

  it('supports has:', () => {
    expect(run('has:tasks', ctx({ hasTasks: true }))).toBe(true)
    expect(run('has:images', ctx({ hasImages: false }))).toBe(false)
  })

  it('combines a folder with tags', () => {
    const q = 'folder:Work #network -#done'
    expect(run(q, ctx({ folder: 'Work', tags: ['network'] }))).toBe(true)
    expect(run(q, ctx({ folder: 'Work', tags: ['network', 'done'] }))).toBe(false)
    expect(run(q, ctx({ folder: 'Home', tags: ['network'] }))).toBe(false)
  })

  it('accepts a quoted folder with spaces', () => {
    expect(run('folder:"Client Work"', ctx({ folder: 'Client Work' }))).toBe(true)
  })
})

describe('errors', () => {
  it('reports an unclosed group', () => {
    const r = parseQuery('#a AND (#b OR #c')
    expect(r.node).toBeUndefined()
    expect(r.error).toMatch(/\)/)
  })

  it('reports a stray closing paren', () => {
    expect(parseQuery('#a)').error).toBeTruthy()
  })

  it('reports a dangling operator', () => {
    expect(parseQuery('#a AND').error).toBeTruthy()
    expect(parseQuery('NOT').error).toBeTruthy()
  })

  it('reports an unknown has: value', () => {
    expect(parseQuery('has:bananas').error).toMatch(/has:/)
  })

  it('points at the offending character', () => {
    const r = parseQuery('#a AND @')
    expect(r.error).toBeTruthy()
    expect(r.at).toBe(7)
  })
})

describe('introspection', () => {
  it('lists the tags a rule requires, skipping negated ones', () => {
    const { node } = parseQuery('#work AND #active NOT #archived')
    expect(tagsInQuery(node!).sort()).toEqual(['active', 'work'])
  })

  it('finds a single pinned folder', () => {
    expect(folderInQuery(parseQuery('folder:Work #a').node!)).toBe('Work')
    expect(folderInQuery(parseQuery('#a').node!)).toBeUndefined()
    expect(folderInQuery(parseQuery('folder:A OR folder:B').node!)).toBeUndefined()
  })

  it('renders a readable description', () => {
    expect(describeQuery(parseQuery('#a AND (#b OR #c)').node!)).toBe('#a and (#b or #c)')
    expect(describeQuery(parseQuery('NOT #x').node!)).toBe('not #x')
  })
})
