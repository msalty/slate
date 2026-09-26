/**
 * Writing about an imported meeting, and taking one off the importer's hands.
 *
 * The importer keeps its files in folders of its own — `Calendar/Subscribed/
 * <Account>/…`, `Contacts/Address Book/<Account>/…` — so that emptying one
 * clears the imports and nothing else. That only holds if nothing of yours is
 * left inside them: your notes on a meeting are filed with your own events, and
 * so is a meeting once you detach it.
 */

import { describe, expect, it, vi } from 'vitest'
import { parseYmd } from './util'

let seq = 0

async function fresh() {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = `slate-imports-${++seq}`
  const vault = await import('./vault')
  await vault.initVault()
  const imports = await import('./imports')
  const { eventTitle } = await import('./eventname')
  return { vault, imports, eventTitle }
}

/** Where Detach put the note, having checked it got there. */
async function detached(imports: typeof import('./imports'), path: string) {
  const r = await imports.detachAndFile(path)
  if (r) expect(r.filed).toBe(true)
  return r?.path
}

const SUBSCRIBED = 'Calendar/Subscribed/Fastmail/2026/09'
const MEETING = `${SUBSCRIBED}/Standup (a41b).md`
const meeting = (start = '2026-09-21T09:00', extra = '') =>
  `---\ntitle: Standup\nstart: ${start}\n${extra}source: fastmail\nuid: a41b@fastmail.com\n---\n\nDaily.\n`

async function seedMeeting(vault: typeof import('./vault'), text = meeting()) {
  return vault.createNote(SUBSCRIBED, 'Standup (a41b)', text, () => 'Standup (a41b)')
}

describe('Detach, for a meeting', () => {
  it('files it with your own events, under the name a hand-made one gets', async () => {
    const { vault, imports, eventTitle } = await fresh()
    expect(await seedMeeting(vault)).toBe(MEETING)
    const dest = await detached(imports, MEETING)
    expect(dest).toBe('Calendar/2026/09/Standup - 2026-09-21.md')
    expect(vault.exists(MEETING)).toBe(false)
    const e = vault.getEntry(dest!)!
    expect(e.source).toBeUndefined()
    expect(vault.getText(dest!)).not.toMatch(/^uid:/m)
    // And the agenda reads it by what it was called, not by its filename.
    expect(eventTitle(e.title, e.event?.title)).toBe('Standup')
  })

  it('takes every link to it along', async () => {
    const { vault, imports } = await fresh()
    await seedMeeting(vault)
    const mine = await vault.createNote('', 'Mine', 'See [[Standup (a41b)]].\n')
    const dest = await detached(imports, MEETING)
    expect(vault.resolveLink(vault.getEntry(mine)!.links[0])).toBe(dest)
  })

  it('takes the next name when the day already has one', async () => {
    const { vault, imports } = await fresh()
    await vault.createNote('Calendar/2026/09', 'Standup', '# Mine\n', () => 'Standup - 2026-09-21')
    await seedMeeting(vault)
    expect(await detached(imports, MEETING)).toBe('Calendar/2026/09/Standup - 2026-09-21 2.md')
  })

  it('names and files it by the day its own `start:` says, zone and all', async () => {
    const { vault, imports } = await fresh()
    // 07:00 in Tokyo on the 21st is the evening of the 20th in Europe and the
    // Americas; the file says the 21st, and so does the name.
    await seedMeeting(vault, meeting('2026-09-21T07:00', 'tz: Asia/Tokyo\n'))
    const dest = await detached(imports, MEETING)
    expect(dest).toMatch(/\/Standup - 2026-09-21\.md$/)
  })

  it('does nothing to a note nothing owns', async () => {
    const { vault, imports } = await fresh()
    const path = await vault.createNote(SUBSCRIBED, 'Mine', '---\nstart: 2026-09-21\n---\n')
    expect(await imports.detachAndFile(path)).toBeUndefined()
    expect(vault.exists(path)).toBe(true)
  })
})

describe('Detach, for a contact', () => {
  it('files it in Contacts under the name it had, which is what links say', async () => {
    const { vault, imports } = await fresh()
    const path = await vault.createNote(
      'Contacts/Address Book/Fastmail',
      'Jane Doe',
      '---\nemails: [jane@example.com]\nsource: fastmail\nuid: j1\n---\n\nMet in Lisbon.\n',
    )
    const dest = await detached(imports, path)
    expect(dest).toBe('Contacts/Jane Doe.md')
    expect(vault.resolveLink('Jane Doe')).toBe(dest)
    expect(vault.getEntry(dest!)?.source).toBeUndefined()
  })
})

describe('writing notes about a meeting', () => {
  /*
   * A 00:30 Tokyo meeting on the first of October is on the thirtieth of
   * September anywhere west of Tokyo's date line — the agenda lists it there
   * and the notes went into September's folder, but were dated the first,
   * and so were missing from the day the meeting was shown on.
   */
  it('dates the notes on the day the meeting is on here', async () => {
    const { vault, imports } = await fresh()
    await seedMeeting(vault, meeting('2026-10-01T00:30', 'tz: Asia/Tokyo\n'))
    const e = vault.getEntry(MEETING)!
    const r = await imports.notesAboutMeeting(MEETING)
    expect(vault.getEntry(r!.path)!.calendarDate).toBe(e.calendarDate)
    expect(vault.notesByDay.value.get(e.calendarDate)).toContain(r!.path)
  })

  it('makes a note of your own on its day, linked to it', async () => {
    const { vault, imports } = await fresh()
    await seedMeeting(vault)
    const r = await imports.notesAboutMeeting(MEETING)
    expect(r).toEqual({ path: 'Calendar/2026/09/Standup - 2026-09-21.md', created: true })
    const e = vault.getEntry(r!.path)!
    // Yours, on the day, and not a second event on the agenda.
    expect(e.source).toBeUndefined()
    expect(e.event).toBeUndefined()
    expect(vault.notesByDay.value.get(parseYmd('2026-09-21')!)).toContain(r!.path)
    expect(vault.eventsByDay.value.get(parseYmd('2026-09-21')!)?.map((x) => x.path)).toEqual([
      MEETING,
    ])
    // At the top of the meeting's mentions, by way of the link back.
    expect(vault.backlinkMap.value.get(MEETING)).toEqual([r!.path])
    expect(vault.getText(r!.path)).toContain('# Standup')
  })

  it('opens the notes you already have rather than making more', async () => {
    const { vault, imports } = await fresh()
    await seedMeeting(vault)
    const first = await imports.notesAboutMeeting(MEETING)
    expect(await imports.notesAboutMeeting(MEETING)).toEqual({ path: first!.path, created: false })
    expect(vault.notes.value.filter((n) => !n.source)).toHaveLength(1)
  })

  it('makes one note however quickly it is asked twice', async () => {
    const { vault, imports } = await fresh()
    await seedMeeting(vault)
    const [a, b] = await Promise.all([
      imports.notesAboutMeeting(MEETING),
      imports.notesAboutMeeting(MEETING),
    ])
    expect(a!.path).toBe(b!.path)
    expect(imports.notesForMeeting(MEETING)).toEqual([a!.path])
  })

  it('is not fooled by a note that merely mentions the meeting', async () => {
    const { vault, imports } = await fresh()
    await seedMeeting(vault)
    await vault.createNote('', 'Diary', 'Sat through [[Standup (a41b)]] again.\n')
    expect((await imports.notesAboutMeeting(MEETING))?.created).toBe(true)
  })

  it('still finds them after the meeting is detached and moved', async () => {
    const { vault, imports } = await fresh()
    await seedMeeting(vault)
    const notes = await imports.notesAboutMeeting(MEETING)
    const moved = await detached(imports, MEETING)
    expect(imports.notesForMeeting(moved!)).toEqual([notes!.path])
  })

  it('is not offered for a note that is not an event', async () => {
    const { vault, imports } = await fresh()
    const path = await vault.createNote('', 'Plain', '# Plain\n')
    expect(await imports.notesAboutMeeting(path)).toBeUndefined()
  })
})
