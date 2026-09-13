/**
 * Multiple vaults: work and personal in one browser, kept properly apart.
 *
 * A vault is a whole separate set of notes with its own everything — its own
 * IndexedDB, its own backend and credentials, its own connected folder, its own
 * model connection. Not a filter over one store, and deliberately so: the point
 * of keeping work and personal apart is that a search, a tag, a `[[link]]` and
 * a summary sent to a model never cross the line, and every one of those is a
 * promise that a filter eventually breaks.
 *
 * The separation is almost free, because it is the separation IndexedDB already
 * gives: `db.ts` has always taken its database name from outside itself, and
 * everything device-local — the WebDAV password, the Drive folder id, the
 * folder handle, the API key — lives in that database's `meta` store. Point the
 * app at a different database and all of it is different, with no code that has
 * to remember to scope itself.
 *
 * Two consequences follow, and they are the whole of this file:
 *
 *  1. **The list of vaults cannot live in a vault.** It goes in a small
 *     registry database of its own, which is also the only sensible home for
 *     the handful of things that belong to the *machine* rather than to a set
 *     of notes — chiefly its device identity, so one laptop is one device in
 *     version history rather than one per vault.
 *
 *  2. **Switching vaults reloads the page.** See `switchToVault`.
 */

import { signal } from '@preact/signals'
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { useDatabase } from './db'
import { uid } from './util'

/** The database every vault used before there was more than one. */
const ORIGINAL_DB = 'slate'

/** The registry's own database. Never holds a note. */
const REGISTRY_DB = 'slate-vaults'

export interface VaultRecord {
  /** Stable, short, and safe in a URL and a lock name. */
  id: string
  name: string
  /** One of `VAULT_COLOURS`. Identity at a glance; see the note there. */
  colour: string
  /** The IndexedDB this vault's notes live in. */
  db: string
  createdAt: number
  lastOpenedAt: number
  /**
   * Where this vault's content is kept, as a comparable string.
   *
   * Only ever used to notice that two vaults have been pointed at the same
   * place, which is silently destructive: two separate sets of notes
   * reconciling against one server means each one reads the other's files as
   * notes a device created, and they merge into a single vault nobody asked
   * for. Kept here rather than read out of each vault's settings so that
   * noticing costs a scan of this list rather than opening every database.
   */
  target?: string
}

/**
 * The colours a vault can be.
 *
 * Work and personal do not stay apart because the data model says so; they stay
 * apart because you can see which one you are in before you paste a client's
 * name into your journal. Eight, mid-saturation so they read on both the light
 * and the dark ground, and far enough apart to name.
 */
export const VAULT_COLOURS = [
  '#6b7280', // grey
  '#3b82f6', // blue
  '#14b8a6', // teal
  '#22c55e', // green
  '#f59e0b', // amber
  '#f97316', // orange
  '#f43f5e', // rose
  '#8b5cf6', // violet
] as const

interface RegistrySchema extends DBSchema {
  vaults: { key: string; value: VaultRecord }
  meta: { key: string; value: unknown }
}

let registryPromise: Promise<IDBPDatabase<RegistrySchema>> | undefined

function registry(): Promise<IDBPDatabase<RegistrySchema>> {
  if (!registryPromise) {
    registryPromise = openDB<RegistrySchema>(registryName(), 1, {
      upgrade(d) {
        d.createObjectStore('vaults', { keyPath: 'id' })
        d.createObjectStore('meta')
      },
    })
  }
  return registryPromise
}

/**
 * Overridable the same way the vault database is, and for the same reason: a
 * test that runs two "devices" in one process needs two registries as well as
 * two vaults, or the second device adopts the first one's device identity.
 */
function registryName(): string {
  return (globalThis as { __SLATE_VAULTS_DB__?: string }).__SLATE_VAULTS_DB__ ?? REGISTRY_DB
}

/* ------------------------------------------------------------------ state */

/** Every vault on this device, most recently opened first. */
export const vaults = signal<VaultRecord[]>([])

/** Which one this window is showing. Empty until `openVaults` has run. */
export const activeVaultId = signal('')

export function activeVault(): VaultRecord | undefined {
  return vaults.value.find((v) => v.id === activeVaultId.value)
}

/** The name to show when there is nothing better — and before boot finishes. */
export function activeVaultName(): string {
  return activeVault()?.name ?? 'Slate'
}

/** More than one vault is what turns the colours and the switcher on. */
export function hasMultipleVaults(): boolean {
  return vaults.value.length > 1
}

/* --------------------------------------------------------- device identity */

/**
 * The name this machine goes by in version history.
 *
 * In the registry rather than in a vault, because it is a fact about the
 * laptop. Left in each vault's settings it would make one machine look like as
 * many devices as it has vaults, and renaming it in one would rename nothing
 * anywhere else.
 */
export interface DeviceIdentity {
  id: string
  name: string
}

let device: DeviceIdentity | undefined

export function deviceIdentity(): DeviceIdentity | undefined {
  return device
}

/**
 * Adopt an identity into the registry if it has not got one yet.
 *
 * Called from `loadSettings` with whatever this vault's own settings say, which
 * is how a device that predates the registry keeps the id its notes are already
 * attributed to instead of becoming a stranger to its own history.
 */
export async function claimDeviceIdentity(fallback: DeviceIdentity): Promise<DeviceIdentity> {
  if (device) return device
  const d = await registry()
  const stored = (await d.get('meta', 'device')) as DeviceIdentity | undefined
  if (stored?.id) {
    device = stored
    return stored
  }
  device = fallback
  await d.put('meta', fallback, 'device')
  return fallback
}

export async function setDeviceName(name: string): Promise<void> {
  if (!device || device.name === name) return
  device = { ...device, name }
  const d = await registry()
  await d.put('meta', device, 'device')
}

/* ------------------------------------------------------------------- boot */

/** The vault this window is asking for, if the URL names one. */
function requestedId(): string | undefined {
  if (typeof location === 'undefined') return undefined
  return new URLSearchParams(location.search).get('vault') ?? undefined
}

/**
 * Open the registry, decide which vault this window is showing, and point the
 * database layer at it. The very first thing boot does, before anything has had
 * a chance to touch IndexedDB.
 *
 * A device that has never seen this code has no registry and one database
 * called `slate`. It gets a record describing exactly that — same database,
 * same notes, nothing moved and nothing to confirm. Multiple vaults should
 * arrive as a menu that was not there before, not as a migration.
 */
export async function openVaults(): Promise<VaultRecord> {
  const d = await registry()
  drainPendingDeletes(d)

  let list = await d.getAll('vaults')
  if (!list.length) {
    const first: VaultRecord = {
      id: 'default',
      name: 'Slate',
      colour: VAULT_COLOURS[0],
      db: ORIGINAL_DB,
      createdAt: Date.now(),
      lastOpenedAt: Date.now(),
    }
    await d.put('vaults', first)
    list = [first]
  }

  const wanted = requestedId()
  const lastOpened = (await d.get('meta', 'lastOpened')) as string | undefined
  const chosen =
    list.find((v) => v.id === wanted) ??
    list.find((v) => v.id === lastOpened) ??
    [...list].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0]

  useDatabase(chosen.db)
  activeVaultId.value = chosen.id
  publish(list)

  const touched = { ...chosen, lastOpenedAt: Date.now() }
  await d.put('vaults', touched)
  await d.put('meta', chosen.id, 'lastOpened')
  publish(list.map((v) => (v.id === touched.id ? touched : v)))
  return touched
}

function publish(list: VaultRecord[]): void {
  vaults.value = [...list].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
}

/* --------------------------------------------------------------- managing */

export async function createVault(name: string, colour: string): Promise<VaultRecord> {
  const d = await registry()
  const id = uid(8)
  const rec: VaultRecord = {
    id,
    name: name.trim() || 'Untitled vault',
    colour,
    // Never `slate`: that database belongs to whichever record already claims
    // it, and handing a new vault somebody's existing notes would be the worst
    // possible first impression of a feature about keeping things apart.
    db: `slate-${id}`,
    createdAt: Date.now(),
    lastOpenedAt: Date.now(),
  }
  await d.put('vaults', rec)
  publish(await d.getAll('vaults'))
  return rec
}

export async function renameVault(id: string, name: string): Promise<void> {
  const clean = name.trim()
  if (!clean) return
  await patch(id, { name: clean })
}

export async function recolourVault(id: string, colour: string): Promise<void> {
  await patch(id, { colour })
}

/**
 * Record where this vault's content is kept, so a second vault pointed at the
 * same place can be noticed. Written by `app/backend.ts` whenever the answer
 * changes; `undefined` means local-only.
 */
export async function setVaultTarget(target: string | undefined): Promise<void> {
  const cur = activeVault()
  if (!cur || cur.target === target) return
  await patch(cur.id, { target })
}

async function patch(id: string, fields: Partial<VaultRecord>): Promise<void> {
  const d = await registry()
  const rec = await d.get('vaults', id)
  if (!rec) return
  const next = { ...rec, ...fields }
  await d.put('vaults', next)
  publish(await d.getAll('vaults'))
}

/**
 * Vaults that have been pointed at the same place as another one.
 *
 * Two sets of notes reconciling against one server or one folder do not stay
 * two sets of notes: each run reads the other's files as something a device
 * created and pulls them in, and within a few minutes both vaults hold
 * everything. It is not recoverable by switching one of them back, so it is
 * worth saying out loud the moment it is set up rather than afterwards.
 */
export function vaultsSharingTargets(): VaultRecord[][] {
  const byTarget = new Map<string, VaultRecord[]>()
  for (const v of vaults.value) {
    if (!v.target) continue
    const same = byTarget.get(v.target)
    if (same) same.push(v)
    else byTarget.set(v.target, [v])
  }
  return [...byTarget.values()].filter((g) => g.length > 1)
}

/**
 * Forget a vault on this device.
 *
 * Its notes go with it, because its database goes with it — but nothing on a
 * server, in a Drive folder or in a connected folder is touched, so a vault
 * removed here can be got back by making a new one and pointing it at the same
 * backend. That asymmetry is deliberate, and the dialog says it in those words:
 * this is the destructive action in the feature, and the half of it that is not
 * recoverable is only the half that was never the source of truth.
 *
 * A vault cannot delete the database out from under itself, so removing the one
 * you are looking at leaves the deletion queued and switches away; the next boot
 * carries it out. `switchToVault` is the caller's job either way — this returns
 * where to go.
 */
export async function removeVault(id: string): Promise<string | undefined> {
  const d = await registry()
  const rec = await d.get('vaults', id)
  if (!rec) return undefined
  const rest = (await d.getAll('vaults')).filter((v) => v.id !== id)
  if (!rest.length) return undefined // never leave the app with no vault at all

  await d.delete('vaults', id)
  /*
   * Queued whether or not this is the vault being looked at.
   *
   * A delete blocks for as long as anything holds the database open, and this
   * window is not the only thing that might: a second window, or a popout, can
   * be sitting in the very vault being removed. Queuing means the record goes
   * now — the switcher stops offering it immediately, which is what was asked
   * for — and the bytes go on whichever boot next finds nothing holding them.
   */
  const queued = ((await d.get('meta', 'pendingDeletes')) as string[] | undefined) ?? []
  await d.put('meta', [...new Set([...queued, rec.db])], 'pendingDeletes')
  if (id !== activeVaultId.value) deleteDatabase(rec.db)
  publish(rest)

  const next = [...rest].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0]
  /*
   * Only when the vault that has gone is the one a plain launch would have
   * opened. Removing some third vault while sitting in this one must not
   * quietly change which vault the app comes back to tomorrow.
   */
  const lastOpened = (await d.get('meta', 'lastOpened')) as string | undefined
  if (lastOpened === id) await d.put('meta', next.id, 'lastOpened')
  return next.id
}

/**
 * Carry out deletions left over from a previous session — without waiting.
 *
 * Nothing about opening a vault depends on some other vault's bytes being gone,
 * and a delete waits for as long as anything anywhere holds that database open.
 * Awaiting it here would mean a second window sitting in the removed vault
 * could stop this one from booting at all, which is a far worse outcome than a
 * database that lingers until the next launch.
 */
function drainPendingDeletes(d: IDBPDatabase<RegistrySchema>): void {
  void (async () => {
    const queued = (await d.get('meta', 'pendingDeletes')) as string[] | undefined
    if (!queued?.length) return
    for (const name of queued) {
      // Struck off one at a time, as each one actually lands. Clearing the whole
      // queue up front would be tidier and would strand a database forever the
      // first time a second window happened to be holding it open — a delete
      // that cannot proceed now is exactly the one that has to be tried again.
      deleteDatabase(name, () => void forgetPendingDelete(d, name))
    }
  })()
}

async function forgetPendingDelete(d: IDBPDatabase<RegistrySchema>, name: string): Promise<void> {
  const queued = ((await d.get('meta', 'pendingDeletes')) as string[] | undefined) ?? []
  await d.put(
    'meta',
    queued.filter((n) => n !== name),
    'pendingDeletes',
  )
}

/**
 * Ask for a database to go, and do not wait.
 *
 * A delete blocks for as long as anything holds the database open, so awaiting
 * one would let a second window sitting in the removed vault stop this one from
 * booting. The request stays live and completes the moment the blocker lets go;
 * if the tab ends first, the queue still names it and the next launch asks
 * again.
 */
function deleteDatabase(name: string, done?: () => void): void {
  try {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => done?.()
  } catch (e) {
    console.warn('[slate] could not remove the database for a deleted vault', name, e)
  }
}

/* -------------------------------------------------------------- switching */

/**
 * Show a different vault, by reloading the page onto it.
 *
 * A reload rather than swapping the vault out underneath a running app, and
 * this is a decision rather than a shortcut. Every module that holds vault
 * state holds it at module scope — the file map, the search index, the folder
 * and template definitions, the disclosure state, the device registry, both
 * reconcile engines, the connected folder's handle and its observer, the
 * cross-window channel. Tearing all of that down in place would work most of
 * the time, and the times it did not would be a personal note surfacing in a
 * work search: exactly the failure this feature exists to prevent, arriving
 * silently and intermittently.
 *
 * A reload has none of that surface, and it costs a couple of hundred
 * milliseconds, because opening a vault has always been "read IndexedDB and
 * paint" with nothing on the network in front of it. Obsidian reloads its
 * window to change vaults and VS Code reloads to change workspace; nobody finds
 * it surprising.
 *
 * The vault goes in the URL so that two windows can show two different vaults,
 * and in the registry so that the next plain launch comes back to this one.
 */
export async function switchToVault(id: string): Promise<void> {
  if (!id || id === activeVaultId.value) return
  const d = await registry()
  await d.put('meta', id, 'lastOpened')
  await flushBeforeLeaving()
  reloadInto(id)
}

/**
 * Anything holding unsaved work, asked to write it down before the page goes.
 *
 * `beforeunload` and `pagehide` already fire on a navigation and the editor
 * already listens to both — but what it does there is *start* a save, and a
 * save begins with an async hash, so the page can be gone before the write is
 * even queued. In practice the autosave has usually settled first and nothing
 * is lost; the point of waiting here is that "usually" stops being the
 * guarantee. That hole is one every reload has always had, and switching vaults
 * turns a reload from something that happens by accident into something the app
 * does on purpose several times a day, which is a different bargain.
 *
 * Bounded, because a hook that never settles must not be able to trap somebody
 * in the vault they are trying to leave. A second and a half is far longer than
 * writing one note takes and far shorter than a switch feeling stuck.
 */
const beforeSwitch = new Set<() => void | Promise<void>>()

export function onBeforeVaultSwitch(fn: () => void | Promise<void>): () => void {
  beforeSwitch.add(fn)
  return () => beforeSwitch.delete(fn)
}

function flushBeforeLeaving(): Promise<unknown> {
  if (!beforeSwitch.size) return Promise.resolve()
  return Promise.race([
    Promise.allSettled([...beforeSwitch].map((fn) => fn())),
    new Promise((r) => setTimeout(r, 1500)),
  ])
}

/** Where a window showing `id` lives. Exported for the "open in a new window" case. */
export function urlForVault(id: string): string {
  const url = new URL(location.href)
  url.searchParams.set('vault', id)
  // A launch intent belongs to the launch that carried it, not to a vault
  // somebody switched to ten minutes later.
  for (const k of ['add', 'open', 'title', 'text', 'url']) url.searchParams.delete(k)
  url.hash = ''
  return url.toString()
}

function reloadInto(id: string): void {
  location.href = urlForVault(id)
}
