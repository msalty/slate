/**
 * Vault registry tests.
 *
 * The registry is small but it is the thing standing between work and personal,
 * so what is asserted here is mostly boundaries: that an existing install keeps
 * its notes and gains a vault rather than the other way round, that a new vault
 * is genuinely empty, that removing one leaves the others alone, and that the
 * device this machine is called is the machine rather than the vault.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

type Vaults = typeof import('./vaults')

let seq = 0

/**
 * A fresh device: its own registry, and no vault databases yet.
 *
 * Both names are overridden, because a test that shared a registry with the one
 * before it would be a test about whatever that one happened to leave behind.
 */
async function freshDevice(): Promise<{ vaults: Vaults; registry: string }> {
  vi.resetModules()
  const registry = `slate-vaults-test-${++seq}`
  ;(globalThis as { __SLATE_VAULTS_DB__?: string }).__SLATE_VAULTS_DB__ = registry
  // The vault database has to come from the registry rather than from the test
  // override, or `openVaults` would have nothing to prove.
  delete (globalThis as { __SLATE_DB__?: string }).__SLATE_DB__
  return { vaults: await import('./vaults'), registry }
}

/** Re-enter the same device's modules, as a reload does. */
async function reboot(registry: string): Promise<Vaults> {
  vi.resetModules()
  ;(globalThis as { __SLATE_VAULTS_DB__?: string }).__SLATE_VAULTS_DB__ = registry
  return import('./vaults')
}

/** Stand in for `?vault=…` without navigating anywhere. */
function requestVault(id: string | undefined) {
  const search = id ? `?vault=${id}` : ''
  Object.defineProperty(globalThis, 'location', {
    value: { search, href: `https://slate.test/${search}`, hash: '' },
    configurable: true,
    writable: true,
  })
}

describe('opening a device that has never seen vaults', () => {
  beforeEach(() => requestVault(undefined))

  it('keeps the database the notes are already in, and asks nothing', async () => {
    const { vaults } = await freshDevice()
    const rec = await vaults.openVaults()

    /*
     * The whole migration. A device upgrading into this feature has one
     * database called `slate` full of notes, and it must still be looking at
     * exactly those notes afterwards — multiple vaults should arrive as a menu
     * that was not there before, never as a move.
     */
    expect(rec.db).toBe('slate')
    expect(vaults.vaults.value).toHaveLength(1)
    expect(vaults.activeVaultId.value).toBe(rec.id)
    // And it is called what the app was called, so nothing on screen changed.
    expect(rec.name).toBe('Slate')
  })

  it('is stable across reloads', async () => {
    const { vaults, registry } = await freshDevice()
    const first = await vaults.openVaults()
    const again = await (await reboot(registry)).openVaults()
    expect(again.id).toBe(first.id)
    expect(again.db).toBe('slate')
  })
})

describe('a second vault', () => {
  beforeEach(() => requestVault(undefined))

  it('gets a database of its own, never the original one', async () => {
    const { vaults } = await freshDevice()
    const first = await vaults.openVaults()
    const work = await vaults.createVault('Work', vaults.VAULT_COLOURS[1])

    expect(work.db).not.toBe(first.db)
    expect(work.db).not.toBe('slate')
    expect(vaults.vaults.value).toHaveLength(2)
  })

  it('is what the app opens when the URL asks for it', async () => {
    const { vaults, registry } = await freshDevice()
    await vaults.openVaults()
    const work = await vaults.createVault('Work', vaults.VAULT_COLOURS[1])

    requestVault(work.id)
    const after = await (await reboot(registry)).openVaults()
    expect(after.id).toBe(work.id)
    expect(after.db).toBe(work.db)
  })

  it('is what a later plain launch comes back to', async () => {
    const { vaults, registry } = await freshDevice()
    await vaults.openVaults()
    const work = await vaults.createVault('Work', vaults.VAULT_COLOURS[1])

    // Opened once by name…
    requestVault(work.id)
    await (await reboot(registry)).openVaults()
    // …and then launched from the home screen, which carries no parameters.
    requestVault(undefined)
    const after = await (await reboot(registry)).openVaults()
    expect(after.id).toBe(work.id)
  })

  it('takes a colour nobody else is using', async () => {
    const { vaults } = await freshDevice()
    await vaults.openVaults()
    const a = await vaults.createVault('Work', vaults.VAULT_COLOURS[1])
    const b = await vaults.createVault('Side', vaults.VAULT_COLOURS[2])
    const colours = new Set([vaults.activeVault()!.colour, a.colour, b.colour])
    expect(colours.size).toBe(3)
  })

  it('can be renamed and recoloured without disturbing the other', async () => {
    const { vaults } = await freshDevice()
    const first = await vaults.openVaults()
    const work = await vaults.createVault('Work', vaults.VAULT_COLOURS[1])

    await vaults.renameVault(work.id, 'Client work')
    await vaults.recolourVault(work.id, vaults.VAULT_COLOURS[5])

    const list = vaults.vaults.value
    expect(list.find((v) => v.id === work.id)?.name).toBe('Client work')
    expect(list.find((v) => v.id === work.id)?.colour).toBe(vaults.VAULT_COLOURS[5])
    expect(list.find((v) => v.id === first.id)?.name).toBe('Slate')
  })

  it('will not be renamed to nothing', async () => {
    const { vaults } = await freshDevice()
    const first = await vaults.openVaults()
    await vaults.renameVault(first.id, '   ')
    expect(vaults.activeVault()?.name).toBe('Slate')
  })
})

describe('removing a vault', () => {
  beforeEach(() => requestVault(undefined))

  it('leaves the others, and says where to go next', async () => {
    const { vaults } = await freshDevice()
    const first = await vaults.openVaults()
    const work = await vaults.createVault('Work', vaults.VAULT_COLOURS[1])

    const next = await vaults.removeVault(work.id)
    expect(next).toBe(first.id)
    expect(vaults.vaults.value.map((v) => v.id)).toEqual([first.id])
  })

  it('refuses to remove the last one', async () => {
    const { vaults } = await freshDevice()
    const first = await vaults.openVaults()
    // Nowhere to go afterwards is not a state the app can be in, so the answer
    // is no rather than an empty window.
    expect(await vaults.removeVault(first.id)).toBeUndefined()
    expect(vaults.vaults.value).toHaveLength(1)
  })

  it('queues its own database and lets the next boot delete it', async () => {
    const { vaults, registry } = await freshDevice()
    const first = await vaults.openVaults()
    const work = await vaults.createVault('Work', vaults.VAULT_COLOURS[1])
    requestVault(work.id)
    const reopened = await (await reboot(registry)).openVaults()
    expect(reopened.id).toBe(work.id)

    /*
     * Removing the vault you are looking at cannot delete its database on the
     * spot — this window is holding it open, and IndexedDB blocks. The record
     * goes now so the switcher stops offering it, and the deletion is carried
     * out by the boot that follows.
     */
    const mod = await reboot(registry)
    await mod.openVaults()
    const next = await mod.removeVault(work.id)
    expect(next).toBe(first.id)

    requestVault(undefined)
    const after = await (await reboot(registry)).openVaults()
    expect(after.id).toBe(first.id)
    expect(after.db).toBe('slate')
  })
})

describe('two vaults on one device', () => {
  beforeEach(() => requestVault(undefined))

  /** Open a vault the way boot does, and hand back its vault module. */
  async function open(registry: string, id: string) {
    requestVault(id)
    vi.resetModules()
    ;(globalThis as { __SLATE_VAULTS_DB__?: string }).__SLATE_VAULTS_DB__ = registry
    delete (globalThis as { __SLATE_DB__?: string }).__SLATE_DB__
    const vaultsMod = await import('./vaults')
    const rec = await vaultsMod.openVaults()
    const vault = await import('./vault')
    await vault.initVault()
    return { vaultsMod, vault, rec }
  }

  /*
   * Two vaults *both* created rather than using the device's original one.
   *
   * The first vault a device has always claims the database called `slate`,
   * because that is the migration and it is deliberately not parameterised —
   * which makes it the one database several cases in one process would share.
   * A created vault gets a name of its own, so these cases are as separate from
   * each other as the vaults they are about.
   */
  async function twoVaults() {
    const { vaults, registry } = await freshDevice()
    await vaults.openVaults()
    const home = await vaults.createVault('Personal', VAULTS_BLUE)
    const work = await vaults.createVault('Work', VAULTS_AMBER)
    return { registry, home, work }
  }

  it('hold entirely separate notes', async () => {
    const { registry, home, work } = await twoVaults()

    const personal = await open(registry, home.id)
    await personal.vault.createNote('', 'Dentist', 'thursday, 4pm #personal')

    // The other vault is empty. Not filtered — empty: it is a different
    // database, and nothing was copied into it.
    const atWork = await open(registry, work.id)
    expect(atWork.vault.notes.value).toHaveLength(0)
    expect(atWork.vault.allTags.value).toHaveLength(0)
    expect(atWork.vault.search('dentist')).toHaveLength(0)
    await atWork.vault.createNote('', 'Standup', 'ship the thing #work')

    // And back. The personal vault never heard of the work note, in the list,
    // in the tags or in a search — which is the whole promise of the feature.
    const back = await open(registry, home.id)
    expect(back.vault.notes.value.map((n) => n.title)).toEqual(['Dentist'])
    expect(back.vault.allTags.value.map((t) => t.tag)).toEqual(['personal'])
    expect(back.vault.search('standup')).toHaveLength(0)
    expect(back.vault.search('dentist')).toHaveLength(1)
  })

  it('do not resolve each other’s links', async () => {
    const { registry, home, work } = await twoVaults()
    const personal = await open(registry, home.id)
    await personal.vault.createNote('', 'Recipes', 'pasta')

    // A wikilink resolves against its own vault's title index, so the same text
    // means a different thing — here, nothing — on the other side of the line.
    const atWork = await open(registry, work.id)
    expect(atWork.vault.resolveLink('Recipes')).toBeUndefined()
  })

  it('survive one of them being removed', async () => {
    const { registry, home, work } = await twoVaults()
    const personal = await open(registry, home.id)
    await personal.vault.createNote('', 'Keep me', 'still here')
    const atWork = await open(registry, work.id)
    await atWork.vault.createNote('', 'Throwaway', 'goes with the vault')

    const back = await open(registry, home.id)
    await back.vaultsMod.removeVault(work.id)
    expect(back.vaultsMod.vaults.value.map((v) => v.name)).not.toContain('Work')
    expect(back.vault.notes.value.map((n) => n.title)).toEqual(['Keep me'])

    // And it is not offered again by the boot that follows.
    const after = await open(registry, home.id)
    expect(after.vaultsMod.vaults.value.map((v) => v.id)).not.toContain(work.id)
    expect(after.vault.notes.value.map((n) => n.title)).toEqual(['Keep me'])
  })
})

/** Two colours, named so the isolation tests above read as being about notes. */
const VAULTS_BLUE = '#3b82f6'
const VAULTS_AMBER = '#f59e0b'

describe('device identity', () => {
  beforeEach(() => requestVault(undefined))

  it('is the machine, not the vault', async () => {
    const { vaults } = await freshDevice()
    await vaults.openVaults()

    // The first vault to ask writes it; every other vault on this device gets
    // the same answer, so one laptop is one device in version history rather
    // than one per set of notes.
    const mine = await vaults.claimDeviceIdentity({ id: 'laptop-1', name: 'Mac' })
    expect(mine.id).toBe('laptop-1')
    expect(
      await vaults.claimDeviceIdentity({ id: 'a-different-vaults-idea', name: 'Other' }),
    ).toEqual(mine)
  })

  it('survives a reload, and follows a rename', async () => {
    const { vaults, registry } = await freshDevice()
    await vaults.openVaults()
    await vaults.claimDeviceIdentity({ id: 'laptop-1', name: 'Mac' })
    await vaults.setDeviceName('Studio Mac')

    const after = await reboot(registry)
    await after.openVaults()
    expect(await after.claimDeviceIdentity({ id: 'ignored', name: 'ignored' })).toEqual({
      id: 'laptop-1',
      name: 'Studio Mac',
    })
  })
})

describe('two vaults pointed at the same place', () => {
  beforeEach(() => requestVault(undefined))

  it('are noticed, and only when they really share a target', async () => {
    const { vaults, registry } = await freshDevice()
    const first = await vaults.openVaults()
    const work = await vaults.createVault('Work', vaults.VAULT_COLOURS[1])

    await vaults.setVaultTargets(['webdav:https://dav.example.com/Notes'])
    expect(vaults.vaultsSharingTargets()).toHaveLength(0)

    // The second vault set up against the same server — which merges them
    // within a few sync runs and cannot be undone by switching back. Set up the
    // way it really would be: by opening that vault and configuring it.
    requestVault(work.id)
    const inWork = await reboot(registry)
    await inWork.openVaults()
    await inWork.setVaultTargets(['webdav:https://dav.example.com/Notes'])

    const clash = inWork.vaultsSharingTargets()
    expect(clash).toHaveLength(1)
    expect(clash[0].target).toBe('webdav:https://dav.example.com/Notes')
    expect(clash[0].vaults.map((v) => v.id).sort()).toEqual([first.id, work.id].sort())
  })

  it('are noticed when they share only one of two targets', async () => {
    /*
     * The mistake this is actually for.
     *
     * Somebody makes a second vault against the same server and gives it its
     * own folder — which feels like separating them, and is not: the server
     * alone merges the two. Held as one joined string, `webdav:X + folder:A`
     * and `webdav:X + folder:B` compare as entirely different setups and
     * nothing is said.
     */
    const { vaults, registry } = await freshDevice()
    const first = await vaults.openVaults()
    const work = await vaults.createVault('Work', vaults.VAULT_COLOURS[1])

    await vaults.setVaultTargets(['webdav:https://dav.example.com/Notes', 'folder:Personal'])

    requestVault(work.id)
    const inWork = await reboot(registry)
    await inWork.openVaults()
    await inWork.setVaultTargets(['webdav:https://dav.example.com/Notes', 'folder:Work'])

    const clash = inWork.vaultsSharingTargets()
    expect(clash).toHaveLength(1)
    expect(clash[0].target).toBe('webdav:https://dav.example.com/Notes')
    expect(clash[0].vaults.map((v) => v.id).sort()).toEqual([first.id, work.id].sort())
  })

  it('are left alone when only the shapes rhyme', async () => {
    const { vaults, registry } = await freshDevice()
    await vaults.openVaults()
    const work = await vaults.createVault('Work', vaults.VAULT_COLOURS[1])

    await vaults.setVaultTargets(['webdav:https://dav.example.com/Personal', 'folder:Notes'])
    requestVault(work.id)
    const inWork = await reboot(registry)
    await inWork.openVaults()
    // A different folder on the server and a differently-named folder on disk:
    // two targets each, nothing in common.
    await inWork.setVaultTargets(['webdav:https://dav.example.com/Work', 'folder:Client notes'])

    expect(inWork.vaultsSharingTargets()).toHaveLength(0)
  })

  it('are not confused with two vaults that simply have no backend', async () => {
    const { vaults } = await freshDevice()
    await vaults.openVaults()
    await vaults.createVault('Work', vaults.VAULT_COLOURS[1])
    // Both local-only. Nothing to collide over.
    expect(vaults.vaultsSharingTargets()).toHaveLength(0)
  })
})
