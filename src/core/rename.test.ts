/**
 * Renaming and moving a note, and what happens to the links that point at it.
 *
 * A rename is only safe if every link that meant this note still means it
 * afterwards, and no link that meant some *other* note is touched. The rewrite
 * used to decide which links were this note's by comparing their text with its
 * old title, which was wrong both ways: a rename that collided sent the note to
 * `Foo 2` and its links to `[[Foo]]`, and of two notes called `A`, renaming the
 * one `[[A]]` did not mean rewrote it anyway. It now resolves each link and
 * rewrites the ones that actually arrived here.
 */

import { describe, expect, it, vi } from 'vitest'

let seq = 0

async function fresh() {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = `slate-rename-${++seq}`
  const vault = await import('./vault')
  await vault.initVault()
  return { vault, folders: await import('./folders') }
}

const base = (p: string) => p.slice(p.lastIndexOf('/') + 1, -'.md'.length)

describe('renaming onto a name already taken', () => {
  it('sends the links where the note went, not to the note that had the name', async () => {
    const { vault } = await fresh()
    const foo = await vault.createNote('', 'Foo', 'the original Foo')
    const a = await vault.createNote('', 'A', 'note A')
    const linker = await vault.createNote('', 'Linker', 'see [[A]]')
    const moved = await vault.renameNote(a, 'Foo')
    expect(moved).toBe('Foo 2.md')
    // Was `see [[Foo]]` — a link to the other note, with nothing to say so.
    expect(vault.getRaw(linker)?.text).toBe('see [[Foo 2]]')
    expect(vault.resolveLink('Foo 2')).toBe(moved)
    expect(vault.resolveLink('Foo')).toBe(foo)
  })
})

describe('which links a rename takes with it', () => {
  it('leaves a link that meant a different note of the same name', async () => {
    const { vault } = await fresh()
    const workA = await vault.createNote('Work', 'A', 'work A')
    const homeA = await vault.createNote('Home', 'A', 'home A')
    const linker = await vault.createNote('', 'Linker', 'see [[A]]')
    const meant = vault.resolveLink('A')
    const other = meant === workA ? homeA : workA
    await vault.renameNote(other, 'Renamed')
    // It was rewritten to `[[Renamed]]`: taken by a note it never pointed at.
    expect(vault.getRaw(linker)?.text).toBe('see [[A]]')
    expect(vault.resolveLink('A')).toBe(meant)
  })

  it('takes one that did mean it', async () => {
    const { vault } = await fresh()
    const workA = await vault.createNote('Work', 'A', 'work A')
    const homeA = await vault.createNote('Home', 'A', 'home A')
    const linker = await vault.createNote('', 'Linker', 'see [[A]]')
    const meant = vault.resolveLink('A')!
    const moved = await vault.renameNote(meant, 'Renamed')
    expect(vault.getRaw(linker)?.text).toBe('see [[Renamed]]')
    expect(vault.resolveLink('Renamed')).toBe(moved)
    void workA
    void homeA
  })

  it('follows a link written as a path, in the shape it was written', async () => {
    const { vault } = await fresh()
    const a = await vault.createNote('Work', 'A', 'work A')
    const linker = await vault.createNote('', 'Linker', 'see [[Work/A]] and [[Work/A.md]]')
    const moved = await vault.renameNote(a, 'B')
    // A path link was not rewritten at all, and was left pointing at nothing.
    expect(vault.getRaw(linker)?.text).toBe('see [[Work/B]] and [[Work/B.md]]')
    expect(vault.resolveLink('Work/B')).toBe(moved)
  })

  it('writes a path when the new title belongs to another note too', async () => {
    const { vault } = await fresh()
    const homeB = await vault.createNote('Home', 'B', 'home B')
    const a = await vault.createNote('Work', 'A', 'work A')
    const linker = await vault.createNote('', 'Linker', 'see [[A]]')
    const moved = await vault.renameNote(a, 'B')
    expect(moved).toBe('Work/B.md')
    /*
     * `[[B]]` would mean whichever of the two the index met first — and the
     * index meets the most recently *edited* first, so which note a shared
     * title means changes every time either one is touched. A path cannot land
     * anywhere else, whichever that is.
     */
    expect(vault.getRaw(linker)?.text).toBe('see [[Work/B]]')
    expect(vault.resolveLink('Work/B')).toBe(moved)
    expect(vault.resolveLink('Home/B')).toBe(homeB)
  })

  it('leaves a link that reached the note through an alias', async () => {
    const { vault } = await fresh()
    const a = await vault.createNote('', 'A', '---\naliases: [Alpha]\n---\n\nnote A')
    const linker = await vault.createNote('', 'Linker', 'see [[Alpha]] and [[A]]')
    const moved = await vault.renameNote(a, 'B')
    // The alias is written in the note and went with it; how somebody chose
    // to link is theirs.
    expect(vault.getRaw(linker)?.text).toBe('see [[Alpha]] and [[B]]')
    expect(vault.resolveLink('Alpha')).toBe(moved)
  })

  it('keeps a heading, a display name and an embed as they were', async () => {
    const { vault } = await fresh()
    const a = await vault.createNote('', 'A', '# Costs\n\nnote A')
    const linker = await vault.createNote('', 'Linker', '[[A#Costs]] [[A|the plan]] ![[A]]')
    await vault.renameNote(a, 'B')
    expect(vault.getRaw(linker)?.text).toBe('[[B#Costs]] [[B|the plan]] ![[B]]')
  })

  it('leaves a link inside a code block alone', async () => {
    const { vault } = await fresh()
    const a = await vault.createNote('', 'A', 'note A')
    const linker = await vault.createNote('', 'Linker', 'see [[A]]\n\n```\n[[A]]\n```\n')
    await vault.renameNote(a, 'B')
    expect(vault.getRaw(linker)?.text).toBe('see [[B]]\n\n```\n[[A]]\n```\n')
  })

  it('takes a link the note makes to itself', async () => {
    const { vault } = await fresh()
    const a = await vault.createNote('', 'A', '# Costs\n\nsee [[A#Costs]]')
    const moved = await vault.renameNote(a, 'B')
    expect(vault.getRaw(moved)?.text).toBe('# Costs\n\nsee [[B#Costs]]')
  })
})

describe('moving a note into a folder', () => {
  it('never overwrites the note that already has its name there', async () => {
    const { vault, folders } = await fresh()
    const work = await vault.createNote('Work', 'Foo', 'WORK FOO')
    const home = await vault.createNote('Home', 'Foo', 'home foo')
    const dest = await folders.moveNoteToFolder(home, 'Work')
    // It moved straight onto `Work/Foo.md`, and that note was gone.
    expect(vault.getRaw(work)?.text).toBe('WORK FOO')
    expect(dest).toBe('Work/Foo 2.md')
    expect(vault.getRaw(dest)?.text).toBe('home foo')
  })

  it('takes its links along when the move has to rename it', async () => {
    const { vault, folders } = await fresh()
    await vault.createNote('Work', 'Foo', 'WORK FOO')
    const home = await vault.createNote('Home', 'Foo', 'home foo')
    const linker = await vault.createNote('', 'Linker', 'see [[Home/Foo]]')
    const dest = await folders.moveNoteToFolder(home, 'Work')
    expect(vault.getRaw(linker)?.text).toBe('see [[Work/Foo 2]]')
    expect(vault.resolveLink('Work/Foo 2')).toBe(dest)
  })

  it('keeps its name where nothing is in the way', async () => {
    const { vault, folders } = await fresh()
    const home = await vault.createNote('Home', 'Foo', 'home foo')
    const linker = await vault.createNote('', 'Linker', 'see [[Foo]]')
    const dest = await folders.moveNoteToFolder(home, 'Work')
    expect(dest).toBe('Work/Foo.md')
    expect(vault.getRaw(linker)?.text).toBe('see [[Foo]]')
    expect(vault.resolveLink('Foo')).toBe(dest)
  })
})

describe('the move underneath every rename', () => {
  it('refuses to write over a note that is there', async () => {
    const { vault } = await fresh()
    const a = await vault.createNote('', 'A', 'note A')
    const b = await vault.createNote('', 'B', 'note B')
    await expect(vault.movePath(a, b)).rejects.toThrow(/already exists/)
    expect(vault.getRaw(b)?.text).toBe('note B')
    expect(vault.getRaw(a)?.text).toBe('note A')
  })

  it('but a deleted note’s tombstone is not in the way', async () => {
    const { vault } = await fresh()
    const gone = await vault.createNote('', 'Gone', 'deleted')
    await vault.deleteNote(gone)
    const a = await vault.createNote('', 'A', 'note A')
    await vault.movePath(a, gone)
    expect(vault.getRaw(gone)?.text).toBe('note A')
  })
})

describe('the counter a name already taken is given', () => {
  it('fits inside the limit when a note is made', async () => {
    const { vault } = await fresh()
    const long = 'M'.repeat(200)
    await vault.createNote('', long)
    const second = await vault.createNote('', long)
    expect(base(second).length).toBe(120)
    expect(base(second).endsWith(' 2')).toBe(true)
  })

  it('and when one is renamed onto a name already in use', async () => {
    const { vault } = await fresh()
    const long = 'M'.repeat(200)
    await vault.createNote('', long)
    const other = await vault.createNote('', 'Other')
    const renamed = await vault.renameNote(other, long)
    expect(base(renamed).length).toBe(120)
    expect(base(renamed).endsWith(' 2')).toBe(true)
  })

  it('and when one is moved into a folder that has its name', async () => {
    const { vault, folders } = await fresh()
    const long = 'M'.repeat(200)
    await vault.createNote('Work', long)
    const home = await vault.createNote('Home', long)
    const dest = await folders.moveNoteToFolder(home, 'Work')
    expect(base(dest).length).toBe(120)
    expect(base(dest).endsWith(' 2')).toBe(true)
  })
})
