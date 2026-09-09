/**
 * What happens when the database says no.
 *
 * A refused IndexedDB write is the realistic way local-only work disappears:
 * the origin runs out of quota, the browser rejects the put, and everything on
 * screen still looks saved. These tests pin the two properties that make that
 * survivable — the failure reaches the caller, and the vault stays in a state
 * where trying again actually writes something.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Flipped by each test to make the next database write fail. */
const refuse = vi.hoisted(() => ({ writes: false }))

vi.mock('./db', async () => {
  const actual = await vi.importActual<typeof import('./db')>('./db')
  return {
    ...actual,
    putFile: async (f: import('./types').VaultFile) => {
      if (refuse.writes) throw new Error('QuotaExceededError')
      return actual.putFile(f)
    },
  }
})

let seq = 0

async function boot(name: string) {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = `slate-write-${name}-${seq}`
  const vault = await import('./vault')
  const devices = await import('./devices')
  devices.setLocalDevice(`id-${name}`, name)
  await vault.initVault()
  return vault
}

beforeEach(() => {
  seq++
  refuse.writes = false
})

describe('a save the database refuses', () => {
  it('rejects rather than reporting success', async () => {
    const vault = await boot('quota')
    const p = await vault.createNote('', 'Draft', 'first line\n')

    refuse.writes = true
    await expect(vault.saveNote(p, 'first line\nsecond line\n')).rejects.toThrow()
  })

  it('leaves the note savable, so the next attempt at the same text writes it', async () => {
    const vault = await boot('retry')
    const p = await vault.createNote('', 'Draft', 'first line\n')
    const typed = 'first line\nsecond line\n'

    refuse.writes = true
    await expect(vault.saveNote(p, typed)).rejects.toThrow()

    // The whole failure mode: an in-memory copy updated before the write would
    // make this call a no-op — the text is "already there" — and the edit would
    // never reach the database at all.
    refuse.writes = false
    await vault.saveNote(p, typed)

    await vault.initVault() // as a reload would
    expect(vault.getText(p)).toBe(typed)
  })

  it('keeps the last durable text rather than a version that was never written', async () => {
    const vault = await boot('durable')
    const p = await vault.createNote('', 'Draft', 'first line\n')

    refuse.writes = true
    await expect(vault.saveNote(p, 'lost\n')).rejects.toThrow()

    expect(vault.getText(p)).toBe('first line\n')
    await vault.initVault()
    expect(vault.getText(p)).toBe('first line\n')
  })
})
