/**
 * Two-device sync tests.
 *
 * Each "device" is a freshly-imported copy of the app's modules with its own
 * IndexedDB database, talking to one shared in-memory server. That makes these
 * genuine round-trip tests of the property that matters most: after any
 * sequence of edits on either side, no content is lost.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryAdapter, MemoryServer } from '../adapters/memory'
import { rebaseBuffer } from './rebase'

type Device = {
  name: string
  vault: typeof import('./vault')
  sync: typeof import('./sync')
}

let seq = 0

async function makeDevice(server: MemoryServer, name: string): Promise<Device> {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = `slate-test-${name}-${seq}`
  const vault = await import('./vault')
  const syncMod = await import('./sync')
  await vault.initVault()
  syncMod.setAdapter(new MemoryAdapter(server))
  syncMod.setDeviceLabel(name)
  return { name, vault, sync: syncMod }
}

/** Re-enter a device's modules (each device keeps its own module instances). */
async function run(d: Device) {
  await d.sync.sync()
}

/** Reload a device's in-memory state from its own database, as a restart would. */
async function reload(d: Device) {
  await d.vault.initVault()
}

/**
 * Stands in for a note open in the editor: a buffer seeded from the vault that
 * folds in whatever arrives underneath it and saves what gets typed. This is
 * the piece that made two machines overwrite each other — an editor that keeps
 * its own copy of the text writes that copy back on the next keystroke.
 */
function openEditor(d: Device, path: string) {
  let base = d.vault.getText(path) ?? ''
  let buffer = base
  return {
    get text() {
      return buffer
    },
    /** The vault changed beneath the editor (a sync pull, say). */
    async refresh() {
      const incoming = d.vault.getText(path) ?? ''
      if (incoming === base) return
      const r = rebaseBuffer(base, buffer, incoming)
      base = r.changed ? r.text : incoming
      if (!r.changed) return
      buffer = r.text
      if (r.text !== incoming) await d.vault.saveNote(path, r.text)
    },
    /** Type, and let autosave settle. */
    async type(next: string) {
      buffer = next
      base = next
      await d.vault.saveNote(path, next)
    },
  }
}

beforeEach(() => {
  seq++
})

describe('sync round trips', () => {
  it('propagates a new note from one device to another', async () => {
    const server = new MemoryServer()
    const a = await makeDevice(server, 'mac')
    const p = await a.vault.createNote('', 'Trip', '# Trip\n\nFlights booked.\n')
    await run(a)

    expect(await server.readText(p)).toContain('Flights booked.')

    const b = await makeDevice(server, 'phone')
    await run(b)
    expect(b.vault.getText(p)).toContain('Flights booked.')
    expect(b.vault.getRaw(p)?.dirty).toBe(false)
  })

  it('merges edits that touch different parts of the same note', async () => {
    const server = new MemoryServer()
    const a = await makeDevice(server, 'mac')
    const p = await a.vault.createNote('', 'Trip', 'one\ntwo\nthree\nfour\nfive\n')
    await run(a)

    // The phone pulls the same note, then both sides edit independently.
    const b = await makeDevice(server, 'phone')
    await run(b)

    await a.vault.saveNote(p, 'ONE\ntwo\nthree\nfour\nfive\n')
    await b.vault.saveNote(p, 'one\ntwo\nthree\nfour\nFIVE\n')

    await run(a) // mac pushes first
    await run(b) // phone merges on top

    const merged = b.vault.getText(p)!
    expect(merged).toContain('ONE')
    expect(merged).toContain('FIVE')

    // And the mac converges on the same text once it syncs again.
    await run(a)
    expect(a.vault.getText(p)).toBe(merged)
    expect(await server.readText(p)).toBe(merged)
  })

  it('keeps both versions when the same line is edited on both devices', async () => {
    const server = new MemoryServer()
    const a = await makeDevice(server, 'mac')
    const p = await a.vault.createNote('', 'Hotel', 'Hotel: pending\n')
    await run(a)

    const b = await makeDevice(server, 'phone')
    await run(b)

    await a.vault.saveNote(p, 'Hotel: Alfama guesthouse\n')
    await b.vault.saveNote(p, 'Hotel: Chiado apartment\n')

    await run(a)
    await run(b)

    // The phone keeps its own text at the canonical path...
    expect(b.vault.getText(p)).toContain('Chiado')
    // ...and the mac's version survives as a conflict copy.
    const copies = b.vault.listAll().filter((f) => f.path.includes('conflict'))
    expect(copies).toHaveLength(1)
    expect(copies[0].text).toContain('Alfama')

    // Nothing was lost on the server either.
    await run(b)
    const remote = [...server.files.keys()]
    expect(remote.some((k) => k.includes('conflict'))).toBe(true)
  })

  it('replicates a delete to the other device', async () => {
    const server = new MemoryServer()
    const a = await makeDevice(server, 'mac')
    const p = await a.vault.createNote('', 'Scratch', 'temp\n')
    await run(a)

    const b = await makeDevice(server, 'phone')
    await run(b)
    expect(b.vault.exists(p)).toBe(true)

    await a.vault.deleteNote(p)
    await run(a)
    expect(server.files.has(p)).toBe(false)

    await run(b)
    expect(b.vault.exists(p)).toBe(false)
    // The trashed copy synced across, so the delete is still recoverable.
    expect(b.vault.trashItems().length).toBe(1)
  })

  it('resurrects a note that was edited elsewhere after being deleted here', async () => {
    const server = new MemoryServer()
    const a = await makeDevice(server, 'mac')
    const p = await a.vault.createNote('', 'Important', 'first draft\n')
    await run(a)

    // The mac deletes it while offline...
    await a.vault.deleteNote(p)
    // ...but meanwhile another device wrote something new to it.
    server.writeText(p, 'first draft\nsecond paragraph someone else added\n')

    await run(a)

    // An edit beats a delete: the note comes back rather than the edit vanishing.
    expect(a.vault.exists(p)).toBe(true)
    expect(a.vault.getText(p)).toContain('second paragraph someone else added')
  })

  it('re-uploads a locally edited note that was deleted on the server', async () => {
    const server = new MemoryServer()
    const a = await makeDevice(server, 'mac')
    const p = await a.vault.createNote('', 'Recipe', 'salt\n')
    await run(a)

    await a.vault.saveNote(p, 'salt\npepper\n')
    server.remove(p) // another device deleted it

    await run(a)
    expect(await server.readText(p)).toContain('pepper')
  })

  it('accepts a server-side delete when there is nothing newer locally', async () => {
    const server = new MemoryServer()
    const a = await makeDevice(server, 'mac')
    const p = await a.vault.createNote('', 'Old', 'stale\n')
    await run(a)
    expect(a.vault.getRaw(p)?.dirty).toBe(false)

    server.remove(p)
    await run(a)
    expect(a.vault.exists(p)).toBe(false)
  })

  it('does not clobber a remote change made between listing and writing', async () => {
    const server = new MemoryServer()
    const a = await makeDevice(server, 'mac')
    const p = await a.vault.createNote('', 'Race', 'base\n')
    await run(a)

    // Local edit, and a remote edit arriving from elsewhere at the same time.
    await a.vault.saveNote(p, 'base\nlocal addition\n')
    server.writeText(p, 'base\nremote addition\n')

    await run(a)

    const finalText = await server.readText(p)
    expect(finalText).toContain('local addition')
    expect(finalText).toContain('remote addition')
  })

  it('survives a restart with unsynced edits', async () => {
    const server = new MemoryServer()
    const a = await makeDevice(server, 'mac')
    const p = await a.vault.createNote('', 'Offline', 'written while offline\n')

    // Simulate closing and reopening the app before any sync happened.
    await reload(a)
    expect(a.vault.getText(p)).toContain('written while offline')
    expect(a.vault.getRaw(p)?.dirty).toBe(true)

    await run(a)
    expect(await server.readText(p)).toContain('written while offline')
  })

  it('carries attachments across devices', async () => {
    const server = new MemoryServer()
    const a = await makeDevice(server, 'mac')
    const blob = new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'image/webp' })
    const p = await a.vault.addAttachment(blob, 'attachments/2026/08/shot.webp')
    await run(a)

    const b = await makeDevice(server, 'phone')
    await run(b)
    const got = b.vault.getRaw(p)
    expect(got?.kind).toBe('attachment')
    expect(got?.blob?.size).toBe(5)
  })

  it('hides backstage from the note list but still syncs it', async () => {
    const server = new MemoryServer()
    const a = await makeDevice(server, 'mac')
    await a.vault.writeBackstage('config.json', { theme: 'dark' })
    await a.vault.createNote('', 'Visible', 'hello\n')
    await run(a)

    expect(a.vault.notes.value.map((n) => n.title)).toEqual(['Visible'])
    expect(server.files.has('backstage/config.json')).toBe(true)

    const b = await makeDevice(server, 'phone')
    await run(b)
    expect(b.vault.notes.value.map((n) => n.title)).toEqual(['Visible'])
    expect(await b.vault.readBackstage<{ theme: string }>('config.json')).toEqual({ theme: 'dark' })
  })

  it('rewrites wikilinks when a note is renamed', async () => {
    const server = new MemoryServer()
    const a = await makeDevice(server, 'mac')
    const target = await a.vault.createNote('', 'Old Name', 'target\n')
    const source = await a.vault.createNote('', 'Source', 'See [[Old Name]] and [[Old Name|alias]].\n')
    expect(a.vault.resolveLink('Old Name')).toBe(target)

    await a.vault.renameNote(target, 'New Name')

    const text = a.vault.getText(source)!
    expect(text).toContain('[[New Name]]')
    expect(text).toContain('[[New Name|alias]]')
    expect(a.vault.resolveLink('New Name')).toBeDefined()
  })

  it('converges after a burst of interleaved edits', async () => {
    const server = new MemoryServer()
    const a = await makeDevice(server, 'mac')
    const p = await a.vault.createNote('', 'Log', 'start\n')
    await run(a)
    const b = await makeDevice(server, 'phone')
    await run(b)

    for (let i = 0; i < 5; i++) {
      await a.vault.saveNote(p, `${a.vault.getText(p)}mac ${i}\n`)
      await run(a)
      await run(b)
      await b.vault.saveNote(p, `${b.vault.getText(p)}phone ${i}\n`)
      await run(b)
      await run(a)
    }

    // Both devices agree, and every line that was ever written is present.
    expect(a.vault.getText(p)).toBe(b.vault.getText(p))
    const text = a.vault.getText(p)!
    for (let i = 0; i < 5; i++) {
      expect(text).toContain(`mac ${i}`)
      expect(text).toContain(`phone ${i}`)
    }
  })

  it('does not write a stale editor buffer back over a change from another device', async () => {
    const server = new MemoryServer()
    const a = await makeDevice(server, 'mac')
    const p = await a.vault.createNote('', 'Shared', 'first line\n')
    await run(a)
    const b = await makeDevice(server, 'phone')
    await run(b)

    // The same note is open on both machines.
    const onMac = openEditor(a, p)
    const onPhone = openEditor(b, p)

    // The phone adds a line and sends it up.
    await onPhone.type('first line\nfrom the phone\n')
    await run(b)

    // The mac pulls it with its editor sitting open, then the user types there.
    await run(a)
    await onMac.refresh()
    await onMac.type(`${onMac.text}from the mac\n`)
    await run(a)

    const remote = (await server.readText(p))!
    expect(remote).toContain('from the phone')
    expect(remote).toContain('from the mac')

    // And the phone ends up on exactly the same text rather than pushing back.
    await run(b)
    await onPhone.refresh()
    await run(b)
    expect(onPhone.text).toBe(onMac.text)
    expect(await server.readText(p)).toBe(onMac.text)
  })

  it('does not clobber an edit made while the pull was in flight', async () => {
    const server = new MemoryServer()
    const a = await makeDevice(server, 'mac')
    const p = await a.vault.createNote('', 'Race', 'base\n')
    await run(a)

    // Another device writes the note, and the user types here while that
    // download is still on the wire.
    server.writeText(p, 'base\nremote addition\n')
    const adapter = new MemoryAdapter(server)
    const getText = adapter.getText.bind(adapter)
    let typed = false
    adapter.getText = async (entry) => {
      const res = await getText(entry)
      if (entry.path === p && !typed) {
        typed = true
        await a.vault.saveNote(p, 'base\nlocal addition\n')
      }
      return res
    }
    a.sync.setAdapter(adapter)

    await run(a)
    const text = a.vault.getText(p)!
    expect(text).toContain('remote addition')
    expect(text).toContain('local addition')

    const remote = (await server.readText(p))!
    expect(remote).toContain('remote addition')
    expect(remote).toContain('local addition')
  })
})
