/**
 * The example vault in `docs/examples/`, read the way the design says.
 *
 * Those files are the contract with the calendar and contacts helper, shown as
 * files rather than described: what it writes, and what Slate makes beside it.
 * The helper is tested against producing them; this is the other half, Slate
 * reading them. A change here that stops one of them reading as documented is
 * a change to the contract, and has to be made in the docs and the helper too.
 */

import { describe, expect, it, vi } from 'vitest'
import { parseYmd } from './util'

const FILES = import.meta.glob('../../docs/examples/vault/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const ROOT = '../../docs/examples/vault/'
const examples = Object.entries(FILES).map(([key, text]) => ({
  path: key.slice(ROOT.length),
  text,
}))

let seq = 0

/** A vault holding exactly the example files, at their own paths. */
async function exampleVault() {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = `slate-examples-${++seq}`
  const vault = await import('./vault')
  await vault.initVault()
  for (const { path, text } of examples) {
    const cut = path.lastIndexOf('/')
    const name = path.slice(cut + 1, -'.md'.length)
    expect(await vault.createNote(path.slice(0, cut), name, text, () => name)).toBe(path)
  }
  const imports = await import('./imports')
  const { eventTitle } = await import('./eventname')
  return { vault, imports, eventTitle }
}

const IMPORTED = /^(Calendar\/Subscribed|Contacts\/Address Book)\//
const MEETING = 'Calendar/Subscribed/Fastmail/2026/09/Design review (b361).md'
const OFFICE = 'Calendar/Subscribed/Fastmail/2026/09/Office closed (3a77).md'
const TOKYO = 'Calendar/Subscribed/Work/2026/10/Tokyo sync (43ce).md'
const JANE = 'Contacts/Address Book/Fastmail/Jane Doe.md'
const JANE_WORK = 'Contacts/Address Book/Work/Jane Doe (Example Corp).md'
const NOTES = 'Calendar/2026/09/Design review - 2026-09-21.md'
const STANDUP = 'Calendar/2026/09/Standup - 2026-09-22.md'

async function sha256hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('')
}

describe('the example vault', () => {
  it('has every file the README describes', () => {
    expect(examples.map((e) => e.path).sort()).toEqual(
      [MEETING, OFFICE, TOKYO, JANE, JANE_WORK, NOTES, STANDUP].sort(),
    )
  })

  it('is imported exactly where the helper writes, and yours everywhere else', async () => {
    const { vault } = await exampleVault()
    for (const { path } of examples) {
      expect(vault.getEntry(path)?.source !== undefined, path).toBe(IMPORTED.test(path))
    }
    // Off the note list and every roll-up; searchable and linkable all the same.
    expect(vault.contentNotes.value.map((n) => n.path).sort()).toEqual([NOTES, STANDUP].sort())
    expect(vault.tasks.value.map((t) => t.text)).toEqual(['Send Jane the revised flow'])
  })

  it('names each import by its title and a tag from the SHA-256 of its uid', async () => {
    const { vault, eventTitle } = await exampleVault()
    for (const path of [MEETING, OFFICE, TOKYO]) {
      const e = vault.getEntry(path)!
      const uid = /^uid: (.+)$/m.exec(vault.getText(path)!)![1]
      const tag = /\(([0-9a-f]+)\)$/.exec(e.title)![1]
      expect((await sha256hex(uid)).startsWith(tag), path).toBe(true)
      // And the agenda reads it as what it was called.
      expect(eventTitle(e.title, e.event?.title)).toBe(e.event?.title)
    }
  })

  it('carries no timestamp, so the helper writes the same bytes every run', () => {
    for (const { path, text } of examples.filter((e) => IMPORTED.test(e.path))) {
      expect(text, path).not.toMatch(/^(synced_at|generated|updated|modified):/m)
    }
  })
})

describe('time, as the example events write it', () => {
  it('reads an all-day end as inclusive: two days, not three', async () => {
    const { vault } = await exampleVault()
    const on = (d: string) => vault.eventsByDay.value.get(parseYmd(d)!)?.map((e) => e.path) ?? []
    expect(on('2026-09-21')).toContain(OFFICE)
    expect(on('2026-09-22')).toContain(OFFICE)
    expect(on('2026-09-23')).not.toContain(OFFICE)
    expect(vault.getEntry(OFFICE)!.event!.allDay).toBe(true)
  })

  it('reads a zoned start in its own zone, and files it on the day it is here', async () => {
    const { vault } = await exampleVault()
    const e = vault.getEntry(TOKYO)!.event!
    // 00:30 in Tokyo on 1 October is 15:30 UTC on 30 September.
    expect(e.start).toBe(Date.UTC(2026, 8, 30, 15, 30))
    expect(e.tz).toBe('Asia/Tokyo')
    const d = new Date(e.start)
    const here = parseYmd(
      `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`,
    )!
    expect(vault.eventsByDay.value.get(here)?.map((x) => x.path)).toContain(TOKYO)
  })
})

describe('links, as the example contacts and meetings make them', () => {
  it('resolves a contact by its name, its aliases, and a disambiguated twin', async () => {
    const { vault } = await exampleVault()
    expect(vault.resolveLink('Jane Doe')).toBe(JANE)
    expect(vault.resolveLink('Jane Smith')).toBe(JANE)
    expect(vault.resolveLink('JD')).toBe(JANE)
    expect(vault.resolveLink('Jane Doe (Example Corp)')).toBe(JANE_WORK)
  })

  it('counts a matched attendee as a mention, and leaves an unmatched one as text', async () => {
    const { vault } = await exampleVault()
    expect(vault.backlinkMap.value.get(JANE)).toEqual([MEETING])
    expect(vault.backlinkMap.value.get(JANE_WORK)).toEqual([TOKYO])
    // "Sam Ortiz" is plain text: no link, so nothing unresolved either.
    expect([...vault.unresolvedLinks.value.keys()]).toEqual([])
  })

  it('finds your notes on a meeting by their `meeting:` link', async () => {
    const { vault, imports } = await exampleVault()
    expect(imports.notesForMeeting(MEETING)).toEqual([NOTES])
    const notes = vault.getEntry(NOTES)!
    expect(notes.event).toBeUndefined()
    expect(notes.calendarDate).toBe(parseYmd('2026-09-21'))
  })

  it('reads a detached meeting as an ordinary event of your own', async () => {
    const { vault, eventTitle } = await exampleVault()
    const e = vault.getEntry(STANDUP)!
    expect(e.source).toBeUndefined()
    expect(eventTitle(e.title, e.event?.title)).toBe('Standup')
    expect(vault.eventsByDay.value.get(parseYmd('2026-09-22')!)?.map((x) => x.path)).toContain(
      STANDUP,
    )
  })
})
