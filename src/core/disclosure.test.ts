/**
 * The sidebar's folded/unfolded shape.
 *
 * The point of keeping this outside the rows themselves is that a row is
 * unmounted whenever anything above it folds — the section, or a parent folder
 * — so the cases worth pinning down are the ones about what a row is *not*
 * told to do: nothing unfolds because something else did.
 */

import { describe, expect, it, vi } from 'vitest'

type Disclosure = typeof import('./disclosure')
type DB = typeof import('./db')

let seq = 0

/** Load the module against a named database, as a page load does. */
async function boot(name: string): Promise<{ d: Disclosure; db: DB }> {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = name
  const db = await import('./db')
  const d = await import('./disclosure')
  await d.loadDisclosure()
  return { d, db }
}

/** A fresh database and module per case. */
const fresh = () => boot(`slate-disclosure-${++seq}`)

const stored = (db: DB) => db.getMeta<string[]>('sidebar.open')

describe('folders', () => {
  it('start folded', async () => {
    const { d } = await fresh()
    expect(d.isFolderOpen('Work')).toBe(false)
    expect(d.isFolderOpen('Work/2026')).toBe(false)
  })

  it('stay unfolded until folded again', async () => {
    const { d } = await fresh()
    d.toggleFolder('Work')
    expect(d.isFolderOpen('Work')).toBe(true)
    d.toggleFolder('Work')
    expect(d.isFolderOpen('Work')).toBe(false)
  })

  it('do not follow their parent', async () => {
    const { d } = await fresh()
    d.setFolderOpen('Work', true)
    // The child was never opened, so unfolding the parent reveals a folded row
    // rather than the whole subtree.
    expect(d.isFolderOpen('Work/2026')).toBe(false)
  })

  it('keep the shape they had when the parent folds and unfolds again', async () => {
    const { d } = await fresh()
    d.setFolderOpen('Work', true)
    d.setFolderOpen('Work/2026', true)

    d.setFolderOpen('Work', false)
    d.setFolderOpen('Work', true)
    expect(d.isFolderOpen('Work/2026')).toBe(true)
  })

  it('are remembered across a reload', async () => {
    const name = `slate-disclosure-${++seq}`
    const first = await boot(name)
    first.d.setFolderOpen('Work/2026', true)
    await vi.waitFor(async () => expect(await stored(first.db)).toContain('folder:Work/2026'))

    const again = await boot(name)
    expect(again.d.isFolderOpen('Work/2026')).toBe(true)
    expect(again.d.isFolderOpen('Work')).toBe(false)
  })
})

describe('tag folders', () => {
  it('start folded and remember being unfolded', async () => {
    const { d } = await fresh()
    expect(d.isTagFolderOpen('abc')).toBe(false)
    d.toggleTagFolder('abc')
    expect(d.isTagFolderOpen('abc')).toBe(true)
  })

  it('do not share a name with a folder of the same path', async () => {
    const { d } = await fresh()
    d.setFolderOpen('Work', true)
    expect(d.isTagFolderOpen('Work')).toBe(false)
  })

  it('are forgotten when deleted', async () => {
    const { d, db } = await fresh()
    d.setTagFolderOpen('abc', true)
    d.setTagFolderOpen('def', true)

    d.forgetTagFolders(['abc'])
    expect(d.isTagFolderOpen('abc')).toBe(false)
    expect(d.isTagFolderOpen('def')).toBe(true)
    await vi.waitFor(async () => expect(await stored(db)).toEqual(['tag:def']))
  })
})

describe('a renamed folder', () => {
  it('keeps its own shape and its subtree’s', async () => {
    const { d } = await fresh()
    d.setFolderOpen('Work', true)
    d.setFolderOpen('Work/2026', true)
    d.setFolderOpen('Personal', true)

    d.renameOpenFolder('Work', 'Job')
    expect(d.isFolderOpen('Job')).toBe(true)
    expect(d.isFolderOpen('Job/2026')).toBe(true)
    expect(d.isFolderOpen('Work')).toBe(false)
    // A folder whose path merely starts with the same letters is untouched.
    expect(d.isFolderOpen('Personal')).toBe(true)
  })

  it('does not drag along a sibling with a longer name', async () => {
    const { d } = await fresh()
    d.setFolderOpen('Work', true)
    d.setFolderOpen('Workshop', true)

    d.renameOpenFolder('Work', 'Job')
    expect(d.isFolderOpen('Workshop')).toBe(true)
    expect(d.isFolderOpen('Job')).toBe(true)
  })
})

describe('a deleted folder', () => {
  it('is forgotten along with everything inside it', async () => {
    const { d, db } = await fresh()
    d.setFolderOpen('Work', true)
    d.setFolderOpen('Work/2026', true)
    d.setFolderOpen('Workshop', true)

    d.forgetFolder('Work')
    expect(d.isFolderOpen('Work')).toBe(false)
    // Recreating a folder at that path gets the default, not the old shape.
    expect(d.isFolderOpen('Work/2026')).toBe(false)
    expect(d.isFolderOpen('Workshop')).toBe(true)
    await vi.waitFor(async () => expect(await stored(db)).toEqual(['folder:Workshop']))
  })
})
