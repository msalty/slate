/**
 * Nested Tag Folder behaviour.
 *
 * These run against a real vault (fake IndexedDB + a fresh module instance per
 * test) rather than stubs, so inheritance, grouping and the cycle guards are
 * exercised through exactly the path the UI uses.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

type Mods = {
  vault: typeof import('./vault')
  folders: typeof import('./folders')
}

let seq = 0

async function fresh(): Promise<Mods> {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = `slate-sf-${++seq}`
  const vault = await import('./vault')
  const folders = await import('./folders')
  await vault.initVault()
  return { vault, folders }
}

async function seed(m: Mods) {
  await m.vault.createNote('Work', 'Sprint', '#work #active\n')
  await m.vault.createNote('Work', 'Retro', '#work #archived\n')
  await m.vault.createNote('Work', 'Outage', '#work #active #urgent\n')
  await m.vault.createNote('', 'Groceries', '#home #active\n')
  await m.vault.createNote('', 'Roof', '#home #urgent\n')
}

function titles(list: Array<{ title: string }>): string[] {
  return list.map((n) => n.title).sort()
}

beforeEach(() => {
  seq++
})

describe('nesting', () => {
  it('narrows the parent rule by default', async () => {
    const m = await fresh()
    await seed(m)
    const parent = await m.folders.saveSmartFolder({ name: 'Work', query: '#work' })
    const child = await m.folders.saveSmartFolder({
      name: 'Urgent',
      query: '#urgent',
      parentId: parent.id,
    })

    expect(titles(m.folders.notesForSmartFolder(parent.id))).toEqual(['Outage', 'Retro', 'Sprint'])
    // #work AND #urgent — the home note tagged #urgent must not leak in.
    expect(titles(m.folders.notesForSmartFolder(child.id))).toEqual(['Outage'])
  })

  it('can group without narrowing when inherit is off', async () => {
    const m = await fresh()
    await seed(m)
    const parent = await m.folders.saveSmartFolder({ name: 'Work', query: '#work' })
    const child = await m.folders.saveSmartFolder({
      name: 'Anything urgent',
      query: '#urgent',
      parentId: parent.id,
      inherit: false,
    })
    expect(titles(m.folders.notesForSmartFolder(child.id))).toEqual(['Outage', 'Roof'])
  })

  it('narrows through three levels', async () => {
    const m = await fresh()
    await seed(m)
    const a = await m.folders.saveSmartFolder({ name: 'Work', query: '#work' })
    const b = await m.folders.saveSmartFolder({ name: 'Active', query: '#active', parentId: a.id })
    const c = await m.folders.saveSmartFolder({ name: 'Urgent', query: '#urgent', parentId: b.id })
    expect(titles(m.folders.notesForSmartFolder(b.id))).toEqual(['Outage', 'Sprint'])
    expect(titles(m.folders.notesForSmartFolder(c.id))).toEqual(['Outage'])
  })

  it('stops climbing at the first link that opts out', async () => {
    const m = await fresh()
    await seed(m)
    const a = await m.folders.saveSmartFolder({ name: 'Work', query: '#work' })
    const b = await m.folders.saveSmartFolder({
      name: 'Break',
      query: '#active',
      parentId: a.id,
      inherit: false,
    })
    const c = await m.folders.saveSmartFolder({ name: 'Deep', query: '#home', parentId: b.id })
    // c inherits b (#active) but not a (#work), so it is #active AND #home.
    expect(titles(m.folders.notesForSmartFolder(c.id))).toEqual(['Groceries'])
  })

  it('re-narrows every descendant when the parent rule changes', async () => {
    const m = await fresh()
    await seed(m)
    const parent = await m.folders.saveSmartFolder({ name: 'Scope', query: '#work' })
    const child = await m.folders.saveSmartFolder({
      name: 'Active',
      query: '#active',
      parentId: parent.id,
    })
    expect(titles(m.folders.notesForSmartFolder(child.id))).toEqual(['Outage', 'Sprint'])

    await m.folders.saveSmartFolder({ id: parent.id, name: 'Scope', query: '#home' })
    expect(titles(m.folders.notesForSmartFolder(child.id))).toEqual(['Groceries'])
  })
})

describe('grouping folders', () => {
  it('shows the union of its children when it has no rule of its own', async () => {
    const m = await fresh()
    await seed(m)
    const group = await m.folders.saveSmartFolder({ name: 'Everything', query: '' })
    await m.folders.saveSmartFolder({ name: 'Urgent', query: '#urgent', parentId: group.id })
    await m.folders.saveSmartFolder({ name: 'Archived', query: '#archived', parentId: group.id })

    expect(m.folders.isGroupFolder(group.id)).toBe(true)
    expect(titles(m.folders.notesForSmartFolder(group.id))).toEqual(['Outage', 'Retro', 'Roof'])
  })

  it('deduplicates notes matched by more than one child', async () => {
    const m = await fresh()
    await seed(m)
    const group = await m.folders.saveSmartFolder({ name: 'Group', query: '' })
    await m.folders.saveSmartFolder({ name: 'A', query: '#urgent', parentId: group.id })
    await m.folders.saveSmartFolder({ name: 'B', query: '#work', parentId: group.id })
    const list = m.folders.notesForSmartFolder(group.id)
    expect(new Set(list.map((n) => n.path)).size).toBe(list.length)
  })

  it('is empty when it groups nothing', async () => {
    const m = await fresh()
    await seed(m)
    const group = await m.folders.saveSmartFolder({ name: 'Empty', query: '' })
    expect(m.folders.notesForSmartFolder(group.id)).toEqual([])
  })

  it('a child under a group is not narrowed by the empty parent', async () => {
    const m = await fresh()
    await seed(m)
    const group = await m.folders.saveSmartFolder({ name: 'Group', query: '' })
    const child = await m.folders.saveSmartFolder({ name: 'Home', query: '#home', parentId: group.id })
    expect(titles(m.folders.notesForSmartFolder(child.id))).toEqual(['Groceries', 'Roof'])
  })
})

describe('tree integrity', () => {
  it('refuses to make a folder its own descendant', async () => {
    const m = await fresh()
    const a = await m.folders.saveSmartFolder({ name: 'A', query: '#a' })
    const b = await m.folders.saveSmartFolder({ name: 'B', query: '#b', parentId: a.id })
    await m.folders.moveSmartFolder(a.id, b.id)
    expect(m.folders.smartFolderById(a.id)?.parentId).toBeUndefined()
  })

  it('refuses to make a folder its own parent', async () => {
    const m = await fresh()
    const a = await m.folders.saveSmartFolder({ name: 'A', query: '#a' })
    await m.folders.moveSmartFolder(a.id, a.id)
    expect(m.folders.smartFolderById(a.id)?.parentId).toBeUndefined()
  })

  it('drops a self-referential parent on save', async () => {
    const m = await fresh()
    const a = await m.folders.saveSmartFolder({ name: 'A', query: '#a' })
    const saved = await m.folders.saveSmartFolder({ id: a.id, name: 'A', query: '#a', parentId: a.id })
    expect(saved.parentId).toBeUndefined()
  })

  it('builds a tree with the right shape and depths', async () => {
    const m = await fresh()
    const a = await m.folders.saveSmartFolder({ name: 'A', query: '#a' })
    const b = await m.folders.saveSmartFolder({ name: 'B', query: '#b', parentId: a.id })
    await m.folders.saveSmartFolder({ name: 'C', query: '#c', parentId: b.id })
    await m.folders.saveSmartFolder({ name: 'D', query: '#d' })

    const tree = m.folders.smartFolderTree.value
    expect(tree.map((n) => n.folder.name)).toEqual(['A', 'D'])
    expect(tree[0].children[0].folder.name).toBe('B')
    expect(tree[0].children[0].children[0].folder.name).toBe('C')
    expect(m.folders.smartFolderList.value.map((n) => `${n.depth}:${n.folder.name}`)).toEqual([
      '0:A',
      '1:B',
      '2:C',
      '0:D',
    ])
  })

  it('lists ancestors from the top down', async () => {
    const m = await fresh()
    const a = await m.folders.saveSmartFolder({ name: 'A', query: '#a' })
    const b = await m.folders.saveSmartFolder({ name: 'B', query: '#b', parentId: a.id })
    const c = await m.folders.saveSmartFolder({ name: 'C', query: '#c', parentId: b.id })
    expect(m.folders.smartFolderAncestors(c.id).map((f) => f.name)).toEqual(['A', 'B'])
  })

  it('promotes children when a parent is deleted', async () => {
    const m = await fresh()
    const a = await m.folders.saveSmartFolder({ name: 'A', query: '#a' })
    const b = await m.folders.saveSmartFolder({ name: 'B', query: '#b', parentId: a.id })
    const c = await m.folders.saveSmartFolder({ name: 'C', query: '#c', parentId: b.id })

    await m.folders.deleteSmartFolder(b.id)
    expect(m.folders.smartFolderById(b.id)).toBeUndefined()
    expect(m.folders.smartFolderById(c.id)?.parentId).toBe(a.id)
  })

  it('deletes a whole subtree on request', async () => {
    const m = await fresh()
    const a = await m.folders.saveSmartFolder({ name: 'A', query: '#a' })
    const b = await m.folders.saveSmartFolder({ name: 'B', query: '#b', parentId: a.id })
    await m.folders.saveSmartFolder({ name: 'C', query: '#c', parentId: b.id })
    await m.folders.saveSmartFolder({ name: 'D', query: '#d' })

    const removed = await m.folders.deleteSmartFolderTree(a.id)
    expect(removed).toBe(3)
    expect(m.folders.smartFolders.value.map((f) => f.name)).toEqual(['D'])
  })

  it('survives a corrupt file that points at a missing parent', async () => {
    const m = await fresh()
    await m.vault.writeBackstage('smart-folders.json', [
      { id: 'x', name: 'Orphan', query: '#a', parentId: 'nope', createdAt: 1 },
    ])
    await m.folders.loadSmartFolders()
    expect(m.folders.smartFolders.value[0].parentId).toBeUndefined()
    expect(m.folders.smartFolderTree.value).toHaveLength(1)
  })

  it('survives a corrupt file containing a cycle', async () => {
    const m = await fresh()
    await m.vault.writeBackstage('smart-folders.json', [
      { id: 'a', name: 'A', query: '#a', parentId: 'b', createdAt: 1 },
      { id: 'b', name: 'B', query: '#b', parentId: 'a', createdAt: 2 },
    ])
    await m.folders.loadSmartFolders()
    // Neither can be rendered as a root, but nothing hangs or overflows.
    expect(() => m.folders.smartFolderTree.value).not.toThrow()
    expect(m.folders.effectiveNode('a')).toBeDefined()
    expect(m.folders.notesForSmartFolder('a')).toEqual([])
  })
})

describe('persistence', () => {
  it('round-trips the hierarchy through the vault', async () => {
    const m = await fresh()
    const a = await m.folders.saveSmartFolder({ name: 'A', query: '#work' })
    await m.folders.saveSmartFolder({ name: 'B', query: '#active', parentId: a.id, inherit: false })

    const raw = await m.vault.readBackstage<Array<Record<string, unknown>>>('smart-folders.json')
    expect(raw).toHaveLength(2)
    expect(raw![1].parentId).toBe(a.id)
    expect(raw![1].inherit).toBe(false)

    await m.folders.loadSmartFolders()
    expect(m.folders.smartFolderTree.value[0].children[0].folder.name).toBe('B')
  })
})
