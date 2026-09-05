/**
 * The trail behind the two arrows beside the note title.
 *
 * Two things here are worth holding down with tests rather than eyes. The first
 * is that the trail is built by *watching* which note is open, so a note opened
 * by assigning the signal directly — which half the app does — counts exactly
 * the same as one opened through `openNote`. The second is what happens to a
 * note that is no longer there: a trail collects paths, and renaming or
 * deleting a note leaves one behind that must be stepped over rather than
 * offered.
 */

import { describe, expect, it, vi } from 'vitest'

let seq = 0

async function fresh() {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = `slate-trail-${++seq}`
  const vault = await import('../core/vault')
  await vault.initVault()
  // Imported after the reset, so both of these see the same fresh vault.
  const state = await import('./state')
  const trail = await import('./backForward')
  return { vault, state, trail }
}

describe('back and forward', () => {
  it('has nowhere to go before anything has been opened', async () => {
    const { trail } = await fresh()
    expect(trail.backTarget.value).toBeUndefined()
    expect(trail.forwardTarget.value).toBeUndefined()
  })

  it('goes back to the note you were on, and forward again', async () => {
    const { vault, state, trail } = await fresh()
    const a = await vault.createNote('', 'Alpha', '# Alpha\n')
    const b = await vault.createNote('', 'Beta', '# Beta\n')

    state.openNote(a)
    state.openNote(b)
    expect(trail.backTarget.value).toBe(a)

    trail.goBack()
    expect(state.activePath.value).toBe(a)
    expect(trail.forwardTarget.value).toBe(b)

    trail.goForward()
    expect(state.activePath.value).toBe(b)
    expect(trail.forwardTarget.value).toBeUndefined()
  })

  it('counts a note opened by assigning the signal, which is how half the app opens one', async () => {
    const { vault, state, trail } = await fresh()
    const a = await vault.createNote('', 'Alpha', '# Alpha\n')
    const b = await vault.createNote('', 'Beta', '# Beta\n')

    state.activePath.value = a
    state.activePath.value = b
    expect(trail.backTarget.value).toBe(a)
  })

  it('abandons the forward branch when you go somewhere new instead', async () => {
    const { vault, state, trail } = await fresh()
    const a = await vault.createNote('', 'Alpha', '# Alpha\n')
    const b = await vault.createNote('', 'Beta', '# Beta\n')
    const c = await vault.createNote('', 'Gamma', '# Gamma\n')

    state.openNote(a)
    state.openNote(b)
    trail.goBack()
    expect(trail.forwardTarget.value).toBe(b)

    state.openNote(c)
    expect(trail.forwardTarget.value).toBeUndefined()
    expect(trail.backTarget.value).toBe(a)
  })

  it('steps over a note that has been deleted since you were on it', async () => {
    const { vault, state, trail } = await fresh()
    const a = await vault.createNote('', 'Alpha', '# Alpha\n')
    const b = await vault.createNote('', 'Beta', '# Beta\n')
    const c = await vault.createNote('', 'Gamma', '# Gamma\n')

    state.openNote(a)
    state.openNote(b)
    state.openNote(c)
    await vault.deleteNote(b)

    expect(trail.backTarget.value).toBe(a)
    trail.goBack()
    expect(state.activePath.value).toBe(a)
  })

  it('steps over a note that has been renamed, which is a new path', async () => {
    const { vault, state, trail } = await fresh()
    const a = await vault.createNote('', 'Alpha', '# Alpha\n')
    const b = await vault.createNote('', 'Beta', '# Beta\n')
    const c = await vault.createNote('', 'Gamma', '# Gamma\n')

    state.openNote(a)
    state.openNote(b)
    state.openNote(c)
    await vault.renameNote(b, 'Beta the second')

    trail.goBack()
    expect(state.activePath.value).toBe(a)
  })

  it('offers nothing at all once every note behind you has gone', async () => {
    const { vault, state, trail } = await fresh()
    const a = await vault.createNote('', 'Alpha', '# Alpha\n')
    const b = await vault.createNote('', 'Beta', '# Beta\n')

    state.openNote(a)
    state.openNote(b)
    await vault.deleteNote(a)

    expect(trail.backTarget.value).toBeUndefined()
    trail.goBack()
    expect(state.activePath.value).toBe(b)
  })

  it('keeps the trail when the pane is emptied by a delete', async () => {
    const { vault, state, trail } = await fresh()
    const a = await vault.createNote('', 'Alpha', '# Alpha\n')
    const b = await vault.createNote('', 'Beta', '# Beta\n')

    state.openNote(a)
    state.openNote(b)
    await vault.deleteNote(b)
    // What the pane does with the note it was showing when it goes.
    state.activePath.value = undefined

    expect(trail.backTarget.value).toBe(a)
    trail.goBack()
    expect(state.activePath.value).toBe(a)
    // The note that was deleted is not somewhere to go forward to.
    expect(trail.forwardTarget.value).toBeUndefined()
  })
})
