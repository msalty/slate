/**
 * Notes a program outside Slate owns — the `source:` key.
 *
 * Two halves, and both are about the same line. Such a note is linkable,
 * searchable and on the agenda, and it is not your material: it is kept out of
 * every roll-up, or six hundred imported meetings flood the note list, the
 * task list and every tag count the day an importer first runs. And it is not
 * yours to edit: a change typed into it is written over on the importer's next
 * run, so nothing in Slate may change it until it has been detached.
 */

import { describe, expect, it, vi } from 'vitest'
import { externalSource, isWriteProtected } from './markdown'
import { groupMentions } from './mentions'
import type { NoteIndexEntry } from './types'
import { parseYmd } from './util'

type Vault = typeof import('./vault')

let seq = 0

async function fresh(): Promise<Vault> {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = `slate-external-${++seq}`
  const vault = await import('./vault')
  await vault.initVault()
  return vault
}

const fm = (...lines: string[]) => `---\n${lines.join('\n')}\n---\n\n`

const IMPORTED = `${fm(
  'title: Design review',
  'start: 2026-09-21T09:30',
  'attendees:',
  '  - "[[Jane Doe]]"',
  'source: fastmail',
  'uid: 3f2a@fastmail.com',
)}#work\n\n- [ ] Dial in\n\n[[Nowhere at all]]\n`

describe('reading `source:`', () => {
  it('names the provider, trimmed', () => {
    expect(externalSource({ source: 'fastmail', uid: 'u' })).toBe('fastmail')
    expect(externalSource({ source: '  icloud ', uid: 'u' })).toBe('icloud')
    expect(externalSource({ source: 7, uid: 1 })).toBe('7')
  })

  it('names nobody when absent, empty, a list or a flag', () => {
    expect(externalSource({ uid: 'u' })).toBeUndefined()
    expect(externalSource({ source: '', uid: 'u' })).toBeUndefined()
    expect(externalSource({ source: '   ', uid: 'u' })).toBeUndefined()
    expect(externalSource({ source: ['a', 'b'], uid: 'u' })).toBeUndefined()
    expect(externalSource({ source: true, uid: 'u' })).toBeUndefined()
  })

  /*
   * `source:` alone already means other things here. A conversation keeps the
   * rule it asks over in it — every one has `source: all` at the least — a
   * summary records what it summarised, and a clipped article names its page.
   * Read as an owner, each was locked against editing and gone from the list.
   */
  it('is no owner without the `uid:` an importer writes beside it', async () => {
    expect(externalSource({ type: 'conversation', source: 'all' })).toBeUndefined()
    expect(externalSource({ generated: true, source: '#work' })).toBeUndefined()
    expect(externalSource({ source: 'https://example.com/article' })).toBeUndefined()
    expect(externalSource({ source: 'fastmail', uid: '' })).toBeUndefined()
    const vault = await fresh()
    const asked = await vault.createNote(
      '',
      'Asked',
      `${fm('type: conversation', 'source: all')}# Q\n`,
    )
    const clipped = await vault.createNote(
      '',
      'Clipped',
      `${fm('source: https://example.com')}Text\n`,
    )
    for (const path of [asked, clipped]) {
      expect(vault.getEntry(path)?.source).toBeUndefined()
      expect(vault.contentNotes.value.map((n) => n.path)).toContain(path)
    }
  })

  it('protects the note as a lock does', () => {
    expect(isWriteProtected({ source: 'fastmail', uid: 'u' })).toBe(true)
    expect(isWriteProtected({ 'read-only': true })).toBe(true)
    expect(isWriteProtected({ title: 'x' })).toBe(false)
  })

  it('is on the index entry', async () => {
    const vault = await fresh()
    const path = await vault.createNote('Calendar', 'Design review', IMPORTED)
    const mine = await vault.createNote('', 'Mine', '# Mine\n')
    expect(vault.getEntry(path)?.source).toBe('fastmail')
    expect(vault.isExternal(vault.getEntry(path)!)).toBe(true)
    expect(vault.getEntry(mine)?.source).toBeUndefined()
    expect(vault.isExternal(vault.getEntry(mine)!)).toBe(false)
  })
})

describe('which surfaces an imported note reaches', () => {
  it('is searchable and linkable, and not your material', async () => {
    const vault = await fresh()
    const path = await vault.createNote('Calendar', 'Design review', IMPORTED)
    await vault.createNote('', 'Jane Doe', '# Jane\n')
    await vault.createNote('', 'Mine', '#home\n\n- [ ] Mine to do\n')

    expect(vault.notes.value.map((n) => n.path)).toContain(path)
    expect(vault.linkableNotes.value.map((n) => n.path)).toContain(path)
    expect(vault.contentNotes.value.map((n) => n.path)).not.toContain(path)
    expect(vault.contentNotes.value).toHaveLength(2)
  })

  it('stays out of every roll-up', async () => {
    const vault = await fresh()
    const path = await vault.createNote('Calendar', 'Design review', IMPORTED)
    await vault.createNote('', 'Mine', '#home\n\n- [ ] Mine to do\n')

    expect(vault.tasks.value.map((t) => t.text)).toEqual(['Mine to do'])
    expect(vault.allTags.value.map((t) => t.tag)).toEqual(['home'])
    const day = parseYmd('2026-09-21')!
    expect(vault.notesByDay.value.get(day) ?? []).not.toContain(path)
    // A broken link in a generated file is not yours to fix.
    expect(vault.unresolvedLinks.value.has('Nowhere at all')).toBe(false)
  })

  it('is on the agenda, and its links are still backlinks', async () => {
    const vault = await fresh()
    const path = await vault.createNote('Calendar', 'Design review', IMPORTED)
    const jane = await vault.createNote('', 'Jane Doe', '# Jane\n')
    const day = parseYmd('2026-09-21')!
    expect(vault.eventsByDay.value.get(day)?.map((e) => e.path)).toEqual([path])
    expect(vault.backlinkMap.value.get(jane)).toEqual([path])
  })

  it('keeps the same list when nothing is imported, so nothing downstream recomputes', async () => {
    const vault = await fresh()
    await vault.createNote('', 'Mine', '# Mine\n')
    expect(vault.contentNotes.value).toBe(vault.linkableNotes.value)
  })

  it('joins the roll-ups once detached', async () => {
    const vault = await fresh()
    const path = await vault.createNote('Calendar', 'Design review', IMPORTED)
    expect(await vault.detachNote(path)).toBe(true)
    expect(vault.contentNotes.value.map((n) => n.path)).toContain(path)
    expect(vault.tasks.value.map((t) => t.text)).toEqual(['Dial in'])
  })
})

describe('writing to an imported note from outside it', () => {
  it('will not tick its tasks or date them', async () => {
    const vault = await fresh()
    const path = await vault.createNote('Calendar', 'Design review', IMPORTED)
    const line = IMPORTED.split('\n').indexOf('- [ ] Dial in')
    expect(await vault.toggleTask(path, line)).toBe(false)
    expect(await vault.setDue(path, line, parseYmd('2026-09-22'))).toBe(false)
    expect(vault.getText(path)).toBe(IMPORTED)
  })

  /*
   * Quick Add finds its inbox among your own notes, so an imported note that
   * happens to be called Inbox is not it — the tasks go to one of your own and
   * the import is left as it was written.
   */
  it('will not take Quick Add tasks into it', async () => {
    const vault = await fresh()
    const settings = await import('./settings')
    const capture = await import('./capture')
    settings.settings.value = { ...settings.settings.value, quickAddTaskTarget: 'inbox' }
    const inbox = await vault.createNote(
      '',
      'Inbox',
      `${fm('source: fastmail', 'uid: u')}# Inbox\n`,
    )
    const before = vault.getText(inbox)
    const r = await capture.captureTasks({ text: 'Call Jane' })
    expect(r.ok && r.path).not.toBe(inbox)
    expect(vault.getText(inbox)).toBe(before)
  })
})

describe('Detach', () => {
  it('takes out `source:` and `uid:` and leaves the rest as written', async () => {
    const vault = await fresh()
    const path = await vault.createNote('Calendar', 'Design review', IMPORTED)
    expect(await vault.detachNote(path)).toBe(true)
    const text = vault.getText(path)!
    expect(text).not.toMatch(/^source:/m)
    expect(text).not.toMatch(/^uid:/m)
    expect(text).toContain('title: Design review')
    expect(text).toContain('start: 2026-09-21T09:30')
    expect(text).toContain('  - "[[Jane Doe]]"')
    expect(text).toContain('- [ ] Dial in')
    expect(vault.getEntry(path)?.source).toBeUndefined()
  })

  it('takes every copy of the key, since any one of them would still own it', async () => {
    const vault = await fresh()
    const path = await vault.createNote(
      '',
      'Twice',
      `${fm('source: a', 'source: b', 'uid: u', 'x: 1')}Body\n`,
    )
    expect(await vault.detachNote(path)).toBe(true)
    expect(vault.getEntry(path)?.source).toBeUndefined()
    expect(vault.getText(path)).toContain('x: 1')
  })

  it('does nothing to a note nothing owns', async () => {
    const vault = await fresh()
    const text = `${fm('uid: mine')}Body\n`
    const path = await vault.createNote('', 'Mine', text)
    expect(await vault.detachNote(path)).toBe(false)
    expect(vault.getText(path)).toBe(text)
  })

  it('makes the note editable from outside it again', async () => {
    const vault = await fresh()
    const path = await vault.createNote('Calendar', 'Design review', IMPORTED)
    await vault.detachNote(path)
    const line = vault.getText(path)!.split('\n').indexOf('- [ ] Dial in')
    expect(await vault.toggleTask(path, line)).toBe(true)
    expect(vault.getText(path)).toContain('- [x] Dial in')
  })
})

describe('grouping linked mentions by origin', () => {
  const entry = (path: string, over: Partial<NoteIndexEntry> = {}): NoteIndexEntry =>
    ({ path, title: path, mtime: 0, ...over }) as NoteIndexEntry

  it('puts your own notes first, in the order they came, and each importer in a group', () => {
    const g = groupMentions([
      entry('a.md'),
      entry('m1.md', { source: 'work', mtime: 1 }),
      entry('b.md'),
      entry('c1.md', { source: 'home', mtime: 5 }),
    ])
    expect(g.own.map((e) => e.path)).toEqual(['a.md', 'b.md'])
    expect(g.external.map((x) => [x.source, x.notes.length])).toEqual([
      ['home', 1],
      ['work', 1],
    ])
  })

  it('orders an importer’s meetings by when they happen, newest first', () => {
    const at = (d: string) => ({ start: parseYmd(d)!, end: parseYmd(d)!, allDay: true })
    const g = groupMentions([
      entry('old.md', { source: 'work', mtime: 99, event: at('2026-01-01') }),
      entry('new.md', { source: 'work', mtime: 1, event: at('2026-09-01') }),
    ])
    expect(g.external[0].notes.map((e) => e.path)).toEqual(['new.md', 'old.md'])
  })
})
