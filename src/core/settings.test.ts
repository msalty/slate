/**
 * Preferences that survive the reload after you change them.
 *
 * Settings are written twice: to this device immediately, and to
 * backstage/config.json on a long timer — long because a pane resizer would
 * otherwise write a vault file on every frame of a drag. The shared file is
 * overlaid over the device's own copy at boot, so the two halves have to agree
 * about which one is newer, or a reload inside the timer reads back the value
 * from before the change and silently undoes it.
 */

import { describe, expect, it, vi } from 'vitest'

type Settings = typeof import('./settings')
type Vault = typeof import('./vault')
type DB = typeof import('./db')

let seq = 0

/** Boot the app against a named database, as a page load does. */
async function boot(name: string): Promise<{ s: Settings; v: Vault; db: DB }> {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = name
  const v = await import('./vault')
  await v.initVault()
  const db = await import('./db')
  const s = await import('./settings')
  await s.loadSettings()
  return { s, v, db }
}

/** A fresh database, vault and settings module per case. */
const fresh = () => boot(`slate-settings-${++seq}`)

const sharedFile = (v: Vault) => v.readBackstage<Record<string, unknown>>('config.json')

describe('flushSettings', () => {
  it('writes a change that is still sitting in its timer', async () => {
    const { s, v } = await fresh()
    s.update({ sortBy: 'title' })
    expect(await sharedFile(v)).toBeUndefined()

    s.flushSettings()
    await vi.waitFor(async () => expect((await sharedFile(v))?.sortBy).toBe('title'))
  })

  it('does nothing when there is nothing waiting', async () => {
    const { s, v } = await fresh()
    s.flushSettings()
    expect(await sharedFile(v)).toBeUndefined()
  })
})

describe('a stale shared file', () => {
  it('does not undo a change this device has not written yet', async () => {
    const { s, v } = await fresh()
    await v.writeBackstage('config.json', { sortBy: 'title' })
    s.update({ sortBy: 'ctime' })

    await s.applySharedSettings()
    expect(s.settings.value.sortBy).toBe('ctime')
  })

  it('and the protection is per key, not all of them', async () => {
    const { s, v } = await fresh()
    await v.writeBackstage('config.json', { sortBy: 'title', fontSize: 19 })
    // One key changed here; the other has no local opinion to defend.
    s.update({ sortBy: 'ctime' })

    await s.applySharedSettings()
    expect(s.settings.value.sortBy).toBe('ctime')
    expect(s.settings.value.fontSize).toBe(19)
  })

  it('is adopted in full when this device has changed nothing', async () => {
    const { s, v } = await fresh()
    await v.writeBackstage('config.json', { sortBy: 'title', showDoneTasks: true })

    await s.applySharedSettings()
    expect(s.settings.value.sortBy).toBe('title')
    expect(s.settings.value.showDoneTasks).toBe(true)
  })

  it('stops being protected once the change has actually been written', async () => {
    const { s, v } = await fresh()
    s.update({ sortBy: 'ctime' })
    s.flushSettings()
    await vi.waitFor(async () => expect((await sharedFile(v))?.sortBy).toBe('ctime'))

    // Now another device's value arrives. This one has nothing outstanding.
    await v.writeBackstage('config.json', { sortBy: 'title' })
    await s.applySharedSettings()
    expect(s.settings.value.sortBy).toBe('title')
  })
})

/**
 * The case a flush cannot reach: a tab that is killed, or a write that never
 * lands. Nothing runs at that moment, so what protects the change has to have
 * been written down before it — beside the settings, in this device's own
 * store, where the next boot will find it.
 */
describe('a change that never reached the file', () => {
  it('is still defended after a reload that flushed nothing', async () => {
    const name = `slate-settings-${++seq}`
    const first = await boot(name)
    await first.v.writeBackstage('config.json', { sortBy: 'title' })
    first.s.update({ sortBy: 'ctime' })
    // Let this device's own copy land, then walk away without flushing.
    await vi.waitFor(async () =>
      expect(await first.db.getMeta<string[]>('settings.unwritten')).toContain('sortBy'),
    )

    const again = await boot(name)
    expect(again.s.settings.value.sortBy).toBe('ctime')
    await again.s.applySharedSettings()
    expect(again.s.settings.value.sortBy).toBe('ctime')
  })

  it('and stops being defended once it has been written', async () => {
    const name = `slate-settings-${++seq}`
    const first = await boot(name)
    first.s.update({ sortBy: 'ctime' })
    first.s.flushSettings()
    await vi.waitFor(async () =>
      expect(await first.db.getMeta<string[]>('settings.unwritten')).toEqual([]),
    )

    // Another device's choice, arriving in a file this one no longer disputes.
    await first.v.writeBackstage('config.json', { sortBy: 'title' })
    const again = await boot(name)
    await again.s.applySharedSettings()
    expect(again.s.settings.value.sortBy).toBe('title')
  })
})
