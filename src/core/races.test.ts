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

/** A vault whose database calls run `hooks` first — a window of its own over `db`. */
async function vaultWith(hooks: Hooks, db = `slate-races-${++seq}`) {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = db
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

describe('a rename onto a name something else takes meanwhile', () => {
  /*
   * The links were rewritten before the move found `B.md` taken: the rename
   * failed, `A` stayed where it was, and every `[[A]]` read `[[B]]` — a link to
   * the other note.
   */
  it('leaves every link to the note as it was', async () => {
    const hooks: Hooks = {}
    const vault = await vaultWith(hooks)
    const a = await vault.createNote('', 'A', 'a')
    const ref = await vault.createNote('', 'Ref', 'see [[A]]')
    let renaming: Promise<unknown> | undefined
    hooks.putFile = async (f) => {
      if (renaming || f.path !== 'B.md') return
      renaming = vault.renameNote(a, 'B').catch((e: Error) => e)
      await settle()
    }
    await vault.createNote('', 'B', 'unrelated')
    const outcome = await renaming
    expect(outcome).toBeInstanceOf(Error)
    expect(vault.getText(ref)).toBe('see [[A]]')
    expect(vault.getText(a)).toBe('a')
    expect(vault.getText('B.md')).toBe('unrelated')
  })

  it('and a note made while a rename is under way takes another name', async () => {
    const hooks: Hooks = {}
    const vault = await vaultWith(hooks)
    const a = await vault.createNote('', 'A', 'a')
    const ref = await vault.createNote('', 'Ref', 'see [[A]]')
    let making: Promise<string> | undefined
    hooks.putFile = async (f) => {
      if (making || f.path !== 'B.md' || f.text !== 'a') return
      making = vault.createNote('', 'B', 'unrelated')
      await settle()
    }
    expect(await vault.renameNote(a, 'B')).toBe('B.md')
    expect(await making).toBe('B 2.md')
    expect(vault.getText(ref)).toBe('see [[B]]')
    expect(vault.getText('B.md')).toBe('a')
  })
})

describe('a move the database refuses', () => {
  /*
   * The destination was adopted before it was written: when the write failed,
   * `B.md` stayed in memory — nowhere on disk, but in the way of a retry.
   */
  it('leaves nothing behind at the destination, and can be tried again', async () => {
    const hooks: Hooks = {}
    const vault = await vaultWith(hooks)
    const a = await vault.createNote('', 'A', 'a')
    let refused = false
    hooks.putFile = (f) => {
      if (refused || f.path !== 'B.md') return
      refused = true
      throw new Error('QuotaExceededError')
    }
    await expect(vault.renameNote(a, 'B')).rejects.toThrow('Quota')
    expect(vault.getRaw('B.md')).toBeUndefined()
    expect(vault.getText(a)).toBe('a')
    expect(await vault.renameNote(a, 'B')).toBe('B.md')
  })

  it('part way through, puts back what it had written', async () => {
    const hooks: Hooks = {}
    const vault = await vaultWith(hooks)
    const a = await vault.createNote('', 'A', 'a')
    let refused = false
    hooks.putFile = (f) => {
      if (refused || f.path !== a || !f.deleted) return
      refused = true
      throw new Error('QuotaExceededError')
    }
    await expect(vault.renameNote(a, 'B')).rejects.toThrow('Quota')
    expect(vault.getRaw('B.md')).toBeUndefined()
    expect(vault.getText(a)).toBe('a')
    await vault.initVault()
    expect(vault.getRaw('B.md')).toBeUndefined()
    expect(vault.getText(a)).toBe('a')
  })
})

describe('a note renamed in another window', () => {
  /*
   * The other window saw a new `B.md` and a deleted `A.md`, dropped the note's
   * identity with `A`, and an answer being written there about it could no
   * longer find it.
   */
  it('is still the same note here', async () => {
    const db = `slate-races-${++seq}`
    const here = await vaultWith({}, db)
    const there = await vaultWith({}, db)
    there.onVaultWrite((paths) => void here.adoptFromStorage(paths))
    // Optional here only so this reads as a failure, not a crash, against code without it.
    there.onVaultMove?.((from, to) => here.adoptMove(from, to))
    await there.createNote('', 'A', 'a')
    await vi.waitFor(() => expect(here.getText('A.md')).toBe('a'))
    const id = here.noteId('A.md')!
    await there.renameNote('A.md', 'B')
    await vi.waitFor(() => expect(here.getText('B.md')).toBe('a'))
    await vi.waitFor(() => expect(here.occupied('A.md')).toBe(false))
    expect(here.notePath(id)).toBe('B.md')
  })
})
