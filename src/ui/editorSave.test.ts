// @vitest-environment jsdom
/**
 * Which buffers the editor may save.
 *
 * An imported note's buffer cannot be typed in, so saving it can only ever put
 * back an older copy of what the importer wrote — and a pending save of one
 * rewrite used to land over the next. But the rule has to read the vault too:
 * somebody typing `source:` and `uid:` into a note of their own has a buffer
 * that says "imported", and that keystroke must be saved like any other.
 */

import { describe, expect, it, vi } from 'vitest'

let seq = 0

async function fresh() {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = `slate-editorsave-${++seq}`
  const vault = await import('../core/vault')
  await vault.initVault()
  const { importerOwns } = await import('./EditorPane')
  return { vault, importerOwns }
}

const OWNED = '---\nsource: work\nuid: u1\n---\n\nv2\n'

describe('saving a buffer', () => {
  it('skips an import, which nobody could have typed into', async () => {
    const { vault, importerOwns } = await fresh()
    const path = await vault.createNote('', 'Standup', '---\nsource: work\nuid: u1\n---\n\nv3\n')
    expect(importerOwns(path, OWNED)).toBe(true)
  })

  it('saves the keystroke that makes a note of your own look imported', async () => {
    const { vault, importerOwns } = await fresh()
    const path = await vault.createNote('', 'Mine', '---\nsource: work\n---\n\nv1\n')
    expect(importerOwns(path, OWNED)).toBe(false)
  })

  /*
   * Detach moves the note before the buffer has caught up, and the editor
   * flushes as it follows the note: the old path is a tombstone by then, and
   * saving the imported buffer there brought the import back.
   */
  it('skips an import over a path with nothing live at it', async () => {
    const { vault, importerOwns } = await fresh()
    const path = await vault.createNote('', 'Standup', OWNED)
    await vault.relocateNote(path, 'Elsewhere/Standup.md')
    expect(importerOwns(path, OWNED)).toBe(true)
    expect(importerOwns('Nowhere.md', OWNED)).toBe(true)
  })

  it('saves a buffer once the vault has it detached', async () => {
    const { vault, importerOwns } = await fresh()
    const path = await vault.createNote('', 'Standup', '\nv2\n')
    expect(importerOwns(path, '\nv2\n')).toBe(false)
  })
})
