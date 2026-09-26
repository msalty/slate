// @vitest-environment jsdom
/**
 * The menu on a row of the note list.
 *
 * Two things it used to get wrong. Pin wrote the note as it was when the menu
 * opened, so anything that changed it before the tap — the other window, a
 * pull — was written back over. And on a note an importer owns, the items that
 * write to the file made an edit the importer overwrites. Moving one is not an
 * edit: the importer finds its files by `uid:` wherever they are.
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
  /*
   * The menu decides what to offer when it opens. A pull that made the note
   * an import while the menu was up still had Pin write into it.
   */
  it('will not pin a note that became an import while the menu was open', async () => {
    const { vault, noteMenu } = await fresh()
    const path = await vault.createNote('', 'Standup', 'Notes.\n')
    const items = noteMenu(vault.getEntry(path)!)
    await vault.saveNote(path, IMPORTED)
    await items.find((i) => i.label === 'Pin to top')!.onSelect()
    expect(vault.getText(path)).toBe(IMPORTED)
  })

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

  it('offers no pin on a note an importer owns, and still offers to move it', async () => {
    const { vault, noteMenu } = await fresh()
    await vault.createNote('Elsewhere', 'Other', 'x\n')
    const path = await vault.createNote('Calendar', 'Standup', IMPORTED)
    const items = noteMenu(vault.getEntry(path)!)
    expect(items.some((i) => /Pin|Unpin/.test(i.label))).toBe(false)
    expect(items.find((i) => i.label.startsWith('Move to'))?.disabled).toBe(false)
  })

  /*
   * A copy beside an import lands in the importer's folder, which is emptied
   * wholesale, and keeps its `start:` — the meeting twice on the agenda.
   */
  it('offers no duplicate of an import', async () => {
    const { vault, noteMenu } = await fresh()
    const path = await vault.createNote('Calendar', 'Standup', IMPORTED)
    expect(noteMenu(vault.getEntry(path)!).some((i) => i.label === 'Duplicate')).toBe(false)
  })

  it('moves an import like any other file, leaving its text as the importer wrote it', async () => {
    const { vault } = await fresh()
    const folders = await import('../core/folders')
    const path = await vault.createNote('Calendar', 'Standup', IMPORTED)
    const dest = await folders.moveNoteToFolder(path, 'Work')
    expect(dest).toBe('Work/Standup.md')
    expect(vault.getText(dest)).toBe(IMPORTED)
    expect(vault.getEntry(dest)?.source).toBe('work')
  })
})

describe('dragging a note onto a folder', () => {
  const drop = (path: string) =>
    ({
      currentTarget: document.createElement('div'),
      preventDefault: () => {},
      dataTransfer: { getData: () => path },
    }) as unknown as DragEvent

  it('moves one of your own', async () => {
    const { vault } = await fresh()
    const drag = await import('./dragNote')
    const path = await vault.createNote('', 'Mine', 'x\n')
    drag.draggingNote.value = path
    expect(drag.acceptsDrop('Work')).toBe(true)
    await drag.folderDropProps('Work').onDrop(drop(path))
    expect(vault.notes.value.map((n) => n.path)).toEqual(['Work/Mine.md'])
  })
})
