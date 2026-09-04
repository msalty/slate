/**
 * What the search box searches.
 *
 * The rule is that a search filters the kind of thing the list is showing, so
 * these check the two halves that rule is made of: which corpus a given scope
 * points the search at, and that each list actually narrows to it. Before
 * this, every scope searched notes — so typing in Files replaced the file
 * browser with note results and there was no way to find a file at all.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

type Vault = typeof import('../core/vault')
type State = typeof import('./state')
type Folders = typeof import('../core/folders')

let seq = 0

/** A fresh vault and a fresh state module reading from it. */
async function fresh(): Promise<{ v: Vault; st: State; f: Folders }> {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = `slate-search-${++seq}`
  const v = await import('../core/vault')
  await v.initVault()
  const f = await import('../core/folders')
  const st = await import('./state')
  return { v, st, f }
}

describe('what a scope searches', () => {
  it('points at notes for everything that shows notes', async () => {
    const { st } = await fresh()
    for (const s of [
      { kind: 'all' },
      { kind: 'folder', path: 'Work' },
      { kind: 'tag', tag: 'work' },
      { kind: 'day', date: Date.now() },
    ] as const) {
      st.setScope(s)
      expect(st.searchKind.value).toBe('notes')
    }
  })

  it('points at whatever else the list is showing', async () => {
    const { st } = await fresh()
    const cases = [
      ['files', 'files'],
      ['trash', 'trash'],
      ['unlinked', 'unlinked'],
      ['tasks', 'tasks'],
    ] as const
    for (const [kind, expected] of cases) {
      st.setScope({ kind })
      expect(st.searchKind.value).toBe(expected)
    }
  })

  it('follows a Tag Folder into tasks when that is what it gathers', async () => {
    const { st, f } = await fresh()
    const notesFolder = await f.saveSmartFolder({ name: 'Work', query: '#work' })
    const taskFolder = await f.saveSmartFolder({ name: 'Chores', query: '#home', shows: 'tasks' })

    st.setScope({ kind: 'smart', id: notesFolder.id })
    expect(st.searchKind.value).toBe('notes')
    st.setScope({ kind: 'smart', id: taskFolder.id })
    expect(st.searchKind.value).toBe('tasks')
  })

  it('names what it is searching', async () => {
    const { st } = await fresh()
    expect(st.searchLabel('notes')).toBe('Notes')
    expect(st.searchLabel('files')).toBe('Files')
    expect(st.searchLabel('trash')).toBe('Deleted')
    expect(st.searchLabel('tasks')).toBe('Tasks')
    expect(st.searchLabel('unlinked')).toBe('Unlinked')
  })
})

describe('changing scope', () => {
  it('clears the query, so the box is always about the list under it', async () => {
    const { st } = await fresh()
    st.setScope({ kind: 'all' })
    st.query.value = 'budget'
    st.setScope({ kind: 'files' })
    expect(st.query.value).toBe('')
    expect(st.searching.value).toBe(false)
  })
})

describe('each list filters itself', () => {
  beforeEach(() => {
    seq++
  })

  it('narrows Files by name and path', async () => {
    const { v, st } = await fresh()
    const png = new Blob(['x'], { type: 'image/png' })
    await v.addAttachment(png, 'attachments/quarterly-chart.png')
    await v.addAttachment(png, 'attachments/holiday.png')
    await v.addAttachment(png, 'receipts/quarterly.png')
    st.setScope({ kind: 'files' })
    expect(st.fileList.value).toHaveLength(3)

    st.query.value = 'quarterly'
    expect(st.fileList.value.map((f) => f.path).sort()).toEqual([
      'attachments/quarterly-chart.png',
      'receipts/quarterly.png',
    ])

    // Every term has to land, in any order — the same rule note search uses.
    st.query.value = 'chart quarterly'
    expect(st.fileList.value.map((f) => f.path)).toEqual(['attachments/quarterly-chart.png'])
  })

  it('narrows Deleted by name and by what is in the note', async () => {
    const { v, st } = await fresh()
    await v.deleteNote(await v.createNote('', 'Budget', 'nothing to see\n'))
    await v.deleteNote(await v.createNote('', 'Packing', 'remember the budget folder\n'))
    await v.deleteNote(await v.createNote('', 'Lisbon', 'flights booked\n'))
    st.setScope({ kind: 'trash' })
    expect(st.trashList.value).toHaveLength(3)

    st.query.value = 'budget'
    expect(st.trashList.value.map((f) => v.trashTitle(f.path)).sort()).toEqual([
      'Budget',
      'Packing',
    ])

    st.query.value = 'nothing here matches this'
    expect(st.trashList.value).toEqual([])
  })

  it('finds a deleted note, which vault-wide search never could', async () => {
    const { v, st } = await fresh()
    await v.deleteNote(await v.createNote('', 'Old draft', 'the first pass\n'))
    // Trash lives under backstage/, which the note index excludes — so the
    // ranked search cannot see it and the Deleted list has to do its own.
    expect(v.search('Old draft')).toEqual([])
    st.setScope({ kind: 'trash' })
    st.query.value = 'old draft'
    expect(st.trashList.value).toHaveLength(1)
  })

  it('narrows Tasks by the task text and the note it lives on', async () => {
    const { v, st } = await fresh()
    await v.createNote('', 'Groceries', '- [ ] oat milk\n- [ ] coffee beans\n')
    await v.createNote('', 'Errands', '- [ ] collect the coffee grinder\n')
    expect(v.tasks.value).toHaveLength(3)

    st.setScope({ kind: 'tasks' })
    st.query.value = 'coffee'
    expect(st.matchingTasks(v.tasks.value).map((t) => t.text).sort()).toEqual([
      'coffee beans',
      'collect the coffee grinder',
    ])

    // The note's title counts too: it is on the row, so it is fair to aim at.
    st.query.value = 'groceries'
    expect(st.matchingTasks(v.tasks.value).map((t) => t.text).sort()).toEqual([
      'coffee beans',
      'oat milk',
    ])
  })

  it('leaves notes searching the whole vault, whatever folder you are in', async () => {
    const { v, st } = await fresh()
    await v.createNote('Work', 'Quarterly review', 'numbers ahead of plan\n')
    await v.createNote('Home', 'Quarterly bills', 'water and power\n')

    st.setScope({ kind: 'folder', path: 'Work' })
    expect(st.visibleNotes.value.map((n) => n.title)).toEqual(['Quarterly review'])

    st.query.value = 'quarterly'
    expect(st.visibleNotes.value.map((n) => n.title).sort()).toEqual([
      'Quarterly bills',
      'Quarterly review',
    ])
  })

  it('gives a scope that is not showing notes no notes to show', async () => {
    const { v, st } = await fresh()
    await v.createNote('', 'Budget', 'the yearly one\n')
    st.setScope({ kind: 'files' })
    st.query.value = 'budget'
    // It used to answer with note hits here, which is what replaced the file
    // browser with a list of notes the moment anyone typed.
    expect(st.visibleNotes.value).toEqual([])
  })
})
