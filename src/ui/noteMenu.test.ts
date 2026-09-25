// @vitest-environment jsdom
/**
 * The menu on a row of the note list.
 *
 * Two things it used to get wrong. Pin wrote the note as it was when the menu
 * opened, so anything that changed it before the tap — the other window, a
 * pull — was written back over. And on a note an importer owns, every item
 * that writes to the file or moves it made a copy the importer would not know:
 * an edit it overwrites, or a file it writes afresh where the moved one was.
 */

import { describe, expect, it, vi } from 'vitest'

let seq = 0

async function fresh() {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = `slate-notemenu-${++seq}`
  const vault = await import('../core/vault')
  await vault.initVault()
  const { noteMenu } = await import('./NoteList')
  return { vault, noteMenu }
}

const IMPORTED = '---\ntitle: Standup\nsource: work\nuid: u1\n---\n\nNotes.\n'

describe('the note menu', () => {
  it('pins the note as it is now, not as it was when the menu opened', async () => {
    const { vault, noteMenu } = await fresh()
    const path = await vault.createNote('', 'Note', 'first\n')
    const items = noteMenu(vault.getEntry(path)!)
    await vault.saveNote(path, 'first\nsecond\n')
    await items.find((i) => i.label === 'Pin to top')!.onSelect()
    const text = vault.getText(path)!
    expect(text).toContain('pinned: true')
    expect(text).toContain('second')
  })

  it('offers no pin, and no move, on a note an importer owns', async () => {
    const { vault, noteMenu } = await fresh()
    await vault.createNote('Elsewhere', 'Other', 'x\n')
    const path = await vault.createNote('Calendar', 'Standup', IMPORTED)
    const items = noteMenu(vault.getEntry(path)!)
    expect(items.some((i) => /Pin|Unpin/.test(i.label))).toBe(false)
    expect(items.find((i) => i.label.startsWith('Move to'))?.disabled).toBe(true)
  })

  it('duplicates an imported note as one of your own', async () => {
    const { vault, noteMenu } = await fresh()
    const path = await vault.createNote('Calendar', 'Standup', IMPORTED)
    await noteMenu(vault.getEntry(path)!)
      .find((i) => i.label === 'Duplicate')!
      .onSelect()
    const copy = vault.notes.value.find((n) => n.title === 'Standup copy')!
    expect(copy.source).toBeUndefined()
    expect(vault.getText(copy.path)).not.toMatch(/^uid:/m)
    expect(vault.getText(copy.path)).toContain('title: Standup')
  })
})

describe('dragging a note onto a folder', () => {
  const drop = (path: string) =>
    ({
      currentTarget: document.createElement('div'),
      preventDefault: () => {},
      dataTransfer: { getData: () => path },
    }) as unknown as DragEvent

  it('does not move a note an importer owns, and lights no folder for it', async () => {
    const { vault } = await fresh()
    const drag = await import('./dragNote')
    const path = await vault.createNote('Calendar', 'Standup', IMPORTED)
    drag.draggingNote.value = path
    expect(drag.acceptsDrop('Work')).toBe(false)
    await drag.folderDropProps('Work').onDrop(drop(path))
    expect(vault.getEntry(path)).toBeDefined()
    expect(vault.notes.value.map((n) => n.path)).toEqual([path])
  })

  it('still moves one of your own', async () => {
    const { vault } = await fresh()
    const drag = await import('./dragNote')
    const path = await vault.createNote('', 'Mine', 'x\n')
    drag.draggingNote.value = path
    expect(drag.acceptsDrop('Work')).toBe(true)
    await drag.folderDropProps('Work').onDrop(drop(path))
    expect(vault.notes.value.map((n) => n.path)).toEqual(['Work/Mine.md'])
  })
})
