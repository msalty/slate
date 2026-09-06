/**
 * The search index.
 *
 * There is really only one thing to prove about it, and it is proved over and
 * over here from different angles: **the index changes what gets read, never
 * what gets found.** So most of these run the real search against a reference
 * implementation of the rule it is supposed to obey — every term appears in the
 * title or somewhere in the text, as a plain substring — and demand the same
 * notes back. An index that is nearly right is worse than no index.
 *
 * The rest are about staying that way: a note edited, deleted, renamed or
 * arriving from a sync has to leave the index saying exactly what the vault
 * says.
 */

import { describe, expect, it, vi } from 'vitest'

type Vault = typeof import('./vault')

let seq = 0

async function fresh(): Promise<Vault> {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = `slate-sidx-${++seq}`
  const vault = await import('./vault')
  await vault.initVault()
  return vault
}

/**
 * Seed a vault and build the index *now*.
 *
 * In the app the build runs in idle slices and searching works without it, so
 * a test that did not ask would be racing it — and half of these would quietly
 * be checking the plain scan instead of the thing they are about.
 */
async function seeded(): Promise<Vault> {
  const v = await fresh()
  for (const [folder, title, text] of CORPUS) await v.createNote(folder, title, text)
  v.warmSearchIndex(true)
  return v
}

/** The rule the index has to reproduce, written out the slow, obvious way. */
function reference(v: Vault, query: string): string[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return []
  return v.notes.value
    .filter((n) => {
      const hay = `${n.title.toLowerCase()}\n${(v.getRaw(n.path)?.text ?? '').toLowerCase()}`
      return terms.every((t) => hay.includes(t))
    })
    .map((n) => n.path)
    .sort()
}

function found(v: Vault, query: string): string[] {
  return v.search(query).map((h) => h.entry.path).sort()
}

/** Both, asserted together — the only assertion this file really makes. */
function agree(v: Vault, query: string) {
  expect(found(v, query), query).toEqual(reference(v, query))
}

const CORPUS: Array<[string, string, string]> = [
  ['', 'Sprint planning', '# Sprint planning\n\nThe budget lands on Friday. #work\n'],
  ['Work', 'Retrospective', 'What went well, what did not.\n\nSee foo.bar for the numbers.\n'],
  ['Work', 'Outage', 'Postmortem for the OUTAGE on Tuesday.\n\nSearching logs took hours.\n'],
  ['', 'Groceries', '- [ ] olive oil\n- [ ] tinned tomatoes\n'],
  ['Notes', 'Lisbon', 'Trip notes. Belém, pastéis, the 28 tram.\n'],
]

describe('finding exactly what the scan would', () => {
  it('agrees on ordinary words, whatever the case', async () => {
    const v = await seeded()
    for (const q of ['budget', 'BUDGET', 'outage', 'Postmortem', 'friday']) agree(v, q)
  })

  /*
   * The whole reason the index is over runs of non-whitespace rather than
   * words: a term can start in the middle of one, and a word-based index would
   * quietly stop finding these.
   */
  it('agrees on a term that starts mid-word', async () => {
    const v = await seeded()
    for (const q of ['ear', 'ostmortem', 'live', 'omato', 'rint']) agree(v, q)
  })

  it('agrees on punctuation, which is part of a run like anything else', async () => {
    const v = await seeded()
    for (const q of ['foo.bar', 'o.b', '#work', '- [ ]', '28']) agree(v, q)
  })

  it('agrees when every term has to match, in any order', async () => {
    const v = await seeded()
    for (const q of ['budget friday', 'friday budget', 'outage tuesday', 'budget tuesday'])
      agree(v, q)
  })

  it('agrees on a word that is only in the title', async () => {
    const v = await seeded()
    // "Groceries" appears nowhere in the file — it is the name of the file.
    agree(v, 'groceries')
    expect(found(v, 'groceries')).toEqual(['Groceries.md'])
  })

  it('agrees on a term nothing contains', async () => {
    const v = await seeded()
    expect(found(v, 'zeppelin')).toEqual([])
    agree(v, 'zeppelin')
    agree(v, 'budget zeppelin')
  })

  it('agrees on accented text, which is not folded away', async () => {
    const v = await seeded()
    for (const q of ['belém', 'pastéis', 'BELÉM']) agree(v, q)
  })

  /*
   * Ranking is the scan's job and stayed exactly where it was; the index only
   * hands it a shorter list. A title match still outranks a body match.
   */
  it('leaves the ranking alone', async () => {
    const v = await fresh()
    await v.createNote('', 'Budget', 'Nothing in particular.\n')
    await v.createNote('', 'Meeting', 'Talked about the budget at length.\n')
    v.warmSearchIndex(true)
    expect(v.search('budget').map((h) => h.entry.title)).toEqual(['Budget', 'Meeting'])
  })

  /*
   * The index is not there for the first moments of a session, and a vault
   * that has just been replaced by a sync drops it entirely. Neither is a
   * degraded mode — it is the search this app has always had.
   */
  it('answers the same before the index exists at all', async () => {
    const v = await fresh()
    for (const [folder, title, text] of CORPUS) await v.createNote(folder, title, text)
    for (const q of ['budget', 'ear', 'groceries', 'budget friday', 'zeppelin']) agree(v, q)
  })
})

describe('keeping up with the vault', () => {
  it('finds a note written after the index was built', async () => {
    const v = await seeded()
    expect(found(v, 'kayak')).toEqual([])
    await v.createNote('', 'Weekend', 'Booked a kayak for Saturday.\n')
    agree(v, 'kayak')
    expect(found(v, 'kayak')).toEqual(['Weekend.md'])
  })

  it('stops finding a word that has been edited out', async () => {
    const v = await seeded()
    expect(found(v, 'budget')).toEqual(['Sprint planning.md'])
    await v.saveNote('Sprint planning.md', '# Sprint planning\n\nThe forecast lands on Friday.\n')
    expect(found(v, 'budget')).toEqual([])
    agree(v, 'budget')
    agree(v, 'forecast')
  })

  it('drops a deleted note, and finds it again when it is restored', async () => {
    const v = await seeded()
    expect(found(v, 'postmortem')).toEqual(['Work/Outage.md'])
    await v.deleteNote('Work/Outage.md')
    expect(found(v, 'postmortem')).toEqual([])
    agree(v, 'postmortem')

    // Restoring puts it back at the vault root, which is where the trash
    // remembers it by name — the note is findable again either way.
    const trashed = v.trashItems()[0]
    const back = await v.restoreFromTrash(trashed.path)
    agree(v, 'postmortem')
    expect(found(v, 'postmortem')).toEqual([back])
  })

  it('follows a renamed note to its new path and title', async () => {
    const v = await seeded()
    const next = await v.renameNote('Groceries.md', 'Shopping')
    expect(next).toBe('Shopping.md')
    expect(found(v, 'groceries')).toEqual([])
    expect(found(v, 'shopping')).toEqual(['Shopping.md'])
    expect(found(v, 'tomatoes')).toEqual(['Shopping.md'])
    agree(v, 'groceries')
    agree(v, 'tomatoes')
  })

  it('never answers with backstage, which is not a note', async () => {
    const v = await seeded()
    await v.writeBackstage('folders.json', ['Sprint planning is not in here'])
    for (const hit of v.search('sprint')) expect(hit.entry.path.startsWith('backstage/')).toBe(false)
    agree(v, 'sprint')
  })
})
