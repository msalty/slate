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
    expect(labels(m.places.matchPlaces('Q3'))).toContain('Q3')
    // "Work/Q3" typed in full is the same folder, reached by its path.
    expect(labels(m.places.matchPlaces('Work/Q3'))).toEqual(['Q3'])
  })

  it('puts the folder that *is* the word above the one that merely contains it', async () => {
    const m = await fresh()
    await seed(m)
    const found = labels(m.places.matchPlaces('/work'))
    expect(found[0]).toBe('Work')
    expect(found).toContain('Homework')
    expect(found.indexOf('Work')).toBeLessThan(found.indexOf('Homework'))
  })

  it('carries the count, so the row says how much is behind it', async () => {
    const m = await fresh()
    await seed(m)
    const work = m.places.matchPlaces('/work').find((p) => p.label === 'Work')
    // Three notes: two directly in Work, one in Work/Q3 beneath it.
    expect(work?.sub).toBe('Folder · 3 notes')
    const q3 = m.places.matchPlaces('/Q3')[0]
    expect(q3.sub).toBe('Folder in Work · 1 note')
  })

  it('scopes to the folder it found', async () => {
    const m = await fresh()
    await seed(m)
    expect(m.places.matchPlaces('/Q3')[0].target).toEqual({ kind: 'folder', path: 'Work/Q3' })
  })
})

describe('finding a tag', () => {
  it('finds one with or without the hash', async () => {
    const m = await fresh()
    await seed(m)
    expect(labels(m.places.matchPlaces('active'))).toContain('#active')
    expect(labels(m.places.matchPlaces('#active'))).toEqual(['#active'])
  })

  it('scopes to the tag, without the hash the label carries', async () => {
    const m = await fresh()
    await seed(m)
    expect(m.places.matchPlaces('#active')[0].target).toEqual({ kind: 'tag', tag: 'active' })
  })

  it('orders ties by how many notes carry the tag, not alphabetically', async () => {
    const m = await fresh()
    await seed(m)
    // #work is on three notes and #school on one; alphabetically it is the
    // other way round, which is the sidebar cloud's order and the wrong one
    // for guessing.
    const all = labels(m.places.matchPlaces('#'))
    expect(all.indexOf('#work')).toBeLessThan(all.indexOf('#school'))
  })
})

describe('finding a Tag Folder', () => {
  it('finds one by name', async () => {
    const m = await fresh()
    await seed(m)
    await m.folders.saveSmartFolder({ name: 'Live work', query: '#work AND #active' })
    expect(labels(m.places.matchPlaces('Live'))).toContain('Live work')
  })

  it('finds one by the rule it gathers on, which is written nowhere else', async () => {
    const m = await fresh()
    await seed(m)
    await m.folders.saveSmartFolder({ name: 'Live', query: '#work AND #archived' })
    const hit = m.places.matchPlaces('archived').find((p) => p.kind === 'smart')
    expect(hit?.label).toBe('Live')
  })

  it('counts tasks for a folder that gathers tasks', async () => {
    const m = await fresh()
    await m.vault.createNote('', 'Chores', '#home\n\n- [ ] Bins\n- [ ] Washing\n')
    const sf = await m.folders.saveSmartFolder({ name: 'Home jobs', query: '#home', shows: 'tasks' })
    const hit = m.places.matchPlaces('Home jobs')[0]
    expect(hit.sub).toBe('Tag Folder · 2 tasks')
    expect(hit.target).toEqual({ kind: 'smart', id: sf.id })
  })

  it('says which Tag Folder it is nested in', async () => {
    const m = await fresh()
    await seed(m)
    const parent = await m.folders.saveSmartFolder({ name: 'Work', query: '#work' })
    await m.folders.saveSmartFolder({ name: 'Archive', query: '#archived', parentId: parent.id })
    const hit = m.places.matchPlaces('Archive').find((p) => p.kind === 'smart')
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
    const kinds = new Set(m.places.matchPlaces('work').map((p) => p.kind))
    expect(kinds).toEqual(new Set(['folder', 'smart', 'tag']))

    expect(m.places.matchPlaces('#work').every((p) => p.kind === 'tag')).toBe(true)
    expect(m.places.matchPlaces('/work').every((p) => p.kind === 'folder')).toBe(true)
  })

  it('a bare prefix lists everything of that kind', async () => {
    const m = await fresh()
    await seed(m)
    expect(labels(m.places.matchPlaces('#')).sort()).toEqual([
      '#active',
      '#archived',
      '#finance',
      '#home',
      '#school',
      '#work',
    ])
    expect(labels(m.places.matchPlaces('/')).sort()).toEqual(['Homework', 'Q3', 'Work'])
  })

  it('says a prefixed query wants places and nothing else', async () => {
    const m = await fresh()
    expect(m.places.parsePlaceQuery('#work').only).toBe(true)
    expect(m.places.parsePlaceQuery('/Work').only).toBe(true)
    expect(m.places.parsePlaceQuery('work').only).toBe(false)
  })
})

describe('when nothing should be offered', () => {
  it('offers nothing at all on an empty box', async () => {
    const m = await fresh()
    await seed(m)
    // The palette opens on recent notes and a few commands; the whole vault's
    // folders underneath them would be the sidebar's problem in a dialog.
    expect(m.places.matchPlaces('')).toEqual([])
    expect(m.places.matchPlaces('   ')).toEqual([])
  })

  it('offers nothing when the name is simply not there', async () => {
    const m = await fresh()
    await seed(m)
    expect(m.places.matchPlaces('nothing-by-this-name')).toEqual([])
    expect(m.places.matchPlaces('#nope')).toEqual([])
  })

  it('needs every word to land, the way the other lists do', async () => {
    const m = await fresh()
    await seed(m)
    expect(labels(m.places.matchPlaces('/work q3'))).toEqual(['Q3'])
    expect(m.places.matchPlaces('/work lisbon')).toEqual([])
  })

  it('leaves room for the notes underneath a plain search', async () => {
    const m = await fresh()
    for (let i = 0; i < 12; i++) await m.vault.createNote('', `Note ${i}`, `#topic${i}\n`)
    // Twelve matching tags exist; a plain query hands back at most six so the
    // note hits are still on screen. A prefixed one has no notes to make room
    // for and shows them all.
    expect(m.places.matchPlaces('topic')).toHaveLength(6)
    expect(m.places.matchPlaces('#topic')).toHaveLength(12)
  })
})
