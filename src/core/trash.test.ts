/**
 * Deleted: the list, and the two ways things leave it.
 *
 * The list being *live* is the thing worth pinning down. It was a plain
 * function wrapped in a `computed()` by the UI, which gave that computed no
 * dependencies at all — so it answered once, cached the answer forever, and
 * every delete looked like a delete that had done nothing. Each test here
 * therefore reads the list *before* it changes it, because reading first is
 * what makes a stale computed stale.
 */

import { describe, expect, it, vi } from 'vitest'

type Vault = typeof import('./vault')

let seq = 0

async function fresh(): Promise<Vault> {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = `slate-trash-${++seq}`
  const vault = await import('./vault')
  await vault.initVault()
  return vault
}

function names(v: Vault): string[] {
  return v.trashFiles.value.map((f) => v.trashDisplayName(f.path)).sort()
}

describe('the Deleted list', () => {
  it('picks up something deleted after it has already been read', async () => {
    const v = await fresh()
    const p = await v.createNote('', 'Draft', 'text\n')
    expect(names(v)).toEqual([])

    await v.deleteNote(p)
    expect(names(v)).toEqual(['Draft.md'])
  })

  it('drops a note deleted for good', async () => {
    const v = await fresh()
    await v.deleteNote(await v.createNote('', 'Keep', 'a\n'))
    await v.deleteNote(await v.createNote('', 'Toss', 'b\n'))
    expect(names(v)).toEqual(['Keep.md', 'Toss.md'])

    const toss = v.trashFiles.value.find((f) => v.trashDisplayName(f.path) === 'Toss.md')!
    await v.purge(toss.path)

    expect(names(v)).toEqual(['Keep.md'])
  })

  it('drops one restored back into the vault, under its own name', async () => {
    const v = await fresh()
    await v.deleteNote(await v.createNote('', 'Second thoughts', 'a\n'))
    expect(names(v)).toEqual(['Second thoughts.md'])

    const back = await v.restoreFromTrash(v.trashFiles.value[0].path)

    expect(names(v)).toEqual([])
    // Not "Second thoughts 2": the only thing at the old path is the tombstone
    // the delete left behind, and a tombstone is not a file in the way.
    expect(back).toBe('Second thoughts.md')
    expect(v.notes.value.map((n) => n.title)).toEqual(['Second thoughts'])
  })

  it('still steps around a file that is really there', async () => {
    const v = await fresh()
    await v.createNote('', 'Notes', 'the root one\n')
    // Restores land back at the vault root under their own name, and this one
    // shares a name with a note that is sitting there — so it has to move over
    // rather than write on top of it.
    await v.deleteNote(await v.createNote('Archive', 'Notes', 'the filed one\n'))

    const back = await v.restoreFromTrash(v.trashFiles.value[0].path)

    expect(back).toBe('Notes 2.md')
    expect(v.getText('Notes.md')).toBe('the root one\n')
    expect(v.getText('Notes 2.md')).toBe('the filed one\n')
  })

  it('empties in one go, and says how many went', async () => {
    const v = await fresh()
    await v.deleteNote(await v.createNote('', 'One', 'a\n'))
    await v.deleteNote(await v.createNote('', 'Two', 'b\n'))
    await v.deleteFile(await v.addAttachment(new Blob(['x'], { type: 'image/png' }), 'shot.png'))
    expect(v.trashFiles.value).toHaveLength(3)

    expect(await v.emptyTrash()).toBe(3)
    expect(v.trashFiles.value).toEqual([])
  })

  it('leaves a tombstone, so sync takes the remote copy with it', async () => {
    const v = await fresh()
    await v.deleteNote(await v.createNote('', 'Gone', 'a\n'))
    const path = v.trashFiles.value[0].path

    await v.purge(path)

    // Still a row, but a dead one: that is what tells the sync engine to
    // remove the file from the remote rather than pull it back down.
    const row = v.getRaw(path)
    expect(row?.deleted).toBe(true)
    expect(row?.dirty).toBe(true)
    expect(names(v)).toEqual([])
  })
})
