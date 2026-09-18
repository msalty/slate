/**
 * What ⌘K finds when you type the name of a collection.
 *
 * These run against a real vault — a fake IndexedDB and a fresh module
 * instance per test — so the folder tree, the Tag Folder rules and the tag
 * index are the ones the sidebar reads, rather than fixtures that agree with
 * the test by construction.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

type Mods = {
  vault: typeof import('../core/vault')
  folders: typeof import('../core/folders')
  places: typeof import('./places')
}

let seq = 0

async function fresh(): Promise<Mods> {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = `slate-places-${++seq}`
  const vault = await import('../core/vault')
  await vault.initVault()
  const folders = await import('../core/folders')
  const places = await import('./places')
  return { vault, folders, places }
}

async function seed(m: Mods) {
  await m.vault.createNote('Work', 'Sprint', '#work #active\n')
  await m.vault.createNote('Work', 'Retro', '#work #archived\n')
  await m.vault.createNote('Work/Q3', 'Numbers', '#work #finance\n')
  await m.vault.createNote('Homework', 'Essay', '#school\n')
  await m.vault.createNote('', 'Groceries', '#home #active\n')
}

/** The matched collections. The cap is asserted on its own, further down. */
function found(m: Mods, q: string) {
  return m.places.matchPlaces(q).places
}

/** Just the labels, which is what the row actually shows. */
function labels(list: Array<{ label: string }>): string[] {
  return list.map((p) => p.label)
}

beforeEach(() => {
  seq++
})

describe('finding a folder', () => {
  it('finds one by its own name, and by the path it sits in', async () => {
    const m = await fresh()
    await seed(m)
    expect(labels(found(m, 'Q3'))).toContain('Q3')
    // "Work/Q3" typed in full is the same folder, reached by its path.
    expect(labels(found(m, 'Work/Q3'))).toEqual(['Q3'])
  })

  it('puts the folder that *is* the word above the one that merely contains it', async () => {
    const m = await fresh()
    await seed(m)
    const hits = labels(found(m, '/work'))
    expect(hits[0]).toBe('Work')
    expect(hits).toContain('Homework')
    expect(hits.indexOf('Work')).toBeLessThan(hits.indexOf('Homework'))
  })

  it('carries the count, so the row says how much is behind it', async () => {
    const m = await fresh()
    await seed(m)
    const work = found(m, '/work').find((p) => p.label === 'Work')
    // Three notes: two directly in Work, one in Work/Q3 beneath it.
    expect(work?.sub).toBe('Folder · 3 notes')
    const q3 = found(m, '/Q3')[0]
    expect(q3.sub).toBe('Folder in Work · 1 note')
  })

  it('scopes to the folder it found', async () => {
    const m = await fresh()
    await seed(m)
    expect(found(m, '/Q3')[0].target).toEqual({ kind: 'folder', path: 'Work/Q3' })
  })
})

describe('finding a tag', () => {
  it('finds one with or without the hash', async () => {
    const m = await fresh()
    await seed(m)
    expect(labels(found(m, 'active'))).toContain('#active')
    expect(labels(found(m, '#active'))).toEqual(['#active'])
  })

  it('scopes to the tag, without the hash the label carries', async () => {
    const m = await fresh()
    await seed(m)
    expect(found(m, '#active')[0].target).toEqual({ kind: 'tag', tag: 'active' })
  })

  it('orders ties by how many notes carry the tag, not alphabetically', async () => {
    const m = await fresh()
    await seed(m)
    // #work is on three notes and #school on one; alphabetically it is the
    // other way round, which is the sidebar cloud's order and the wrong one
    // for guessing.
    const all = labels(found(m, '#'))
    expect(all.indexOf('#work')).toBeLessThan(all.indexOf('#school'))
  })
})

describe('finding a Tag Folder', () => {
  it('finds one by name', async () => {
    const m = await fresh()
    await seed(m)
    await m.folders.saveSmartFolder({ name: 'Live work', query: '#work AND #active' })
    expect(labels(found(m, 'Live'))).toContain('Live work')
  })

  it('finds one by the rule it gathers on, which is written nowhere else', async () => {
    const m = await fresh()
    await seed(m)
    await m.folders.saveSmartFolder({ name: 'Live', query: '#work AND #archived' })
    const hit = found(m, 'archived').find((p) => p.kind === 'smart')
    expect(hit?.label).toBe('Live')
  })

  it('counts tasks for a folder that gathers tasks', async () => {
    const m = await fresh()
    await m.vault.createNote('', 'Chores', '#home\n\n- [ ] Bins\n- [ ] Washing\n')
    const sf = await m.folders.saveSmartFolder({ name: 'Home jobs', query: '#home', shows: 'tasks' })
    const hit = found(m, 'Home jobs')[0]
    expect(hit.sub).toBe('Tag Folder · 2 tasks')
    expect(hit.target).toEqual({ kind: 'smart', id: sf.id })
  })

  it('says which Tag Folder it is nested in', async () => {
    const m = await fresh()
    await seed(m)
    const parent = await m.folders.saveSmartFolder({ name: 'Work', query: '#work' })
    await m.folders.saveSmartFolder({ name: 'Archive', query: '#archived', parentId: parent.id })
    const hit = found(m, 'Archive').find((p) => p.kind === 'smart')
    expect(hit?.sub).toBe('Tag Folder in Work · 1 note')
  })
})

describe('the prefixes', () => {
  it('# keeps tags only and / keeps folders only', async () => {
    const m = await fresh()
    await seed(m)
    await m.folders.saveSmartFolder({ name: 'Work rules', query: '#work' })

    // Bare "work" is all three kinds at once — that is the ambiguity the
    // prefixes exist to resolve.
    const kinds = new Set(found(m, 'work').map((p) => p.kind))
    expect(kinds).toEqual(new Set(['folder', 'smart', 'tag']))

    expect(found(m, '#work').every((p) => p.kind === 'tag')).toBe(true)
    expect(found(m, '/work').every((p) => p.kind === 'folder')).toBe(true)
  })

  it('a bare prefix lists everything of that kind', async () => {
    const m = await fresh()
    await seed(m)
    expect(labels(found(m, '#')).sort()).toEqual([
      '#active',
      '#archived',
      '#finance',
      '#home',
      '#school',
      '#work',
    ])
    expect(labels(found(m, '/')).sort()).toEqual(['Homework', 'Q3', 'Work'])
  })

  it('says what shape of answer each prefix is asking for', async () => {
    const m = await fresh()
    const mode = (q: string) => m.places.parsePaletteQuery(q).mode
    expect(mode('#work')).toBe('places')
    expect(mode('/Work')).toBe('places')
    expect(mode('>sync')).toBe('commands')
    expect(mode('@costs')).toBe('headings')
    expect(mode('work')).toBe('everything')
    // The prefix comes off, so the rest is matched on its own.
    expect(m.places.parsePaletteQuery('  > sync  ').term).toBe('sync')
  })

  it('offers no collection at all for a command query', async () => {
    const m = await fresh()
    await seed(m)
    // Not even the Work folder, which "work" on its own would certainly find.
    expect(found(m, '>work')).toEqual([])
    expect(found(m, '>')).toEqual([])
  })

  it('offers no collection for an outline query either', async () => {
    const m = await fresh()
    await seed(m)
    // `@work` is a heading in the open note, never the Work folder — the
    // prefix says which question is being asked.
    expect(found(m, '@work')).toEqual([])
    expect(found(m, '@')).toEqual([])
  })
})

describe('what it says when nothing matched', () => {
  it('answers in the terms the query was asked in', async () => {
    const m = await fresh()
    expect(m.places.emptyPaletteMessage('#nope')).toBe('No tags match.')
    expect(m.places.emptyPaletteMessage('/nope')).toBe('No folders match.')
    expect(m.places.emptyPaletteMessage('>nope')).toBe('No commands match.')
    // Unprefixed, a new note really is the useful next move.
    expect(m.places.emptyPaletteMessage('nope')).toMatch(/New note/)
  })

  it('tells the three empty outlines apart, because they are three problems', async () => {
    const m = await fresh()
    const msg = (o: { noteOpen: boolean; total: number }) => m.places.emptyPaletteMessage('@x', o)
    // Nothing to outline at all.
    expect(msg({ noteOpen: false, total: 0 })).toMatch(/No note is open/)
    // A note, but nothing in it to jump to — the query was never the problem,
    // and "No headings match" would send somebody off editing it.
    expect(msg({ noteOpen: true, total: 0 })).toBe('This note has no headings.')
    // A note with headings, none of them this one.
    expect(msg({ noteOpen: true, total: 4 })).toBe('No headings match.')
  })
})

describe('when nothing should be offered', () => {
  it('offers nothing at all on an empty box', async () => {
    const m = await fresh()
    await seed(m)
    // The palette opens on recent notes and a few commands; the whole vault's
    // folders underneath them would be the sidebar's problem in a dialog.
    expect(found(m, '')).toEqual([])
    expect(found(m, '   ')).toEqual([])
  })

  it('offers nothing when the name is simply not there', async () => {
    const m = await fresh()
    await seed(m)
    expect(found(m, 'nothing-by-this-name')).toEqual([])
    expect(found(m, '#nope')).toEqual([])
  })

  it('needs every word to land, the way the other lists do', async () => {
    const m = await fresh()
    await seed(m)
    expect(labels(found(m, '/work q3'))).toEqual(['Q3'])
    expect(found(m, '/work lisbon')).toEqual([])
  })

  it('leaves room for the notes underneath a plain search', async () => {
    const m = await fresh()
    for (let i = 0; i < 12; i++) await m.vault.createNote('', `Note ${i}`, `#topic${i}\n`)
    // Twelve matching tags exist; a plain query hands back at most six so the
    // note hits are still on screen. A prefixed one has no notes to make room
    // for and shows them all.
    expect(found(m, 'topic')).toHaveLength(6)
    expect(found(m, '#topic')).toHaveLength(12)
  })
})

describe('a list that is only part of the answer says so', () => {
  /** A vault with more tags than a prefixed query will show at once. */
  async function manyTags(m: Mods, n: number) {
    for (let i = 0; i < n; i++) {
      await m.vault.createNote('', `Note ${i}`, `#t${String(i).padStart(3, '0')}\n`)
    }
  }

  it('counts everything that matched, not just what it handed back', async () => {
    const m = await fresh()
    await manyTags(m, 63)
    const r = m.places.matchPlaces('#')
    expect(r.places).toHaveLength(40)
    expect(r.total).toBe(63)
  })

  it('says how many of how many, and what to do about it', async () => {
    const m = await fresh()
    await manyTags(m, 63)
    expect(m.places.cappedPaletteNote('#', m.places.matchPlaces('#'))).toBe(
      'Showing 40 of 63 tags — type to narrow.',
    )
  })

  it('names folders as folders', async () => {
    const m = await fresh()
    for (let i = 0; i < 45; i++) await m.vault.createNote(`Folder ${i}`, `Note ${i}`, 'x\n')
    const note = m.places.cappedPaletteNote('/', m.places.matchPlaces('/'))
    expect(note).toBe('Showing 40 of 45 folders — type to narrow.')
  })

  it('stays quiet once the list is the whole answer', async () => {
    const m = await fresh()
    await manyTags(m, 63)
    // Narrowing is exactly what the line asked for, so it stops asking.
    const narrowed = m.places.matchPlaces('#t01')
    expect(narrowed.places).toHaveLength(10)
    expect(m.places.cappedPaletteNote('#t01', narrowed)).toBeUndefined()
  })

  it('stays quiet for an unprefixed search, where six is the point', async () => {
    const m = await fresh()
    await manyTags(m, 63)
    /*
     * The plain cap is deliberate — it is leaving room for the notes — so
     * counting it out loud would be a warning about a limit nobody is up
     * against. Only a prefixed query implies it is showing you everything.
     */
    const plain = m.places.matchPlaces('t0')
    expect(plain.places).toHaveLength(6)
    expect(m.places.cappedPaletteNote('t0', plain)).toBeUndefined()
  })
})
