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

describe('what a result row shows', () => {
  it('shows the line the match is on, not the note\u2019s opening line', async () => {
    const { v, st } = await fresh()
    const body = [
      '# Trip',
      '',
      'Booked the flights on Tuesday, which took most of the morning and a',
      'certain amount of arguing about which airport we actually want.',
      '',
      'The hotel is paid for already.',
      '',
    ].join('\n')
    const path = await v.createNote('', 'Trip', body)
    // The excerpt is what the row shows when nothing is being searched, and
    // it says nothing at all about the word we are about to look for.
    expect(v.getEntry(path)!.excerpt).toContain('Booked the flights')

    st.setScope({ kind: 'all' })
    st.query.value = 'hotel'
    const snippet = st.searchSnippets.value.get(path)!

    expect(snippet).toContain('hotel is paid for')
    expect(snippet).not.toContain('Booked the flights')
    // Cut out of the middle, and it says so at both ends.
    expect(snippet.startsWith('\u2026')).toBe(true)
  })

  it('cleans the markdown out of the window it cut', async () => {
    const { v, st } = await fresh()
    await v.createNote(
      '',
      'Styled',
      '# Styled\n\nSee **the budget** in `figures.csv`, or [[Last year|the old one]].\n',
    )
    st.setScope({ kind: 'all' })
    st.query.value = 'budget'
    const snippet = st.searchSnippets.value.get(st.visibleNotes.value[0].path)!

    expect(snippet).toContain('the budget')
    // The window is cut out of the raw file, so without cleaning it arrives
    // carrying whatever markdown happened to be around the word.
    expect(snippet).not.toMatch(/[*`[\]]/)
    expect(snippet).toContain('the old one')
  })

  it('leaves a title-only match to fall back to the excerpt', async () => {
    const { v, st } = await fresh()
    await v.createNote('', 'Budget', 'nothing about that word in here\n')
    st.setScope({ kind: 'all' })
    st.query.value = 'budget'
    expect(st.visibleNotes.value).toHaveLength(1)
    expect(st.searchSnippets.value.size).toBe(0)
  })

  it('skips the note\u2019s own heading, which is the title again', async () => {
    const { v, st } = await fresh()
    // The word is in the H1 and nowhere else. That is a title match wearing a
    // body match's clothes: a snippet of it would repeat the bold line above.
    const path = await v.createNote('', 'Budget', '# Budget\n\nnothing else about it\n')
    st.setScope({ kind: 'all' })
    st.query.value = 'budget'
    expect(st.searchSnippets.value.get(path)).toBeUndefined()
  })

  it('skips frontmatter and the heading to reach the real match', async () => {
    const { v, st } = await fresh()
    const path = await v.createNote(
      '',
      'Budget',
      '---\ntags: [money]\n---\n\n# Budget\n\nThe budget lands on Friday.\n',
    )
    st.setScope({ kind: 'all' })
    st.query.value = 'budget'
    const snippet = st.searchSnippets.value.get(path)!
    expect(snippet).toContain('The budget lands on Friday')
    expect(snippet).not.toMatch(/tags|money|---/)
  })

  it('opens on a whole word, not halfway through one', async () => {
    const { v, st } = await fresh()
    const bodies = [
      'It was considerably more expensive than the budget allowed for.',
      'Something unmistakably longer sits ahead of the budget here.',
      'Short lead-in with acknowledgement before the budget arrives.',
    ]
    st.setScope({ kind: 'all' })
    for (const [i, body] of bodies.entries()) {
      const path = await v.createNote('', `Note ${i}`, `${body}\n`)
      st.query.value = 'budget'
      const snippet = st.searchSnippets.value.get(path)!
      const first = snippet.replace(/^…/, '').split(' ')[0]
      // Whatever the run-up lands in the middle of, what it opens on is a word
      // the note actually contains — never "…iderably".
      expect(body).toContain(` ${first}`)
      expect(snippet).toContain('budget')
    }
  })

  it('keeps the match near the front, where a narrow pane can show it', async () => {
    const { v, st } = await fresh()
    const path = await v.createNote(
      '',
      'Note',
      'A long opening line of context that goes on for a while before the word budget turns up at last.\n',
    )
    st.setScope({ kind: 'all' })
    st.query.value = 'budget'
    const snippet = st.searchSnippets.value.get(path)!
    // The list pane ellipsises at around forty characters. A match further in
    // than this is a match the reader never sees marked.
    expect(snippet.toLowerCase().indexOf('budget')).toBeLessThanOrEqual(30)
  })

  it('always puts the match inside the snippet it shows', async () => {
    const { v, st } = await fresh()
    const paths = [
      await v.createNote('', 'One', '# One\n\nthe word budget is here\n'),
      await v.createNote('', 'Budget', '# Budget\n\nbut not in the prose\n'),
      await v.createNote('', 'Three', 'no heading at all, just budget\n'),
    ]
    st.setScope({ kind: 'all' })
    st.query.value = 'budget'
    // A snippet that does not contain the word renders with nothing marked,
    // which reads as a bug. So there either is a match in it, or no snippet.
    for (const p of paths) {
      const snippet = st.searchSnippets.value.get(p)
      if (snippet !== undefined) expect(snippet.toLowerCase()).toContain('budget')
    }
  })

  it('has no snippets at all when nothing is being searched', async () => {
    const { v, st } = await fresh()
    await v.createNote('', 'Trip', 'the hotel is paid for\n')
    st.setScope({ kind: 'all' })
    expect(st.searchSnippets.value.size).toBe(0)
  })

  it('hands the rows the terms to mark', async () => {
    const { st } = await fresh()
    st.setScope({ kind: 'all' })
    st.query.value = '  Budget   Hotel '
    expect(st.queryTerms.value).toEqual(['budget', 'hotel'])
  })
})

/**
 * The search box speaking the Tag Folder rule language.
 *
 * The rule filters and the words still search, so every test here is really
 * about the seam between the two — and the first one is about there being no
 * seam at all for a search that is only words.
 */
describe('a rule in the search box', () => {
  beforeEach(() => {
    seq++
  })

  /** Three notes across two tags and two folders, plus a task on one. */
  async function vault() {
    const { v, st, f } = await fresh()
    await v.createNote('Work', 'Quarterly review', '# Quarterly review\n\n#work\n\nbudget ahead of plan\n')
    await v.createNote('Work', 'Roof', '# Roof\n\n#work #done\n\nthe budget for the roof\n')
    await v.createNote('Home', 'Groceries', '# Groceries\n\n#home\n\n- [ ] oat milk\n')
    st.setScope({ kind: 'all' })
    return { v, st, f }
  }

  it('leaves a search that is only words exactly as it was', async () => {
    const { st } = await vault()
    st.query.value = 'budget'
    expect(st.visibleNotes.value.map((n) => n.title).sort()).toEqual(['Quarterly review', 'Roof'])
    expect(st.searchQuery.value.rule).toBe('')
  })

  it('filters by a tag with no words to search for', async () => {
    const { st } = await vault()
    st.query.value = '#home'
    expect(st.searching.value).toBe(true)
    expect(st.visibleNotes.value.map((n) => n.title)).toEqual(['Groceries'])
  })

  it('applies the rule to what the words ranked', async () => {
    const { st } = await vault()
    st.query.value = '#work budget'
    expect(st.visibleNotes.value.map((n) => n.title).sort()).toEqual(['Quarterly review', 'Roof'])
    st.query.value = '#work budget -#done'
    expect(st.visibleNotes.value.map((n) => n.title)).toEqual(['Quarterly review'])
  })

  it('reaches folders and the other keys the language knows', async () => {
    const { st } = await vault()
    st.query.value = 'folder:Home'
    expect(st.visibleNotes.value.map((n) => n.title)).toEqual(['Groceries'])
    st.query.value = 'has:tasks'
    expect(st.visibleNotes.value.map((n) => n.title)).toEqual(['Groceries'])
  })

  it('searches the whole vault, the way every other search does', async () => {
    const { st } = await vault()
    // Scoped to Home, asking for #work: the rule is the question, not a second
    // filter on top of the folder you happened to be standing in.
    st.setScope({ kind: 'folder', path: 'Home' })
    st.query.value = '#work'
    expect(st.visibleNotes.value.map((n) => n.title).sort()).toEqual(['Quarterly review', 'Roof'])
  })

  it('marks the words in the rows and never the rule', async () => {
    const { st } = await vault()
    st.query.value = '#work budget'
    expect(st.queryTerms.value).toEqual(['budget'])
  })

  it('narrows tasks by the same rule, reaching is: and due:', async () => {
    const { v, st } = await vault()
    st.setScope({ kind: 'tasks' })
    st.query.value = '#home'
    // The task is not tagged; its note is, which is the whole point of a rule
    // over tasks.
    expect(st.matchingTasks(v.tasks.value).map((t) => t.text)).toEqual(['oat milk'])
    st.query.value = '#home is:done'
    expect(st.matchingTasks(v.tasks.value)).toEqual([])
  })

  it('leaves the lists a rule cannot describe searching for the text of it', async () => {
    const { v, st } = await fresh()
    const png = new Blob(['x'], { type: 'image/png' })
    await v.addAttachment(png, 'attachments/#work-chart.png')
    await v.addAttachment(png, 'attachments/holiday.png')
    st.setScope({ kind: 'files' })
    st.query.value = '#work'
    // A file has no tags to match, so `#work` is four characters to look for —
    // which is what it always was here.
    expect(st.searchQuery.value.rule).toBe('')
    expect(st.fileList.value.map((f) => f.path)).toEqual(['attachments/#work-chart.png'])
  })

  it('filters by nothing while a rule is half-typed, and says why', async () => {
    const { st } = await vault()
    st.query.value = 'is:maybe'
    expect(st.searchQuery.value.error).toBeTruthy()
    expect(st.searchQuery.value.node).toBeUndefined()
    // Read as text, so the list is honest rather than silently unfiltered.
    expect(st.visibleNotes.value).toEqual([])
  })
})

describe('a rule filters before the list is cut, not after', () => {
  beforeEach(() => {
    seq++
  })

  it('finds a tagged match past the two hundredth text hit', async () => {
    const { v, st } = await fresh()
    /*
     * The ranked text search hands back its best 200. Filtering the rule over
     * *those* meant a note that matched both could be invisible simply for
     * ranking 201st on the words — and the emptier the answer, the more
     * confidently wrong it looked.
     *
     * "budget" is in the title of all 240 so they outrank the one note whose
     * body merely mentions it, which is the note actually being asked for.
     */
    for (let i = 0; i < 240; i++) await v.createNote('', `Budget ${i}`, '#noise\n\nthe budget\n')
    const wanted = await v.createNote('', 'Roof', '#wanted\n\nthe budget for the roof\n')
    st.setScope({ kind: 'all' })

    st.query.value = 'budget'
    expect(st.visibleNotes.value.length).toBe(200)

    st.query.value = '#wanted budget'
    expect(st.visibleNotes.value.map((n) => n.path)).toEqual([wanted])
  })

  it('still caps what it hands the list once the rule has been applied', async () => {
    const { v, st } = await fresh()
    for (let i = 0; i < 240; i++) await v.createNote('', `Budget ${i}`, '#wanted\n\nthe budget\n')
    st.setScope({ kind: 'all' })
    st.query.value = '#wanted budget'
    expect(st.visibleNotes.value.length).toBe(200)
  })
})
