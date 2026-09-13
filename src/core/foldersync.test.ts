/**
 * Connected Folder round-trip tests.
 *
 * A "device" is a freshly-imported copy of the app's modules with its own
 * IndexedDB, and it can have two targets at once: a folder on disk (an
 * in-memory File System Access store standing in for it) and a cloud backend
 * shared with a second device. That is the arrangement the feature exists for —
 * Obsidian and Slate on one desk, a phone in a pocket — so it is the
 * arrangement the tests run.
 *
 * The property under test throughout is the engine's first rule: after any
 * sequence of edits on any side, no content is lost.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryAdapter, MemoryServer } from '../adapters/memory'
import { fakeRoot, type FakeDirectoryHandle } from '../test/fakefs'

type Device = {
  name: string
  vault: typeof import('./vault')
  cloud: typeof import('./sync')
  /** The folder engine, once a folder has been attached. */
  folder: import('./engine').SyncEngine
  attach: (root: FileSystemDirectoryHandle) => void
}

let seq = 0

async function makeDevice(name: string): Promise<Device> {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = `slate-folder-${name}-${seq++}`
  const vault = await import('./vault')
  const cloud = await import('./sync')
  const devices = await import('./devices')
  const { SyncEngine } = await import('./engine')
  const { FOLDER_ENGINE } = await import('./foldersync')
  const { FolderAdapter } = await import('../adapters/folder')

  devices.setLocalDevice(`id-${name}`, name)
  await vault.initVault()
  cloud.setDeviceLabel(name)

  const folder = new SyncEngine(FOLDER_ENGINE)
  return {
    name,
    vault,
    cloud,
    folder,
    attach: (root) => folder.setAdapter(new FolderAdapter(root)),
  }
}

/** Reconcile the folder, then the cloud — the order a real session settles in. */
async function settle(d: Device) {
  await d.folder.run()
  await d.cloud.sync()
  await d.folder.run()
}

function titles(d: Device): string[] {
  return d.vault.notes.value.map((n) => n.path).sort()
}

describe('a folder connected to a vault', () => {
  let root: FakeDirectoryHandle & FileSystemDirectoryHandle
  let A: Device

  beforeEach(async () => {
    root = fakeRoot()
    A = await makeDevice('Mac')
    A.attach(root)
  })

  it('writes a note typed in Slate out as a plain file', async () => {
    await A.vault.createNote('Work', 'Standup', '# Standup\n\n- ship it\n')
    await A.folder.run()
    expect(root.readText('Work/Standup.md')).toBe('# Standup\n\n- ship it\n')
  })

  it('reads a note created by another program into the vault', async () => {
    root.writeText('Ideas.md', '# Ideas\n\nsomething from Obsidian\n')
    await A.folder.run()
    expect(A.vault.getText('Ideas.md')).toBe('# Ideas\n\nsomething from Obsidian\n')
    expect(titles(A)).toContain('Ideas.md')
  })

  it('round-trips an attachment as bytes', async () => {
    root.writeBytes('img/shot.png', new Uint8Array([137, 80, 78, 71]), 'image/png')
    await A.folder.run()
    const f = A.vault.getRaw('img/shot.png')
    expect(f?.kind).toBe('attachment')
    expect(new Uint8Array(await f!.blob!.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]))
  })

  it('does not read its own writes back as somebody else’s edit', async () => {
    await A.vault.createNote('', 'Note', 'first')
    await A.folder.run()
    const after = A.vault.getRaw('Note.md')!
    expect(after.folder?.baseHash).toBe(after.hash)

    // A second sweep with nothing changed must be a no-op — otherwise every
    // write bounces back as a pull and the two sides never stop talking.
    const mtimeBefore = after.mtime
    await A.folder.run()
    expect(A.vault.getRaw('Note.md')!.mtime).toBe(mtimeBefore)
    expect(A.vault.getRaw('Note.md')!.folder?.baseHash).toBe(after.hash)
    expect(A.vault.folderPendingCount()).toBe(0)
  })

  it('merges an outside edit with an unsaved one when they touch different lines', async () => {
    const path = await A.vault.createNote('', 'Shared', 'one\ntwo\nthree\n')
    await A.folder.run()

    // Obsidian rewrites the first line; Slate rewrites the last.
    root.writeText('Shared.md', 'ONE\ntwo\nthree\n')
    await A.vault.saveNote(path, 'one\ntwo\nTHREE\n')

    await A.folder.run()
    expect(A.vault.getText(path)).toBe('ONE\ntwo\nTHREE\n')
    // And the merged text goes straight back out, so both programs agree.
    expect(root.readText('Shared.md')).toBe('ONE\ntwo\nTHREE\n')
  })

  it('keeps both versions when an outside edit overlaps an unsaved one', async () => {
    const path = await A.vault.createNote('', 'Clash', 'original line\n')
    await A.folder.run()

    root.writeText('Clash.md', 'the folder’s version\n')
    await A.vault.saveNote(path, 'the vault’s version\n')
    await A.folder.run()

    // The buffer the user is looking at is never yanked away…
    expect(A.vault.getText(path)).toBe('the vault’s version\n')
    // …and the other side is kept beside it rather than discarded.
    const copy = titles(A).find((p) => p.includes('conflict'))
    expect(copy).toBeTruthy()
    expect(A.vault.getText(copy!)).toContain('the folder’s version')
    expect(A.vault.getText(copy!)).toContain('in the connected folder')
    // Both are on disk after the next sweep, so Obsidian sees the divergence too.
    await A.folder.run()
    expect(root.readText('Clash.md')).toBe('the vault’s version\n')
    expect(root.readText(`${copy}`)).toContain('the folder’s version')
  })

  it('deletes the file when the note is deleted in Slate', async () => {
    const path = await A.vault.createNote('', 'Doomed', 'bye')
    await A.folder.run()
    expect(root.has('Doomed.md')).toBe(true)

    await A.vault.deleteNote(path)
    await A.folder.run()
    expect(root.has('Doomed.md')).toBe(false)
    // Deleting is a move to the trash, which is a vault folder like any other,
    // so it is on disk and the note is still recoverable from either side.
    expect(root.paths().some((p) => p.startsWith('backstage/trash/'))).toBe(true)
  })

  it('accepts a file deleted by another program, and does not resurrect it', async () => {
    await A.vault.createNote('', 'Gone', 'x')
    await A.folder.run()
    root.unlink('Gone.md')

    await A.folder.run()
    expect(titles(A)).not.toContain('Gone.md')
    // Twice, because a delete that is re-pushed on the next sweep is a delete
    // that never happened.
    await A.folder.run()
    expect(root.has('Gone.md')).toBe(false)
    expect(titles(A)).not.toContain('Gone.md')
  })

  it('resurrects rather than deletes when the file was edited after the note was', async () => {
    const path = await A.vault.createNote('', 'Contested', 'v1')
    await A.folder.run()

    // Deleted here, but somebody was writing to it at the same time.
    await A.vault.deleteNote(path)
    root.writeText('Contested.md', 'work you have not seen')

    await A.folder.run()
    expect(A.vault.getText('Contested.md')).toBe('work you have not seen')
  })

  it('takes an existing folder of notes without treating identical files as conflicts', async () => {
    // The same vault reaching a folder that already holds it — a second device
    // pointed at a Dropbox copy, or a folder reconnected after a reload.
    await A.vault.createNote('', 'Same', 'identical\n')
    await A.folder.run()

    const B = await makeDevice('Linux')
    await B.vault.createNote('', 'Same', 'identical\n')
    B.attach(root)
    await B.folder.run()

    expect(titles(B)).toEqual(['Same.md'])
    expect(B.vault.getText('Same.md')).toBe('identical\n')
  })
})

describe('a folder beside a cloud backend', () => {
  let root: FakeDirectoryHandle & FileSystemDirectoryHandle
  let server: MemoryServer
  /** The desktop: a folder on disk and a backend. */
  let desk: Device
  /** The phone: the backend only, which is the whole point of having one. */
  let phone: Device

  beforeEach(async () => {
    root = fakeRoot()
    server = new MemoryServer()
    desk = await makeDevice('Mac')
    desk.attach(root)
    desk.cloud.setAdapter(new MemoryAdapter(server))
    phone = await makeDevice('iPhone')
    phone.cloud.setAdapter(new MemoryAdapter(server))
  })

  it('carries a note written in Obsidian all the way to a device that cannot see the folder', async () => {
    root.writeText('Groceries.md', '- oat milk\n')

    await settle(desk)
    await phone.cloud.sync()

    expect(phone.vault.getText('Groceries.md')).toBe('- oat milk\n')
  })

  it('writes a note typed on the phone onto the desktop’s disk', async () => {
    await phone.vault.createNote('', 'From the train', 'thought\n')
    await phone.cloud.sync()

    await settle(desk)

    expect(root.readText('From the train.md')).toBe('thought\n')
    expect(desk.vault.getText('From the train.md')).toBe('thought\n')
  })

  it('replicates a phone’s delete through to the file on disk, and it stays deleted', async () => {
    root.writeText('Temporary.md', 'draft\n')
    await settle(desk)
    await phone.cloud.sync()
    expect(phone.vault.getText('Temporary.md')).toBe('draft\n')

    await phone.vault.deleteNote('Temporary.md')
    await phone.cloud.sync()

    await settle(desk)
    expect(root.has('Temporary.md')).toBe(false)

    /*
     * The case this whole arrangement can get wrong. Accepting a deletion from
     * one target and simply forgetting the file leaves the *other* target still
     * holding it, so the next sweep reads that copy as a new note and pushes it
     * back — the note reappears on the phone, and keeps reappearing. Several
     * more rounds, to prove it does not.
     */
    await settle(desk)
    await phone.cloud.sync()
    await settle(desk)
    expect(root.has('Temporary.md')).toBe(false)
    expect(titles(desk)).not.toContain('Temporary.md')
    expect(titles(phone)).not.toContain('Temporary.md')
  })

  it('replicates a delete made on disk through to the phone', async () => {
    root.writeText('Scratch.md', 'x\n')
    await settle(desk)
    await phone.cloud.sync()
    expect(titles(phone)).toContain('Scratch.md')

    root.unlink('Scratch.md')
    await settle(desk)
    await phone.cloud.sync()

    expect(titles(phone)).not.toContain('Scratch.md')
    // And again, from both sides, to be sure nothing brings it back.
    await settle(desk)
    await phone.cloud.sync()
    expect(titles(phone)).not.toContain('Scratch.md')
    expect(root.has('Scratch.md')).toBe(false)
  })

  it('merges an edit made in Obsidian with one made on the phone', async () => {
    root.writeText('Plan.md', 'alpha\nbeta\ngamma\n')
    await settle(desk)
    await phone.cloud.sync()

    // Two people, two places, two different lines.
    root.writeText('Plan.md', 'ALPHA\nbeta\ngamma\n')
    await phone.vault.saveNote('Plan.md', 'alpha\nbeta\nGAMMA\n')
    await phone.cloud.sync()

    await settle(desk)
    await phone.cloud.sync()
    await settle(desk)

    expect(desk.vault.getText('Plan.md')).toBe('ALPHA\nbeta\nGAMMA\n')
    expect(phone.vault.getText('Plan.md')).toBe('ALPHA\nbeta\nGAMMA\n')
    expect(root.readText('Plan.md')).toBe('ALPHA\nbeta\nGAMMA\n')
  })

  it('settles with all three sides holding the same thing', async () => {
    root.writeText('A.md', 'from the folder\n')
    await phone.vault.createNote('', 'B', 'from the phone\n')
    await desk.vault.createNote('', 'C', 'from the desktop\n')

    await phone.cloud.sync()
    await settle(desk)
    await phone.cloud.sync()
    await settle(desk)

    const want = ['A.md', 'B.md', 'C.md']
    expect(titles(desk)).toEqual(want)
    expect(titles(phone)).toEqual(want)
    for (const p of want) expect(root.readText(p)).toBe(desk.vault.getText(p))
  })

  it('leaves nothing pending once everything has settled', async () => {
    root.writeText('One.md', '1\n')
    await desk.vault.createNote('', 'Two', '2\n')
    await settle(desk)
    await settle(desk)

    expect(desk.vault.dirtyCount()).toBe(0)
    expect(desk.vault.folderPendingCount()).toBe(0)
  })
})

describe('disconnecting a folder', () => {
  it('leaves every file where it is and keeps every note', async () => {
    const root = fakeRoot()
    root.writeText('Kept.md', 'still here\n')
    const A = await makeDevice('Mac')
    A.attach(root)
    await A.vault.createNote('', 'Mine', 'also here\n')
    await A.folder.run()

    const before = root.paths()
    expect(before).toContain('Kept.md')
    expect(before).toContain('Mine.md')

    await A.vault.clearFolderMeta()
    A.folder.setAdapter(undefined)

    // Nothing on disk moved…
    expect(root.paths()).toEqual(before)
    expect(root.readText('Kept.md')).toBe('still here\n')
    // …and nothing left the vault.
    expect(titles(A)).toEqual(['Kept.md', 'Mine.md'])
    // The folder's record of every file is gone, so a later reconnect starts
    // from nothing rather than from a description of a directory that may since
    // have been replaced.
    expect(A.vault.getRaw('Kept.md')!.folder).toBeUndefined()
    expect(A.vault.folderPendingCount()).toBe(2)
  })

  it('does not strand a tombstone that only the folder still owed', async () => {
    const root = fakeRoot()
    const A = await makeDevice('Mac')
    A.attach(root)
    A.cloud.setAdapter(new MemoryAdapter(new MemoryServer()))
    const path = await A.vault.createNote('', 'Doomed', 'x')
    await settle(A)

    // Deleted, and the server has honoured it — so the only party still owed
    // the deletion is the folder…
    await A.vault.deleteNote(path)
    await A.cloud.sync()
    expect(A.vault.getRaw(path)?.deleted).toBe(true)

    // …and then the folder goes away. The row has nobody left to answer to and
    // must not sit in the database forever waiting for one.
    await A.vault.clearFolderMeta()
    expect(A.vault.getRaw(path)).toBeUndefined()
  })
})
