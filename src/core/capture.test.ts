/**
 * Quick capture.
 *
 * Most of what capture does is decide where a line goes and what it looks like
 * when it gets there, so most of what is here is text in and text out. The
 * failures worth guarding against are all silent ones: a task filed into a code
 * fence because the fence contained the word "Tasks", a second capture that
 * starts a second list instead of joining the first, a typed date deleted by
 * the machinery that writes dates, and a shared URL captured twice because a
 * reload replayed it.
 */

import { describe, expect, it, vi } from 'vitest'
import { parseYmd, ymd } from './util'
import { findDue } from './markdown'
import {
  captureTitle,
  clearedSearch,
  insertLines,
  parseLaunchIntent,
  stripMarker,
  taskLines,
} from './capture'

type Vault = typeof import('./vault')
type Capture = typeof import('./capture')
type Settings = typeof import('./settings')

let seq = 0

async function fresh(): Promise<{ vault: Vault; capture: Capture; settings: Settings }> {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = `slate-capture-${++seq}`
  const vault = await import('./vault')
  await vault.initVault()
  const settings = await import('./settings')
  const capture = await import('./capture')
  return { vault, capture, settings }
}

const DAY = parseYmd('2026-09-10')!

describe('putting a line in a note', () => {
  it('files under the heading, at the end of that section', () => {
    const note = '# Monday\n\n## Tasks\n- [ ] Post the parcel\n\n## Notes\nSomething else.\n'
    const out = insertLines(note, '## Tasks', ['- [ ] Call the vet'])
    expect(out).toBe(
      '# Monday\n\n## Tasks\n- [ ] Post the parcel\n- [ ] Call the vet\n\n## Notes\nSomething else.\n',
    )
  })

  it('writes the heading when the note hasn’t got one', () => {
    const out = insertLines('# Monday\n\nSlept badly.\n', '## Tasks', ['- [ ] Call the vet'])
    expect(out).toBe('# Monday\n\nSlept badly.\n\n## Tasks\n- [ ] Call the vet\n')
  })

  it('joins the list it wrote last time rather than starting another', () => {
    const first = insertLines('# Monday\n', '## Tasks', ['- [ ] One'])
    const second = insertLines(first, '## Tasks', ['- [ ] Two'])
    expect(second).toBe('# Monday\n\n## Tasks\n- [ ] One\n- [ ] Two\n')
    // And a third time, to be sure the gap between them never widens.
    expect(insertLines(second, '## Tasks', ['- [ ] Three'])).toBe(
      '# Monday\n\n## Tasks\n- [ ] One\n- [ ] Two\n- [ ] Three\n',
    )
  })

  it('matches the heading at any level, so a vault that writes # Tasks keeps one list', () => {
    const out = insertLines('# Tasks\n- [ ] One\n', '## Tasks', ['- [ ] Two'])
    expect(out).toBe('# Tasks\n- [ ] One\n- [ ] Two\n')
  })

  it('ignores a heading inside a code fence', () => {
    const note = '# Monday\n\n```md\n## Tasks\n- [ ] an example\n```\n'
    const out = insertLines(note, '## Tasks', ['- [ ] Real work'])
    // The fence is left exactly as it was, and a real heading is added below it.
    expect(out).toBe(`${note}\n## Tasks\n- [ ] Real work\n`)
  })

  it('never writes into frontmatter', () => {
    const note = '---\ntags: [work]\n---\n\n# Monday\n'
    const out = insertLines(note, '', ['- [ ] Call the vet'])
    expect(out).toBe('---\ntags: [work]\n---\n\n# Monday\n- [ ] Call the vet\n')
  })

  it('adds to the end of the note when no heading is asked for', () => {
    expect(insertLines('# Monday\n\n- [ ] One\n\n\n', '', ['- [ ] Two'])).toBe(
      '# Monday\n\n- [ ] One\n- [ ] Two\n',
    )
  })

  it('leaves a note it has nothing to add to alone', () => {
    expect(insertLines('# Monday\n', '## Tasks', [])).toBe('# Monday\n')
  })
})

describe('what a captured line looks like', () => {
  it('makes one task per line, so a pasted list is a list', () => {
    expect(taskLines('Call the vet\nBook the car in')).toEqual([
      '- [ ] Call the vet',
      '- [ ] Book the car in',
    ])
  })

  it('does not prefix a line that arrived already wearing a marker', () => {
    expect(taskLines('- [ ] Call the vet')).toEqual(['- [ ] Call the vet'])
    expect(taskLines('* Call the vet')).toEqual(['- [ ] Call the vet'])
    expect(taskLines('1. Call the vet')).toEqual(['- [ ] Call the vet'])
  })

  it('writes a chosen date in the form the task index reads back', () => {
    const [line] = taskLines('Call the vet', DAY)
    expect(line).toBe(`- [ ] Call the vet 📅 ${ymd(DAY)}`)
    expect(findDue(line)?.date).toBe(DAY)
  })

  it('leaves a date the user typed alone when no chip was pressed', () => {
    // `withDue` clears existing markers before writing, so calling it with no
    // date would delete this one — which is why it is only called with one.
    expect(taskLines('Call the vet 📅 2026-09-20')).toEqual(['- [ ] Call the vet 📅 2026-09-20'])
  })

  it('replaces a typed date when a chip was pressed', () => {
    expect(taskLines('Call the vet 📅 2026-09-20', DAY)).toEqual([
      `- [ ] Call the vet 📅 ${ymd(DAY)}`,
    ])
  })

  it('skips blank lines', () => {
    expect(taskLines('One\n\n   \nTwo')).toEqual(['- [ ] One', '- [ ] Two'])
  })

  it('titles a note from its first line', () => {
    expect(captureTitle('Call the vet\nabout the booster')).toBe('Call the vet')
    expect(captureTitle('# Call the vet')).toBe('Call the vet')
    expect(captureTitle('- [ ] Call the vet')).toBe('Call the vet')
    expect(captureTitle('\n\nCall the vet')).toBe('Call the vet')
    expect(captureTitle('   ')).toBe('Untitled')
  })

  it('strips a marker without eating the words after it', () => {
    expect(stripMarker('2. [x] Ring back — twice')).toBe('Ring back — twice')
  })
})

describe('what a URL asks for on the way in', () => {
  it('reads the launcher shortcuts', () => {
    expect(parseLaunchIntent('?add=task')).toEqual({ kind: 'capture', mode: 'task', text: '' })
    expect(parseLaunchIntent('?add=note')).toEqual({ kind: 'capture', mode: 'note', text: '' })
    expect(parseLaunchIntent('?open=today')).toEqual({ kind: 'daily' })
  })

  it('reads a share, which is prose or a link and so a note', () => {
    expect(parseLaunchIntent('?title=Recipe&text=Looks%20good&url=https%3A%2F%2Fex.com')).toEqual({
      kind: 'capture',
      mode: 'note',
      text: 'Recipe\nLooks good\nhttps://ex.com',
    })
  })

  it('does not repeat a URL that the shared text already contains', () => {
    // Android shares often put the link in `text` and in `url` both.
    expect(parseLaunchIntent('?text=Read%20this%20https%3A%2F%2Fex.com&url=https%3A%2F%2Fex.com'))
      .toEqual({ kind: 'capture', mode: 'note', text: 'Read this https://ex.com' })
  })

  it('asks for nothing when the URL says nothing', () => {
    expect(parseLaunchIntent('')).toBeUndefined()
    expect(parseLaunchIntent('?foo=bar')).toBeUndefined()
  })

  it('clears only what it consumed, so a reload cannot capture twice', () => {
    expect(clearedSearch('?add=task&text=hi')).toBe('')
    expect(clearedSearch('?add=task&keep=1')).toBe('?keep=1')
    expect(clearedSearch('')).toBe('')
  })
})

describe('capturing into the vault', () => {
  it('writes the task into the day’s note, making the note if the day hasn’t got one', async () => {
    const { vault, capture } = await fresh()
    const r = await capture.captureTasks({ text: 'Call the vet', due: DAY, day: DAY })

    expect(r.ok).toBe(true)
    expect(r.ok && r.path).toBe('Daily/2026-09-10.md')
    expect(vault.getRaw('Daily/2026-09-10.md')?.text).toContain(
      `## Tasks\n- [ ] Call the vet 📅 ${ymd(DAY)}`,
    )
    // And it is a task the rest of the app can see, not just a line of text.
    expect(vault.tasks.value.map((t) => t.text)).toEqual(['Call the vet'])
  })

  it('adds the second capture to the same list', async () => {
    const { vault, capture } = await fresh()
    await capture.captureTasks({ text: 'One', day: DAY })
    await capture.captureTasks({ text: 'Two', day: DAY })

    expect(vault.contentNotes.value.filter((n) => n.folder === 'Daily')).toHaveLength(1)
    expect(vault.getRaw('Daily/2026-09-10.md')?.text).toContain('- [ ] One\n- [ ] Two')
  })

  it('makes one task per line of a pasted list', async () => {
    const { vault, capture } = await fresh()
    const r = await capture.captureTasks({ text: 'One\nTwo\nThree', day: DAY })
    expect(r.ok && r.count).toBe(3)
    expect(vault.tasks.value).toHaveLength(3)
  })

  it('refuses a note that says it is read-only, and says so', async () => {
    const { vault, capture, settings } = await fresh()
    settings.settings.value = { ...settings.settings.value, quickAddTaskTarget: 'inbox' }
    await vault.createNote('', 'Inbox', '---\nread-only: true\n---\n\n# Inbox\n')

    const r = await capture.captureTasks({ text: 'Call the vet' })
    expect(r).toEqual({ ok: false, reason: 'locked' })
    expect(vault.tasks.value).toHaveLength(0)
  })

  it('files into one Inbox note when that is the setting', async () => {
    const { vault, capture, settings } = await fresh()
    settings.settings.value = { ...settings.settings.value, quickAddTaskTarget: 'inbox' }

    const r = await capture.captureTasks({ text: 'Call the vet' })
    expect(r.ok && r.path).toBe('Inbox.md')
    // A second one joins it rather than making `Inbox 2.md`.
    await capture.captureTasks({ text: 'Book the car in' })
    expect(vault.contentNotes.value.filter((n) => n.title === 'Inbox')).toHaveLength(1)
  })

  it('names a captured note after its first line, so nothing is left Untitled', async () => {
    const { vault, capture } = await fresh()
    const r = await capture.captureNote({ text: 'Call the vet\n\nAsk about the booster.' })

    expect(r.ok && r.path).toBe('Call the vet.md')
    expect(vault.getRaw('Call the vet.md')?.text).toBe(
      '# Call the vet\n\nAsk about the booster.\n',
    )
  })

  it('writes nothing at all for an empty capture', async () => {
    const { vault, capture } = await fresh()
    expect(await capture.captureTasks({ text: '   ' })).toEqual({ ok: false, reason: 'empty' })
    expect(await capture.captureNote({ text: '' })).toEqual({ ok: false, reason: 'empty' })
    expect(vault.contentNotes.value).toHaveLength(0)
  })
})
