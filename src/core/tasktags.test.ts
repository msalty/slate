/**
 * Tagging tasks, and gathering them with a rule.
 *
 * The feature rests on one idea: a task carries what its note says about
 * itself. Tagging a note `#home` and writing ten tasks on it is how people
 * actually keep notes — making them tag each line would be the same
 * information typed eleven times.
 */

import { describe, expect, it, vi } from 'vitest'
import { startOfDay } from './util'

type Vault = typeof import('./vault')
type Folders = typeof import('./folders')
type TagQuery = typeof import('./tagquery')

let seq = 0

async function fresh(): Promise<{ vault: Vault; folders: Folders; q: TagQuery }> {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = `slate-tt-${++seq}`
  const vault = await import('./vault')
  await vault.initVault()
  return { vault, folders: await import('./folders'), q: await import('./tagquery') }
}

const TODAY = startOfDay(Date.now())
const day = (n: number) => new Date(TODAY + n * 86_400_000).toISOString().slice(0, 10)

async function seeded() {
  const { vault, folders, q } = await fresh()
  await vault.createNote(
    'Home',
    'Kitchen',
    ['#home', '', '- [ ] Fix the tap', `- [x] Order tiles 📅 ${day(-3)}`, ''].join('\n'),
  )
  await vault.createNote(
    'Work',
    'Sprint',
    ['#work', '', `- [ ] Write the migration note 📅 ${day(-1)}`, '- [ ] Review the API change #urgent', ''].join(
      '\n',
    ),
  )
  return { vault, folders, q }
}

const match = (folders: Folders, q: TagQuery, rule: string) =>
  folders.tasksMatching(q.parseQuery(rule).node!).map((t) => t.text)

describe('what a task is tagged with', () => {
  it('inherits the tags its note carries', async () => {
    const { vault } = await seeded()
    const tap = vault.tasks.value.find((t) => t.text.startsWith('Fix the tap'))!
    expect(tap.tags).toEqual(['home'])
    expect(tap.ownTags).toEqual([])
  })

  it('keeps the ones written on its own line as well', async () => {
    const { vault } = await seeded()
    const pr = vault.tasks.value.find((t) => t.text.startsWith('Review the API'))!
    expect(pr.tags.sort()).toEqual(['urgent', 'work'])
    expect(pr.ownTags).toEqual(['urgent'])
  })

  /*
   * The one that would have made inheritance useless. `scanTags` reads the
   * whole file, so a `#urgent` on one task line makes the *note* tagged
   * urgent — and every other task on it would have inherited that from a
   * sibling rather than from the note.
   */
  it('does not inherit a tag that only a sibling task wrote', async () => {
    const { vault } = await seeded()
    const migration = vault.tasks.value.find((t) => t.text.startsWith('Write the migration'))!
    expect(migration.tags).toEqual(['work'])
    expect(migration.tags).not.toContain('urgent')
  })

  it('still counts that tag on the note itself, which does contain it', async () => {
    const { vault } = await seeded()
    const sprint = vault.notes.value.find((n) => n.title === 'Sprint')!
    expect(sprint.tags.sort()).toEqual(['urgent', 'work'])
  })
})

describe('gathering tasks with a rule', () => {
  it('by an inherited tag, which is the whole point', async () => {
    const { folders, q } = await seeded()
    expect(match(folders, q, '#home').sort()).toEqual(['Fix the tap', 'Order tiles'])
  })

  it('by a tag written on the line', async () => {
    const { folders, q } = await seeded()
    expect(match(folders, q, '#urgent')).toEqual(['Review the API change #urgent'])
  })

  it('by the folder the note lives in', async () => {
    const { folders, q } = await seeded()
    expect(match(folders, q, 'folder:Work').length).toBe(2)
  })

  it('by whether it is finished', async () => {
    const { folders, q } = await seeded()
    expect(match(folders, q, '#home is:done')).toEqual(['Order tiles'])
    expect(match(folders, q, '#home is:open')).toEqual(['Fix the tap'])
  })

  it('by whether its date has passed', async () => {
    const { folders, q } = await seeded()
    // The finished one is also overdue; asking for open work excludes it.
    expect(match(folders, q, 'due:overdue is:open')).toEqual(['Write the migration note'])
    expect(match(folders, q, 'due:none').sort()).toEqual([
      'Fix the tap',
      'Review the API change #urgent',
    ])
  })

  it('and all of it at once, which is what the folders are for', async () => {
    const { folders, q } = await seeded()
    expect(match(folders, q, '#work AND is:open AND due:any')).toEqual([
      'Write the migration note',
    ])
  })
})

describe('rules over notes and rules over tasks', () => {
  /*
   * One rule language, two things to run it over. A note is neither open nor
   * done, so the task-only questions match nothing there rather than erroring
   * — the folder's own live count is what says so.
   */
  it('parse the same, and a task question finds no notes', async () => {
    const { folders, q } = await seeded()
    expect(q.parseQuery('is:open').error).toBeUndefined()
    expect(folders.notesMatching(q.parseQuery('is:open').node!)).toEqual([])
    expect(folders.notesMatching(q.parseQuery('due:overdue').node!)).toEqual([])
  })

  it('reject a value that is not one of the few allowed', async () => {
    const { q } = await fresh()
    expect(q.parseQuery('is:nonsense').error).toMatch(/is: expects/)
    expect(q.parseQuery('due:whenever').error).toMatch(/due: expects/)
  })

  it('read back in plain English', async () => {
    const { q } = await fresh()
    expect(q.describeQuery(q.parseQuery('#home is:open due:overdue').node!)).toBe(
      '(#home and still open) and due overdue',
    )
  })
})

describe('a Tag Folder that gathers tasks', () => {
  it('says so, and returns tasks rather than notes', async () => {
    const { folders, q } = await seeded()
    void q
    await folders.saveSmartFolder({ name: 'Home jobs', query: '#home is:open', shows: 'tasks' })
    const f = folders.smartFolders.value.find((x) => x.name === 'Home jobs')!
    expect(folders.showsTasks(f)).toBe(true)
    expect(folders.tasksForSmartFolder(f.id).map((t) => t.text)).toEqual(['Fix the tap'])
  })

  it('defaults to notes, so every folder that already existed is unchanged', async () => {
    const { folders } = await seeded()
    await folders.saveSmartFolder({ name: 'Work', query: '#work' })
    const f = folders.smartFolders.value.find((x) => x.name === 'Work')!
    expect(f.shows).toBeUndefined()
    expect(folders.showsTasks(f)).toBe(false)
    expect(folders.notesForSmartFolder(f.id).map((n) => n.title)).toEqual(['Sprint'])
  })
})
