/**
 * What a conversation is allowed to search.
 *
 * Against a real vault rather than stubs, because the whole of `note:` and
 * `links:` is vault lookups — resolving a title, reading a note's outgoing
 * links, and reading the backlink map — and a stub for those would be a test
 * of the stub.
 *
 * This file exists because the browser check that was supposed to cover
 * `links:` did not. It proved the scope kept the rest of the vault *out*, and
 * the note it was pointed at happened to have no links in either direction —
 * so the hop expanded to nothing and both directions of it went unexercised
 * while the check passed.
 */

import { describe, expect, it, vi } from 'vitest'
import { ALL, noteScopeRule } from '../core/ask'

type Mods = {
  vault: typeof import('../core/vault')
  ask: typeof import('./ask')
}

let seq = 0

async function fresh(): Promise<Mods> {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = `slate-ask-${++seq}`
  const vault = await import('../core/vault')
  const ask = await import('./ask')
  await vault.initVault()
  return { vault, ask }
}

/*
 * A small graph around one note:
 *
 *   Postmortem ──▶ Migration plan ──▶ Runbook
 *   Groceries (nothing to do with any of it)
 */
async function seed(m: Mods) {
  await m.vault.createNote('', 'Runbook', '# Runbook\n\nHow to roll back.\n')
  await m.vault.createNote('', 'Migration plan', '# Migration plan\n\nSee [[Runbook]].\n')
  await m.vault.createNote('', 'Postmortem', '# Postmortem\n\nAgainst [[Migration plan|the plan]].\n')
  await m.vault.createNote('', 'Groceries', '# Groceries\n\nMilk.\n')
}

const titles = (list: Array<{ title: string }> | undefined) =>
  (list ?? []).map((n) => n.title).sort()

describe('the notes a conversation may search', () => {
  it('is the whole vault for `all`, which is what undefined means here', async () => {
    const m = await fresh()
    await seed(m)
    expect(m.ask.scopedNotes(ALL)).toBeUndefined()
    expect(m.ask.scopedNotes('')).toBeUndefined()
  })

  it('is still a Tag Folder rule when that is what the rule is', async () => {
    const m = await fresh()
    await m.vault.createNote('Work', 'Sprint', '#work\n')
    await m.vault.createNote('', 'Groceries', '#home\n')
    expect(titles(m.ask.scopedNotes('#work'))).toEqual(['Sprint'])
  })

  it('is one note, and only that note, for `note:`', async () => {
    const m = await fresh()
    await seed(m)
    expect(titles(m.ask.scopedNotes(noteScopeRule('note', 'Migration plan')))).toEqual([
      'Migration plan',
    ])
  })

  /*
   * The check the browser test was standing in for and never made: the hop has
   * to actually add something. Runbook is reached by following a link out of
   * the note; Postmortem by following one in.
   */
  it('reaches one hop in both directions for `links:`', async () => {
    const m = await fresh()
    await seed(m)
    expect(titles(m.ask.scopedNotes(noteScopeRule('links', 'Migration plan')))).toEqual([
      'Migration plan',
      'Postmortem',
      'Runbook',
    ])
  })

  it('leaves out a note that is merely nearby in the vault', async () => {
    const m = await fresh()
    await seed(m)
    expect(titles(m.ask.scopedNotes(noteScopeRule('links', 'Migration plan')))).not.toContain(
      'Groceries',
    )
  })

  /* Two hops from anything in a linked vault is most of the vault. */
  it('does not take a second hop', async () => {
    const m = await fresh()
    await seed(m)
    // Runbook's only neighbour is Migration plan; Postmortem is two away.
    expect(titles(m.ask.scopedNotes(noteScopeRule('links', 'Runbook')))).toEqual([
      'Migration plan',
      'Runbook',
    ])
  })

  it('follows a link written with an alias', async () => {
    const m = await fresh()
    await seed(m)
    // Postmortem points at the plan as `[[Migration plan|the plan]]`.
    expect(titles(m.ask.scopedNotes(noteScopeRule('links', 'Postmortem')))).toEqual([
      'Migration plan',
      'Postmortem',
    ])
  })

  it('puts the note itself first, so it survives the limit', async () => {
    const m = await fresh()
    await seed(m)
    const scoped = m.ask.scopedNotes(noteScopeRule('links', 'Migration plan'))
    expect(scoped?.[0].title).toBe('Migration plan')
  })

  it('counts a note once however many ways it is connected', async () => {
    const m = await fresh()
    await m.vault.createNote('', 'A', '# A\n\n[[B]]\n')
    // B links back to A as well as being linked from it.
    await m.vault.createNote('', 'B', '# B\n\n[[A]]\n')
    expect(titles(m.ask.scopedNotes(noteScopeRule('links', 'A')))).toEqual(['A', 'B'])
  })

  /*
   * Nothing, not everything. Falling back to the whole vault is right for a Tag
   * Folder rule somebody mistyped — that is a syntax error — but a scope naming
   * a note that has been deleted or renamed is not, and widening it would be
   * exactly the surprise these rules exist to remove.
   */
  it('searches nothing at all when the note it names is gone', async () => {
    const m = await fresh()
    await seed(m)
    expect(m.ask.scopedNotes(noteScopeRule('links', 'Never Existed'))).toEqual([])
    expect(m.ask.scopedNotes(noteScopeRule('note', 'Never Existed'))).toEqual([])
  })

  it('is not fooled by a broken link out of the note', async () => {
    const m = await fresh()
    await m.vault.createNote('', 'Plan', '# Plan\n\nSee [[Nothing Here]].\n')
    expect(titles(m.ask.scopedNotes(noteScopeRule('links', 'Plan')))).toEqual(['Plan'])
  })
})

describe('whether the search has anywhere to look', () => {
  it('says no when the scope is one note and that note is pinned', async () => {
    const m = await fresh()
    await seed(m)
    const source = noteScopeRule('note', 'Migration plan')
    expect(m.ask.searchesAnything(source, ['Migration plan'], 'Ask.md')).toBe(false)
  })

  it('says yes as soon as the hop brings in something else', async () => {
    const m = await fresh()
    await seed(m)
    const source = noteScopeRule('links', 'Migration plan')
    expect(m.ask.searchesAnything(source, ['Migration plan'], 'Ask.md')).toBe(true)
  })

  it('says yes for the same note scope when nothing is pinned', async () => {
    const m = await fresh()
    await seed(m)
    const source = noteScopeRule('note', 'Migration plan')
    expect(m.ask.searchesAnything(source, [], 'Ask.md')).toBe(true)
  })

  it('says yes for the whole vault, whatever is pinned', async () => {
    const m = await fresh()
    await seed(m)
    expect(m.ask.searchesAnything(ALL, ['Migration plan'], 'Ask.md')).toBe(true)
  })

  /*
   * A scope that resolves to nothing has nothing to search either — and saying
   * so is what stops a turn spending a request asking for terms to run against
   * an empty set.
   */
  it('says no when the scope resolves to nothing at all', async () => {
    const m = await fresh()
    await seed(m)
    expect(m.ask.searchesAnything(noteScopeRule('note', 'Never Existed'), [], 'Ask.md')).toBe(false)
  })
})
