/**
 * Due dates written back into real notes.
 *
 * `withDue` is covered as a pure function in markdown.test.ts; what matters
 * here is the other half — that the task list, which is a view over every
 * note's source, edits the right line of the right file and leaves the rest of
 * it untouched.
 */

import { describe, expect, it, vi } from 'vitest'
import { startOfDay } from './util'

type Vault = typeof import('./vault')

let seq = 0

async function fresh(): Promise<Vault> {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = `slate-tasks-${++seq}`
  const vault = await import('./vault')
  await vault.initVault()
  return vault
}

const sep4 = startOfDay(new Date(2026, 8, 4))

describe('setDue', () => {
  it('adds a date to the task on the given line and nothing else', async () => {
    const v = await fresh()
    const p = await v.createNote(
      '',
      'Trip',
      '# Trip\n\n- [ ] Book flights\n- [ ] Renew passport\n\nSome prose.\n',
    )
    await v.setDue(p, 2, sep4)
    expect(v.getText(p)).toBe(
      '# Trip\n\n- [ ] Book flights 📅 2026-09-04\n- [ ] Renew passport\n\nSome prose.\n',
    )
  })

  it('replaces a date already there rather than adding a second', async () => {
    const v = await fresh()
    const p = await v.createNote('', 'T', '- [ ] Ship it 📅 2026-01-01\n')
    await v.setDue(p, 0, sep4)
    expect(v.getText(p)).toBe('- [ ] Ship it 📅 2026-09-04\n')
  })

  it('clears a date', async () => {
    const v = await fresh()
    const p = await v.createNote('', 'T', '- [ ] Ship it 📅 2026-01-01\n')
    await v.setDue(p, 0, undefined)
    expect(v.getText(p)).toBe('- [ ] Ship it\n')
  })

  it('shows up on the task the list is built from', async () => {
    const v = await fresh()
    const p = await v.createNote('', 'T', '- [ ] Ship it\n')
    await v.setDue(p, 0, sep4)
    const task = v.tasks.value.find((t) => t.path === p)!
    expect(task.due).toBe(sep4)
    // The marker is source, not part of what the row says.
    expect(task.text).toBe('Ship it')
  })

  it('refuses a line that is not a task, leaving the note alone', async () => {
    const v = await fresh()
    const before = '# Heading\n\nJust a paragraph.\n'
    const p = await v.createNote('', 'T', before)
    await v.setDue(p, 2, sep4)
    expect(v.getText(p)).toBe(before)
  })

  it('does not write when the date is already the one asked for', async () => {
    const v = await fresh()
    const p = await v.createNote('', 'T', '- [ ] Ship it 📅 2026-09-04\n')
    const before = v.getEntry(p)!.mtime
    await new Promise((r) => setTimeout(r, 2))
    await v.setDue(p, 0, sep4)
    expect(v.getEntry(p)!.mtime).toBe(before)
  })
})
