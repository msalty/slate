/**
 * Two writes to one file at the same moment.
 *
 * Each of these lost an edit before the rule was made structural — every change
 * to a file's record holds that path's lock (see `mustHold` in vault.ts). The
 * database layer is wrapped so a write can be held open long enough for the
 * other one to run, which is what a slow disk or a busy tab does for real.
 */

import { describe, expect, it, vi } from 'vitest'
import type { VaultFile } from './types'

let seq = 0

type Hooks = {
  putFile?: (f: VaultFile) => Promise<void> | void
  getFiles?: (paths: string[]) => Promise<void> | void
}

/** A vault whose database calls run `hooks` first. */
async function vaultWith(hooks: Hooks) {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = `slate-races-${++seq}`
  vi.doMock('./db', async (importOriginal) => {
    const db = await importOriginal<typeof import('./db')>()
    return {
      ...db,
      putFile: async (f: VaultFile) => {
        await hooks.putFile?.(f)
        return db.putFile(f)
      },
      getFiles: async (paths: string[]) => {
        const rows = await db.getFiles(paths)
        await hooks.getFiles?.(paths)
        return rows
      },
    }
  })
  try {
    const vault = await import('./vault')
    await vault.initVault()
    return vault
  } finally {
    vi.doUnmock('./db')
  }
}

const settle = () => new Promise((r) => setTimeout(r, 50))

describe('a note deleted while an edit to it is being saved', () => {
  /*
   * The move to the trash copied the note without waiting for the save, so the
   * deleted copy was the text from before the edit.
   */
  it('goes to the trash with the edit', async () => {
    const hooks: Hooks = {}
    const vault = await vaultWith(hooks)
    const path = await vault.createNote('', 'Note', 'base')
    let deleting: Promise<void> | undefined
    hooks.putFile = async (f) => {
      if (deleting || f.path !== path || f.text !== 'local edit') return
      deleting = vault.deleteNote(path)
      await settle()
    }
    await vault.saveNote(path, 'local edit')
    await deleting
    const [trashed] = vault.trashItems()
    expect(trashed.text).toBe('local edit')
    expect(vault.occupied(path)).toBe(false)
  })
})

describe('settings saved while their sync record is being written', () => {
  /*
   * `writeBackstage` took no lock, so the sync stamp — writing the file as it
   * was when it started — put the old settings back, in memory and on disk.
   */
  it('keep the new settings', async () => {
    const hooks: Hooks = {}
    const vault = await vaultWith(hooks)
    await vault.writeBackstage('config.json', { theme: 'old' })
    const path = 'backstage/config.json'
    const f = vault.getRaw(path)!
    let saving: Promise<void> | undefined
    hooks.putFile = async (row) => {
      if (saving || row.path !== path || row.sync?.remoteRev !== 'r1') return
      saving = vault.writeBackstage('config.json', { theme: 'new' })
      await settle()
    }
    await vault.markSynced(path, { baseHash: f.hash, baseText: f.text, remoteRev: 'r1' })
    await saving
    expect(await vault.readBackstage('config.json')).toEqual({ theme: 'new' })
    await vault.initVault()
    expect(await vault.readBackstage('config.json')).toEqual({ theme: 'new' })
  })
})

describe('another window’s change, arriving as a note is saved here', () => {
  /*
   * The rows were read before the save and adopted after it, so the note on
   * screen went back to the text from before the save.
   */
  it('does not put the note back to what it was', async () => {
    const hooks: Hooks = {}
    const vault = await vaultWith(hooks)
    const path = await vault.createNote('', 'Note', 'base')
    let saving: Promise<void> | undefined
    hooks.getFiles = async (paths) => {
      if (saving || !paths.includes(path)) return
      saving = vault.saveNote(path, 'local edit')
      await settle()
    }
    await vault.adoptFromStorage([path])
    await saving
    expect(vault.getText(path)).toBe('local edit')
  })
})
