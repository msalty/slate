/**
 * Writing about an imported meeting, and taking one off the importer's hands.
 *
 * The importer keeps meetings in backstage (`backstage/calendar/<Account>/…`),
 * out of search, lists and mentions, and the agenda is the way in to them.
 * Nothing of yours is left in there: your notes on a meeting are filed with
 * your own events, and so is a meeting once you detach it.
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

/** Where Detach put the note. */
async function detached(imports: typeof import('./imports'), path: string) {
  return imports.detachAndFile(path)
}

const SUBSCRIBED = 'backstage/calendar/Fastmail/2026/09'
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
    const mine = await vault.createNote('', 'Mine', `See [[${MEETING.slice(0, -3)}]].\n`)
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

describe('an imported meeting in backstage', () => {
  it('is on the agenda, and nowhere a note of yours would be', async () => {
    const { vault } = await fresh()
    await seedMeeting(vault)
    const day = parseYmd('2026-09-21')!
    expect(vault.eventsByDay.value.get(day)?.map((e) => e.path)).toEqual([MEETING])
    expect(vault.notes.value.map((n) => n.path)).not.toContain(MEETING)
    expect(vault.search('Standup').map((h) => h.entry.path)).not.toContain(MEETING)
  })

  /*
   * A meeting deleted in Slate goes to `backstage/trash/` with its keys still
   * on it — still backstage, still an import, and on nobody's day.
   */
  it('is off the agenda once deleted', async () => {
    const { vault } = await fresh()
    await seedMeeting(vault)
    await vault.deleteNote(MEETING)
    expect(vault.eventsByDay.value.get(parseYmd('2026-09-21')!) ?? []).toEqual([])
  })

  it('is not on the agenda unless it is an import', async () => {
    const { vault } = await fresh()
    await vault.createNote(SUBSCRIBED, 'Stray', '---\nstart: 2026-09-21\n---\n')
    expect(vault.eventsByDay.value.get(parseYmd('2026-09-21')!) ?? []).toEqual([])
  })

  /*
   * Its attendee links are no one's mentions: a contact's mentions were every
   * meeting they sat through. Your notes carry the list instead.
   */
  it('gives its attendees no mentions, and your notes on it do', async () => {
    const { vault, imports } = await fresh()
    const jane = await vault.createNote('', 'Jane Doe', '# Jane\n')
    await seedMeeting(
      vault,
      meeting('2026-09-21T09:00', 'attendees:\n  - "[[Jane Doe]]"\n  - "Sam Ortiz"\n'),
    )
    expect(vault.backlinkMap.value.get(jane)).toBeUndefined()
    const r = await imports.notesAbout(MEETING)
    expect(vault.backlinkMap.value.get(jane)).toEqual([r!.path])
    expect(vault.getText(r!.path)).toContain('Sam Ortiz')
  })

  it('is linked from your notes by its path, which is the only name that reaches it', async () => {
    const { vault, imports } = await fresh()
    await seedMeeting(vault)
    const r = await imports.notesAbout(MEETING)
    expect(vault.getText(r!.path)).toContain(`meeting: "[[${MEETING.slice(0, -3)}]]"`)
    expect(vault.resolveLink('Standup (a41b)')).toBeUndefined()
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
    const r = await imports.notesAbout(MEETING)
    expect(vault.getEntry(r!.path)!.calendarDate).toBe(e.calendarDate)
    expect(vault.notesByDay.value.get(e.calendarDate)).toContain(r!.path)
  })

  it('makes a note of your own on its day, linked to it', async () => {
    const { vault, imports } = await fresh()
    await seedMeeting(vault)
    const r = await imports.notesAbout(MEETING)
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
    const first = await imports.notesAbout(MEETING)
    expect(await imports.notesAbout(MEETING)).toEqual({ path: first!.path, created: false })
    expect(vault.notes.value.filter((n) => !n.source)).toHaveLength(1)
  })

  it('makes one note however quickly it is asked twice', async () => {
    const { vault, imports } = await fresh()
    await seedMeeting(vault)
    const [a, b] = await Promise.all([imports.notesAbout(MEETING), imports.notesAbout(MEETING)])
    expect(a!.path).toBe(b!.path)
    expect(imports.notesForMeeting(MEETING)).toEqual([a!.path])
  })

  it('is not fooled by a note that merely mentions the meeting', async () => {
    const { vault, imports } = await fresh()
    await seedMeeting(vault)
    await vault.createNote('', 'Diary', `Sat through [[${MEETING.slice(0, -3)}]] again.\n`)
    expect((await imports.notesAbout(MEETING))?.created).toBe(true)
  })

  it('keeps its link to the meeting when the meeting is detached and moved', async () => {
    const { vault, imports } = await fresh()
    await seedMeeting(vault)
    const notes = await imports.notesAbout(MEETING)
    const moved = await detached(imports, MEETING)
    const link = /^meeting: "\[\[(.*)\]\]"$/m.exec(vault.getText(notes!.path)!)![1]
    expect(vault.resolveLink(link)).toBe(moved)
    expect(vault.backlinkMap.value.get(moved!)).toEqual([notes!.path])
  })

  it('is not offered for a note that is not an event', async () => {
    const { vault, imports } = await fresh()
    const path = await vault.createNote('', 'Plain', '# Plain\n')
    expect(await imports.notesAbout(path)).toBeUndefined()
  })
})

describe('writing notes about a person', () => {
  const CONTACT = 'Contacts/Address Book/Fastmail/Jane Doe.md'
  const card =
    '---\nname: Jane Doe\nemail_work: jane@example.com\nsource: fastmail\nuid: j1\n---\n\n# Jane Doe\n'

  async function seedContact(vault: typeof import('./vault')) {
    return vault.createNote('Contacts/Address Book/Fastmail', 'Jane Doe', card, () => 'Jane Doe')
  }

  it('makes one note of your own for them, beside your contacts, linked back', async () => {
    const { vault, imports } = await fresh()
    expect(await seedContact(vault)).toBe(CONTACT)
    const r = await imports.notesAbout(CONTACT)
    expect(r).toEqual({ path: 'Contacts/Notes on Jane Doe.md', created: true })
    expect(vault.getText(r!.path)).toContain('contact: "[[Jane Doe]]"')
    expect(vault.getEntry(r!.path)!.source).toBeUndefined()
    // First in the contact's mentions, which is where you'd look for it.
    expect(vault.backlinkMap.value.get(CONTACT)).toEqual([r!.path])
    // And its own name, so `[[Jane Doe]]` still means the contact.
    expect(vault.resolveLink('Jane Doe')).toBe(CONTACT)
  })

  it('opens the note you have rather than making another', async () => {
    const { vault, imports } = await fresh()
    await seedContact(vault)
    const first = await imports.notesAbout(CONTACT)
    const [again, twice] = await Promise.all([
      imports.notesAbout(CONTACT),
      imports.notesAbout(CONTACT),
    ])
    expect(again).toEqual({ path: first!.path, created: false })
    expect(twice).toEqual(again)
    expect(imports.notesForContact(CONTACT)).toEqual([first!.path])
  })

  it('is not fooled by a note that merely mentions them', async () => {
    const { vault, imports } = await fresh()
    await seedContact(vault)
    await vault.createNote('', 'Diary', 'Lunch with [[Jane Doe]].\n')
    expect((await imports.notesAbout(CONTACT))?.created).toBe(true)
  })

  it('is not offered for a note of your own', async () => {
    const { vault, imports } = await fresh()
    const mine = await vault.createNote('', 'Sam Ortiz', '# Sam\n')
    expect(await imports.notesAbout(mine)).toBeUndefined()
  })
})

describe('Write notes on a meeting whose time cannot be read', () => {
  /*
   * An import with no readable event used to be taken for a contact, so a
   * meeting with a broken `start:` got `Contacts/Notes on Standup (a41b).md`.
   */
  it('makes nothing, rather than taking it for a person', async () => {
    const { vault, imports } = await fresh()
    await seedMeeting(vault, meeting('next tuesday'))
    expect(vault.getEntry(MEETING)?.event).toBeUndefined()
    expect(await imports.notesAbout(MEETING)).toBeUndefined()
    expect(vault.notes.value.filter((n) => n.path.startsWith('Contacts/'))).toEqual([])
  })
})

describe('two files for one imported meeting', () => {
  /*
   * A trashed meeting restored beside the copy the importer wrote afresh, or a
   * sync conflict copy: both carry the same `source:` and `uid:`, and each was
   * a row on the agenda.
   */
  it('are one row on the agenda, the importer’s own', async () => {
    const { vault } = await fresh()
    await seedMeeting(vault)
    const restored = await vault.createNote('', 'Standup (a41b)', meeting(), () => 'Standup (a41b)')
    const rows = vault.eventsByDay.value.get(parseYmd('2026-09-21')!)?.map((e) => e.path)
    expect(rows).toEqual([MEETING])
    expect(vault.getEntry(restored)?.uid).toBe('a41b@fastmail.com')
  })
})
