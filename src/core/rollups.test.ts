/**
 * The roll-ups, now that they merge the index instead of rescanning the vault.
 *
 * Reading parsed data off `NoteIndexEntry` is what makes typing in a large
 * vault cheap, and it introduces exactly one way to be wrong: an entry that was
 * not rebuilt when its note changed leaves every roll-up answering from
 * yesterday. So most of what is below is the same question asked after an edit,
 * a rename, a delete and a pull.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

let seq = 0

async function boot(name: string) {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = `slate-rollup-${name}-${seq}`
  const vault = await import('./vault')
  const devices = await import('./devices')
  devices.setLocalDevice(`id-${name}`, name)
  await vault.initVault()
  return vault
}

beforeEach(() => {
  seq++
})

describe('the tasks roll-up', () => {
  it('carries the note’s own tags onto every task on it', async () => {
    const vault = await boot('inherit')
    await vault.createNote('', 'Errands', '#home\n\n- [ ] Post the parcel #town\n- [ ] Water plants')

    const [parcel, plants] = vault.tasks.value.filter((t) => t.path === 'Errands.md')
    expect(parcel.tags.sort()).toEqual(['home', 'town'])
    expect(parcel.ownTags).toEqual(['town'])
    // Inherited, so it is context rather than something typed on the line.
    expect(plants.tags).toEqual(['home'])
    expect(plants.ownTags).toEqual([])
  })

  it('follows an edit to the note it came from', async () => {
    const vault = await boot('edit')
    const p = await vault.createNote('', 'Jobs', '- [ ] One\n- [ ] Two')
    expect(vault.tasks.value.map((t) => t.text)).toEqual(['One', 'Two'])

    await vault.saveNote(p, '#work\n\n- [x] One\n- [ ] Two\n- [ ] Three 📅 2026-09-04')
    const after = vault.tasks.value
    expect(after.map((t) => t.text).sort()).toEqual(['One', 'Three', 'Two'])
    expect(after.find((t) => t.text === 'One')!.done).toBe(true)
    // The new note-level tag reaches tasks that were already there.
    expect(after.find((t) => t.text === 'Two')!.tags).toEqual(['work'])
    expect(vault.openTasksByDueDay.value.size).toBe(1)
  })

  it('follows the note to a new title, and out of the vault', async () => {
    const vault = await boot('move')
    const p = await vault.createNote('', 'Old', '- [ ] Something')
    const renamed = await vault.renameNote(p, 'New')
    expect(vault.tasks.value.map((t) => t.noteTitle)).toEqual(['New'])
    expect(vault.tasks.value[0].path).toBe(renamed)

    await vault.deleteNote(renamed)
    expect(vault.tasks.value).toEqual([])
  })

  it('leaves templates out of it', async () => {
    const vault = await boot('templates')
    await vault.createNote('Templates', 'Daily', '- [ ] A job the template suggests')
    await vault.createNote('', 'Today', '- [ ] A job I actually have')
    expect(vault.tasks.value.map((t) => t.text)).toEqual(['A job I actually have'])
    // …while still being a note that has tasks, for a `has:tasks` rule.
    expect(vault.getEntry('Templates/Daily.md')!.hasTasks).toBe(true)
  })
})

describe('the unresolved-link roll-up', () => {
  it('keys targets as they were written', async () => {
    const vault = await boot('case')
    await vault.createNote('', 'Journal', 'See [[Project Apollo]] and [[nowhere at all]].')
    expect([...vault.unresolvedLinks.value.keys()].sort()).toEqual([
      'Project Apollo',
      'nowhere at all',
    ])
  })

  it('drops a target as soon as something answers to it', async () => {
    const vault = await boot('resolve')
    await vault.createNote('', 'Journal', 'See [[Project Apollo]].')
    expect(vault.unresolvedLinks.value.has('Project Apollo')).toBe(true)

    await vault.createNote('', 'Project Apollo', 'Here.')
    expect(vault.unresolvedLinks.value.has('Project Apollo')).toBe(false)
    expect(vault.backlinkMap.value.get('Project Apollo.md')).toEqual(['Journal.md'])
  })

  it('follows an edit that removes the link', async () => {
    const vault = await boot('unlink')
    const p = await vault.createNote('', 'Journal', 'See [[Somewhere]].')
    expect(vault.unresolvedLinks.value.size).toBe(1)
    await vault.saveNote(p, 'Nothing to see.')
    expect(vault.unresolvedLinks.value.size).toBe(0)
  })

  it('does not count an embed as a link to a missing note', async () => {
    const vault = await boot('embed')
    await vault.createNote('', 'Journal', 'A picture: ![[diagram.png]]')
    expect(vault.unresolvedLinks.value.size).toBe(0)
  })
})

describe('backlinks', () => {
  it('resolve a link written as a path, whatever its case', async () => {
    const vault = await boot('paths')
    await vault.createNote('Work', 'Spec', 'The spec.')
    await vault.createNote('', 'Journal', 'See [[Work/Spec.md]].')
    expect(vault.backlinkMap.value.get('Work/Spec.md')).toEqual(['Journal.md'])
  })
})
