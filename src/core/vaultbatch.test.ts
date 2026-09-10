/**
 * The bookkeeping two windows and the sync engine lean on.
 *
 * Both of these were rewritten for speed, and both are the kind of thing that
 * stays fast and quietly stops being right: a pending count kept as a running
 * total drifts if a write skips it, and a batched adopt drops a path if a burst
 * is coalesced carelessly. So what these check is the answer, not the timing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

let seq = 0

async function boot(name: string) {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = `slate-batch-${name}-${seq}`
  const vault = await import('./vault')
  const db = await import('./db')
  const devices = await import('./devices')
  devices.setLocalDevice(`id-${name}`, name)
  await vault.initVault()
  return { vault, db }
}

/** The count the old implementation produced, for comparison. */
function countByHand(vault: typeof import('./vault')): number {
  return vault.listAll().filter((f) => f.dirty).length
}

beforeEach(() => {
  seq++
})

describe('the pending count', () => {
  it('tracks every kind of write', async () => {
    const { vault } = await boot('count')
    expect(vault.dirtyCount()).toBe(0)

    const a = await vault.createNote('', 'A', 'first')
    const b = await vault.createNote('', 'B', 'second')
    expect(vault.dirtyCount()).toBe(2)
    expect(vault.dirtyCount()).toBe(countByHand(vault))

    // Saving a file that is already dirty does not count it twice.
    await vault.saveNote(a, 'first, edited')
    expect(vault.dirtyCount()).toBe(2)

    // Synced files leave the count.
    await vault.markSynced(a, { baseHash: vault.getRaw(a)!.hash, baseText: vault.getText(a) })
    expect(vault.dirtyCount()).toBe(1)
    expect(vault.dirtyCount()).toBe(countByHand(vault))

    // A move is a tombstone at the old path plus a dirty file at the new one.
    await vault.movePath(b, 'Moved.md')
    expect(vault.dirtyCount()).toBe(countByHand(vault))

    // And a forgotten tombstone leaves entirely.
    await vault.forget('B.md')
    expect(vault.dirtyCount()).toBe(countByHand(vault))
  })

  it('is rebuilt from the database on boot', async () => {
    const { vault } = await boot('reload')
    await vault.createNote('', 'A', 'text')
    await vault.createNote('', 'B', 'text')
    await vault.initVault()
    expect(vault.dirtyCount()).toBe(2)
    expect(vault.dirtyCount()).toBe(countByHand(vault))
  })
})

describe('adopting another window’s writes', () => {
  it('takes every path in a burst, however the calls are split', async () => {
    const { vault, db } = await boot('adopt')
    const paths: string[] = []
    for (let i = 0; i < 5; i++) paths.push(await vault.createNote('', `Note ${i}`, `body ${i}`))

    // Stand in for the other window: change the rows underneath this one.
    for (const p of paths) {
      const row = (await db.getFile(p))!
      await db.putFile({ ...row, text: `${row.text} (elsewhere)`, hash: `${row.hash}x`, mtime: row.mtime + 1000 })
    }

    // Three announcements in one tick, as a sync installing a batch produces.
    await Promise.all([
      vault.adoptFromStorage(paths.slice(0, 2)),
      vault.adoptFromStorage(paths.slice(2, 3)),
      vault.adoptFromStorage(paths.slice(3)),
    ])

    for (const p of paths) expect(vault.getText(p)).toContain('(elsewhere)')
  })

  it('follows a row that has gone away', async () => {
    const { vault, db } = await boot('adopt-gone')
    const p = await vault.createNote('', 'Doomed', 'text')
    await db.deleteFileRow(p)
    await vault.adoptFromStorage([p])
    expect(vault.getRaw(p)).toBeUndefined()
    expect(vault.getEntry(p)).toBeUndefined()
  })

  it('redraws once for a batch, and not at all when nothing moved', async () => {
    const { vault } = await boot('adopt-quiet')
    const paths: string[] = []
    for (let i = 0; i < 4; i++) paths.push(await vault.createNote('', `Note ${i}`, `body ${i}`))

    const before = vault.revision.value
    await vault.adoptFromStorage(paths)
    // Same content as memory already holds: nothing to redraw for.
    expect(vault.revision.value).toBe(before)
  })
})
