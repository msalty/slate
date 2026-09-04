/**
 * Daily notes: found when they exist, created once when they don't.
 *
 * The failure this guards against is a second empty `2026-06-09 2.md` sitting
 * next to the note the user has been writing in all day, so every case here is
 * about the lookup finding what is already there.
 */

import { describe, expect, it, vi } from 'vitest'
import { parseYmd } from './util'

type Vault = typeof import('./vault')
type Daily = typeof import('./daily')

let seq = 0

async function fresh(): Promise<{ vault: Vault; daily: Daily }> {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = `slate-daily-${++seq}`
  const vault = await import('./vault')
  await vault.initVault()
  const daily = await import('./daily')
  return { vault, daily }
}

const DAY = parseYmd('2026-06-09')!

describe('daily notes', () => {
  it('creates the day’s note in the Daily folder, named for the day', async () => {
    const { vault, daily } = await fresh()
    const made = await daily.dailyNotePath(DAY)
    expect(made).toEqual({ path: 'Daily/2026-06-09.md', created: true, caret: undefined })
    expect(vault.getRaw(made.path)?.text).toBe('# 2026-06-09\n\n')
  })

  it('files the new note under that day in the calendar, not under today', async () => {
    const { vault, daily } = await fresh()
    const { path } = await daily.dailyNotePath(DAY)
    expect(vault.notesOnDay(DAY).map((n) => n.path)).toEqual([path])
  })

  it('opens the existing note the second time instead of making a copy', async () => {
    const { daily } = await fresh()
    const first = await daily.dailyNotePath(DAY)
    const second = await daily.dailyNotePath(DAY)
    expect(second.path).toBe(first.path)
    // And says so, which is what decides whether it opens ready to write in.
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
  })

  it('finds a daily note the user keeps somewhere else', async () => {
    const { vault, daily } = await fresh()
    const existing = await vault.createNote('Journal', '2026-06-09', '# 2026-06-09\n\nwritten\n')
    expect(daily.dailyNoteFor(DAY)?.path).toBe(existing)
    expect(await daily.dailyNotePath(DAY)).toEqual({ path: existing, created: false })
  })

  it('prefers the one in the Daily folder when a day has two', async () => {
    const { vault, daily } = await fresh()
    await vault.createNote('Journal', '2026-06-09', '# 2026-06-09\n')
    const canonical = await vault.createNote('Daily', '2026-06-09', '# 2026-06-09\n')
    expect(daily.dailyNoteFor(DAY)?.path).toBe(canonical)
  })

  it('has no note for a day nothing has been written for', async () => {
    const { daily } = await fresh()
    expect(daily.dailyNoteFor(DAY)).toBeUndefined()
  })

  it('names the note for the local day, not the UTC one', async () => {
    const { daily } = await fresh()
    // 23:30 local on the 9th is already the 10th in UTC.
    const lateEvening = new Date(2026, 5, 9, 23, 30).getTime()
    expect(daily.dailyNoteName(lateEvening)).toBe('2026-06-09')
  })
})
