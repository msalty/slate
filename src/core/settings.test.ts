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

/** The same, plus the two modules the after-the-first-sync retry runs through. */
async function freshBoot() {
  const mods = await fresh()
  const boot = await import('../app/boot')
  const sync = await import('./sync')
  return { ...mods, boot, sync }
}

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

/*
 * A device that has just been installed has no config.json to read: the file
 * arrives with the first sync, moments after boot. Nothing looked at it again
 * until the next reload, so the session ran on defaults with the real
 * preferences sitting in the vault — which is what "I reinstalled the app and
 * my editor mode went back" actually was.
 */
describe('a shared file that has not arrived yet', () => {
  it('says so, rather than looking the same as an empty one', async () => {
    const { s, v } = await fresh()
    expect(await s.applySharedSettings()).toBe(false)

    await v.writeBackstage('config.json', { editorMode: 'rich' })
    expect(await s.applySharedSettings()).toBe(true)
    expect(s.settings.value.editorMode).toBe('rich')
  })

  it('is read again after the first sync finishes, without a reload', async () => {
    const { s, v, boot, sync } = await freshBoot()
    s.update({ backend: 'webdav' })
    expect(s.settings.value.editorMode).toBe('live')

    // Boot with nothing to read: the device keeps its own defaults and arms.
    await boot.applySharedSettingsSafe()
    expect(s.settings.value.editorMode).toBe('live')

    // The first run brings the file down and reports a time.
    await v.writeBackstage('config.json', { editorMode: 'rich' })
    sync.status.value = { ...sync.status.value, lastSyncAt: Date.now() }

    await vi.waitFor(() => expect(s.settings.value.editorMode).toBe('rich'))
  })

  it('does not undo a preference changed while it was waiting', async () => {
    const { s, v, boot, sync } = await freshBoot()
    s.update({ backend: 'webdav' })
    await boot.applySharedSettingsSafe()

    // Set on this device before the file landed; the file disagrees.
    s.update({ editorMode: 'source' })
    await v.writeBackstage('config.json', { editorMode: 'rich', sortBy: 'title' })
    sync.status.value = { ...sync.status.value, lastSyncAt: Date.now() }

    // The rest of the file is adopted, and the key this device set is kept.
    await vi.waitFor(() => expect(s.settings.value.sortBy).toBe('title'))
    expect(s.settings.value.editorMode).toBe('source')
  })

  it('waits for nothing on a vault with no backend', async () => {
    const { s, v, boot, sync } = await freshBoot()
    await boot.applySharedSettingsSafe()

    // Local-only: no sync will ever run, so nothing should be listening — a
    // file appearing by other means is not a reason to re-read.
    await v.writeBackstage('config.json', { editorMode: 'rich' })
    sync.status.value = { ...sync.status.value, lastSyncAt: Date.now() }
    await new Promise((r) => setTimeout(r, 30))
    expect(s.settings.value.editorMode).toBe('live')
  })
})

/**
 * The line that keeps a credential on the device that typed it.
 *
 * Every preference here is either vault-wide or device-local, and getting one
 * onto the wrong side is silent: a WebDAV password or a model API key written
 * into `backstage/config.json` is a secret on every device you sync to and in
 * every backup of the vault, with nothing in the UI to say so. So the rule is
 * pinned from both directions — what reaches the file, and what does not —
 * rather than left to whoever next edits `SHARED_KEYS`.
 */
describe('what is allowed into the shared file', () => {
  it('never writes a secret into the vault, however much is changed', async () => {
    const { s, v } = await fresh()
    s.updateAi({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-secret', visionModel: 'gpt-4o-mini' })
    s.updateWebdav({ url: 'https://dav.example.com', username: 'mike', password: 'hunter2' })
    s.update({ sortBy: 'title' })
    s.flushSettings()

    const shared = await vi.waitFor(async () => {
      const f = await sharedFile(v)
      expect(f).toBeDefined()
      return f!
    })
    expect(shared.ai).toBeUndefined()
    expect(shared.webdav).toBeUndefined()
    expect(shared.gdrive).toBeUndefined()
    expect(JSON.stringify(shared)).not.toMatch(/sk-secret|hunter2/)
    // The shared half still got through, so this is not passing vacuously.
    expect(shared.sortBy).toBe('title')
  })

  it('does not take an AI provider from a shared file written by another device', async () => {
    const { s, v } = await fresh()
    // A config.json that names one — from an older build, a hand edit, or a
    // vault shared with someone else. A device's own provider is its own.
    await v.writeBackstage('config.json', {
      sortBy: 'title',
      ai: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-theirs', visionModel: 'gpt-4o-mini' },
    })
    await s.applySharedSettings()

    expect(s.settings.value.sortBy).toBe('title')
    expect(s.settings.value.ai.provider).toBe('none')
    expect(s.settings.value.ai.apiKey).toBe('')
  })

  it('keeps the device-local half out of the file even after a shared read', async () => {
    const { s, v } = await fresh()
    s.updateAi({ provider: 'ollama', baseUrl: 'http://localhost:11434/v1', visionModel: 'llama3.2-vision' })
    await v.writeBackstage('config.json', { theme: 'dark' })
    await s.applySharedSettings()
    s.update({ fontSize: 17 })
    s.flushSettings()

    await vi.waitFor(async () => expect((await sharedFile(v))?.fontSize).toBe(17))
    expect((await sharedFile(v))?.ai).toBeUndefined()
    // And this device kept what it had set.
    expect(s.settings.value.ai.provider).toBe('ollama')
  })
})
