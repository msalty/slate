// @vitest-environment jsdom
/**
 * Write notes finishing after you have gone somewhere else.
 *
 * Making the note is a write, and a write can be slow. Pressed on one meeting
 * and followed by a click elsewhere, the note used to open when it landed,
 * over whatever had been chosen since.
 */

import { describe, expect, it, vi } from 'vitest'
import type { VaultFile } from '../core/types'

let seq = 0

async function fresh(hold: { putFile?: (f: VaultFile) => Promise<void> | void }) {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = `slate-meetingnotes-${++seq}`
  vi.doMock('../core/db', async (orig) => {
    const db = await orig<typeof import('../core/db')>()
    return {
      ...db,
      putFile: async (f: VaultFile) => {
        await hold.putFile?.(f)
        return db.putFile(f)
      },
    }
  })
  try {
    const vault = await import('../core/vault')
    await vault.initVault()
    const state = await import('./state')
    const notes = await import('./meetingNotes')
    return { vault, state, notes }
  } finally {
    vi.doUnmock('../core/db')
  }
}

const MEETING = 'backstage/calendar/Work/2026/09/Standup (a41b).md'
const text = '---\ntitle: Standup\nstart: 2026-09-21T09:00\nsource: work\nuid: u1\n---\n'

describe('Write notes', () => {
  it('does not open over a note chosen while it was writing, and says what it made', async () => {
    const hold: { putFile?: (f: VaultFile) => Promise<void> | void } = {}
    const { vault, state, notes } = await fresh(hold)
    await vault.createNote(
      'backstage/calendar/Work/2026/09',
      'Standup (a41b)',
      text,
      () => 'Standup (a41b)',
    )
    const other = await vault.createNote('', 'Other', '# Other\n')
    state.openNote(MEETING)
    hold.putFile = (f) => {
      // Somebody moves on while the note is being written.
      if (f.path.startsWith('Calendar/')) state.openNote(other)
    }
    await notes.openNotesAbout(MEETING)
    expect(state.activePath.value).toBe(other)
    expect(state.toast.value?.action?.label).toBe('Open')
    expect(vault.notes.value.some((n) => n.path.startsWith('Calendar/'))).toBe(true)
  })

  it('opens the note when nobody has gone anywhere', async () => {
    const { vault, state, notes } = await fresh({})
    await vault.createNote(
      'backstage/calendar/Work/2026/09',
      'Standup (a41b)',
      text,
      () => 'Standup (a41b)',
    )
    state.openNote(MEETING)
    await notes.openNotesAbout(MEETING)
    expect(state.activePath.value).toMatch(/^Calendar\/2026\/09\/Standup - 2026-09-21\.md$/)
  })
})
