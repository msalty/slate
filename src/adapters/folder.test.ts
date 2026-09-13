/**
 * Folder adapter tests.
 *
 * The adapter is the piece that has to behave like a conditional-write backend
 * on top of a filesystem that has no such thing, so most of what is asserted
 * here is refusals: a write that would clobber a version nobody here has seen,
 * a delete of a file that has moved on, a listing that would look like a
 * smaller vault. The engine's guarantees rest on those refusals happening.
 */

import { describe, expect, it } from 'vitest'
import { FolderAdapter, isIgnoredPath } from './folder'
import { fakeRoot } from '../test/fakefs'
import { isNotFound, isPreconditionFailed } from '../core/types'

function entryFor(list: Awaited<ReturnType<FolderAdapter['list']>>, path: string) {
  const e = list.find((x) => x.path === path && !x.isDir)
  if (!e) throw new Error(`${path} is not in the listing`)
  return e
}

describe('the folder adapter', () => {
  it('lists files and folders under the root, with a revision for each file', async () => {
    const root = fakeRoot()
    root.writeText('Note.md', 'hello')
    root.writeText('Work/Standup.md', 'stand up')
    const a = new FolderAdapter(root)
    await a.connect()

    const list = await a.list()
    expect(list.filter((e) => !e.isDir).map((e) => e.path).sort()).toEqual([
      'Note.md',
      'Work/Standup.md',
    ])
    expect(list.find((e) => e.path === 'Work')?.isDir).toBe(true)
    expect(entryFor(list, 'Note.md').rev).toBeTruthy()
    expect(entryFor(list, 'Note.md').size).toBe(5)
  })

  it('reads text and bytes back out', async () => {
    const root = fakeRoot()
    root.writeText('Note.md', '# Title\n\nbody')
    root.writeBytes('img/logo.png', new Uint8Array([1, 2, 3, 4]), 'image/png')
    const a = new FolderAdapter(root)
    await a.connect()
    const list = await a.list()

    expect((await a.getText(entryFor(list, 'Note.md'))).text).toBe('# Title\n\nbody')
    const { blob } = await a.getBlob(entryFor(list, 'img/logo.png'))
    expect(blob.size).toBe(4)
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))
  })

  it('creates missing folders on the way to a file', async () => {
    const root = fakeRoot()
    const a = new FolderAdapter(root)
    await a.connect()
    await a.put('a/b/c/Deep.md', 'deep', 'text/markdown', undefined)
    expect(root.readText('a/b/c/Deep.md')).toBe('deep')
  })

  it('refuses to create a file that is already there', async () => {
    const root = fakeRoot()
    root.writeText('Note.md', 'theirs')
    const a = new FolderAdapter(root)
    await a.connect()
    await a.list()

    await expect(a.put('Note.md', 'mine', 'text/markdown', undefined)).rejects.toSatisfy(
      isPreconditionFailed,
    )
    expect(root.readText('Note.md')).toBe('theirs')
  })

  it('refuses a write whose revision the file has moved past', async () => {
    const root = fakeRoot()
    root.writeText('Note.md', 'v1')
    const a = new FolderAdapter(root)
    await a.connect()
    const stale = entryFor(await a.list(), 'Note.md').rev

    // Another program saves over it — exactly what Obsidian does.
    root.writeText('Note.md', 'v2 from Obsidian')

    await expect(a.put('Note.md', 'v2 from Slate', 'text/markdown', stale)).rejects.toSatisfy(
      isPreconditionFailed,
    )
    expect(root.readText('Note.md')).toBe('v2 from Obsidian')
  })

  it('accepts a write whose revision is current, and reports the new one', async () => {
    const root = fakeRoot()
    root.writeText('Note.md', 'v1')
    const a = new FolderAdapter(root)
    await a.connect()
    const before = entryFor(await a.list(), 'Note.md').rev

    const res = await a.put('Note.md', 'v2', 'text/markdown', before)
    expect(root.readText('Note.md')).toBe('v2')
    expect(res.rev).toBeTruthy()
    expect(res.rev).not.toBe(before)
    // The revision it reports has to be the one a later conditional write will
    // be checked against, or every second write would be refused.
    expect(res.rev).toBe(entryFor(await a.list(), 'Note.md').rev)
  })

  it('refuses to delete a file that has been written since the listing', async () => {
    const root = fakeRoot()
    root.writeText('Note.md', 'v1')
    const a = new FolderAdapter(root)
    await a.connect()
    const entry = entryFor(await a.list(), 'Note.md')

    root.writeText('Note.md', 'someone typed this after you asked')

    await expect(a.remove(entry, entry.rev)).rejects.toSatisfy(isPreconditionFailed)
    expect(root.has('Note.md')).toBe(true)
  })

  it('deletes a file at the revision it was listed at, and treats an absent one as done', async () => {
    const root = fakeRoot()
    root.writeText('Note.md', 'v1')
    const a = new FolderAdapter(root)
    await a.connect()
    const entry = entryFor(await a.list(), 'Note.md')

    await a.remove(entry, entry.rev)
    expect(root.has('Note.md')).toBe(false)
    // Idempotent: already gone is success, not an error.
    await expect(a.remove(entry, entry.rev)).resolves.toBeUndefined()
  })

  it('leaves the folder behind when its last file is deleted', async () => {
    const root = fakeRoot()
    root.writeText('Work/Only.md', 'x')
    const a = new FolderAdapter(root)
    await a.connect()
    const entry = entryFor(await a.list(), 'Work/Only.md')
    await a.remove(entry, entry.rev)
    // The folder is part of the vault's shape, not litter left by the file.
    expect((await a.list()).some((e) => e.path === 'Work' && e.isDir)).toBe(true)
  })

  it('never sees, writes or deletes another tool’s state', async () => {
    const root = fakeRoot()
    root.writeText('.obsidian/workspace.json', '{}')
    root.writeText('.git/HEAD', 'ref: refs/heads/main')
    root.writeText('.DS_Store', 'junk')
    root.writeText('~$Draft.docx', 'lock')
    root.writeText('node_modules/pkg/index.js', 'nope')
    root.writeText('Real.md', 'a note')

    const a = new FolderAdapter(root)
    await a.connect()
    const list = await a.list()

    // Invisible to the engine, which is what stops it replicating *or* deleting
    // any of it: it never learns these files exist.
    expect(list.filter((e) => !e.isDir).map((e) => e.path)).toEqual(['Real.md'])
    expect(list.some((e) => e.path.startsWith('.'))).toBe(false)

    expect(isIgnoredPath('.git/HEAD')).toBe(true)
    expect(isIgnoredPath('Work/.obsidian/plugins/x.js')).toBe(true)
    expect(isIgnoredPath('Work/Real.md')).toBe(false)
  })

  it('reports a missing file as not found rather than throwing something opaque', async () => {
    const root = fakeRoot()
    const a = new FolderAdapter(root)
    await a.connect()
    await expect(a.getText({ path: 'Nope.md', isDir: false })).rejects.toSatisfy(isNotFound)
  })

  it('names the file when the filesystem will not take its name', async () => {
    const root = fakeRoot()
    const a = new FolderAdapter(root)
    await a.connect()
    // Legal on WebDAV, impossible on Windows and macOS. The point of the check
    // is that the message says which file and why, so it can be renamed.
    await expect(a.put('Meeting: Tuesday.md', 'x', 'text/markdown', undefined)).rejects.toThrow(
      /Meeting: Tuesday\.md/,
    )
  })

  it('refuses to run without permission, and says how to fix it', async () => {
    const root = fakeRoot()
    ;(root as unknown as { queryPermission: () => Promise<PermissionState> }).queryPermission =
      async () => 'prompt'
    const a = new FolderAdapter(root)
    await expect(a.connect()).rejects.toThrow(/Reconnect/)
    expect(a.isConnected()).toBe(false)
  })

  it('fails the whole listing rather than returning a short one', async () => {
    const root = fakeRoot()
    // Deeper than the walk goes. A partial listing would read to the engine as
    // "everything below here was deleted elsewhere", which is the one mistake
    // that would move a chunk of somebody's vault to the trash.
    let p = 'a'
    for (let i = 0; i < 30; i++) p += `/d${i}`
    root.writeText(`${p}/Buried.md`, 'still here')
    const a = new FolderAdapter(root)
    await a.connect()
    await expect(a.list()).rejects.toThrow(/incomplete/)
  })

  it('makes a folder on request, and does not mind it already existing', async () => {
    const root = fakeRoot()
    const a = new FolderAdapter(root)
    await a.connect()
    await a.ensureDir('Projects/2026')
    await a.ensureDir('Projects/2026')
    expect((await a.list()).filter((e) => e.isDir).map((e) => e.path).sort()).toEqual([
      'Projects',
      'Projects/2026',
    ])
  })
})
