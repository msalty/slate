/**
 * What version history keeps.
 *
 * The store is small and bounded, so the only real question is which sixty
 * snapshots a note gets to keep. Recording one per autosave answered "the last
 * twenty-four seconds you were typing", which is the one answer that is no use:
 * that stretch is what the editor's undo stack is for, and filling the store
 * with it evicts the versions somebody would actually go back to.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Version } from './db'

let seq = 0

async function boot(name: string) {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = `slate-ver-${name}-${seq}`
  return import('./db')
}

const MINUTE = 60_000

/** A snapshot of `text`, as saveNote would record one. */
function edit(text: string, at: number): Omit<Version, 'id'> {
  return { path: 'Note.md', at, text, hash: `h-${text}`, reason: 'edit', device: 'here' }
}

beforeEach(() => {
  seq++
})

describe('pushVersion', () => {
  it('keeps one snapshot per burst of typing, and it is the first', async () => {
    const db = await boot('burst')
    const t0 = Date.parse('2026-09-09T10:00:00Z')
    // Autosave settling every 400ms, for twenty seconds.
    for (let i = 0; i < 50; i++) await db.pushVersion(edit(`draft ${i}`, t0 + i * 400))

    const kept = await db.versionsFor('Note.md')
    expect(kept).toHaveLength(1)
    // The state the burst started from — the one worth going back to.
    expect(kept[0].text).toBe('draft 0')
  })

  it('starts a new snapshot once the burst is over', async () => {
    const db = await boot('gap')
    const t0 = Date.parse('2026-09-09T10:00:00Z')
    await db.pushVersion(edit('morning', t0))
    await db.pushVersion(edit('morning, still', t0 + MINUTE))
    await db.pushVersion(edit('afternoon', t0 + 5 * MINUTE))
    await db.pushVersion(edit('evening', t0 + 60 * MINUTE))

    expect((await db.versionsFor('Note.md')).map((v) => v.text)).toEqual([
      'evening',
      'afternoon',
      'morning',
    ])
  })

  it('so sixty versions span the better part of two hours, not seconds', async () => {
    const db = await boot('span')
    const t0 = Date.parse('2026-09-09T10:00:00Z')
    // Four hours of on-and-off work: a save every 20 seconds.
    for (let i = 0; i < 720; i++) await db.pushVersion(edit(`v${i}`, t0 + i * 20_000))

    const kept = await db.versionsFor('Note.md')
    expect(kept.length).toBeGreaterThan(50)
    // Sixty snapshots, at least a window apart: an hour and fifty-eight minutes
    // of it, against the twenty-four seconds a version-per-autosave kept.
    expect(kept[0].at - kept[kept.length - 1].at).toBeGreaterThan(100 * MINUTE)
  })

  it('never coalesces anything but an ordinary edit', async () => {
    const db = await boot('reasons')
    const t0 = Date.parse('2026-09-09T10:00:00Z')
    const at = (n: number) => t0 + n * 100
    // All inside one window, and every one of them is a version somebody would
    // go looking for.
    await db.pushVersion(edit('typed', at(0)))
    await db.pushVersion({ ...edit('pulled', at(1)), reason: 'sync-pull' })
    await db.pushVersion({ ...edit('merged', at(2)), reason: 'conflict-merge' })
    await db.pushVersion({ ...edit('typed again', at(3)) })
    await db.pushVersion({ ...edit('deleted', at(4)), reason: 'delete' })

    expect((await db.versionsFor('Note.md')).map((v) => v.reason)).toEqual([
      'delete',
      'edit',
      'conflict-merge',
      'sync-pull',
      'edit',
    ])
  })

  it('still skips a snapshot identical to the last one', async () => {
    const db = await boot('same')
    const t0 = Date.parse('2026-09-09T10:00:00Z')
    await db.pushVersion(edit('unchanged', t0))
    await db.pushVersion(edit('unchanged', t0 + 60 * MINUTE))
    expect(await db.versionsFor('Note.md')).toHaveLength(1)
  })

  it('keeps each note’s history to itself', async () => {
    const db = await boot('paths')
    const t0 = Date.parse('2026-09-09T10:00:00Z')
    await db.pushVersion(edit('a', t0))
    await db.pushVersion({ ...edit('b', t0 + 100), path: 'Other.md' })
    // Close in time, but a different note, so not the same burst.
    expect(await db.versionsFor('Note.md')).toHaveLength(1)
    expect(await db.versionsFor('Other.md')).toHaveLength(1)
  })
})
