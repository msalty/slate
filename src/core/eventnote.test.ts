/**
 * Making an event by hand.
 *
 * The name is the part worth pinning down. A note's title is its filename and
 * `titleIndex` hands a contested name to one note and leaves the other
 * unreachable by it, so two meetings called Standup on one day have to be two
 * names — and both have to stay linkable.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  defaultEventTimes,
  eventFolderFor,
  eventNoteName,
  keepDuration,
  localDateTime,
  parseLocal,
} from './eventnote'
import { parseYmd } from './util'
import { STARTER_TEMPLATES } from './starters'
import { expandTemplate } from './templates'

type Vault = typeof import('./vault')
type EventNote = typeof import('./eventnote')
type Templates = typeof import('./templates')

let seq = 0

async function fresh(): Promise<{ vault: Vault; ev: EventNote; templates: Templates }> {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = `slate-eventnote-${++seq}`
  const vault = await import('./vault')
  await vault.initVault()
  return { vault, ev: await import('./eventnote'), templates: await import('./templates') }
}

const DAY = parseYmd('2026-09-21')!
const DAY_AT_0930 = new Date(2026, 8, 21, 9, 30).getTime()

describe('where an event goes and what it is called', () => {
  it('files it under the year and month', () => {
    expect(eventFolderFor(DAY)).toBe('Calendar/2026/09')
  })

  it('is called what you called it, with nothing stamped on the front', () => {
    // A filename does not follow the frontmatter, so anything about *when* in
    // the name is a claim that stops being true the moment the event moves.
    expect(eventNoteName('Design review')).toBe('Design review')
    expect(eventNoteName('  Office closed  ')).toBe('Office closed')
  })

  it('opens on the chosen day at that half hour, for an hour', () => {
    const at = new Date(2026, 8, 21, 14, 7).getTime()
    expect(defaultEventTimes(DAY, at)).toEqual({
      start: '2026-09-21T14:30',
      end: '2026-09-21T15:30',
    })
  })

  it('reads its own field values back as instants', () => {
    expect(parseLocal('2026-09-21T14:30')).toBe(new Date(2026, 8, 21, 14, 30).getTime())
    expect(parseLocal('2026-09-21')).toBe(DAY)
    expect(parseLocal('not a date')).toBeUndefined()
    expect(localDateTime(new Date(2026, 8, 21, 9, 5).getTime())).toBe('2026-09-21T09:05')
  })
})

describe('the note it writes', () => {
  it('lands in the calendar folder under the year and month, named for itself', async () => {
    const { ev } = await fresh()
    const { path } = await ev.newEventNote('Design review', '2026-09-21T09:30', '2026-09-21T10:30')
    expect(path).toBe('Calendar/2026/09/Design review.md')
  })

  it('opens with a start and an end already written', async () => {
    const { vault, ev } = await fresh()
    const { path } = await ev.newEventNote('Design review', '2026-09-21T09:30', '2026-09-21T10:30')
    expect(vault.getRaw(path)?.text).toBe(
      '---\nstart: 2026-09-21T09:30\nend: 2026-09-21T10:30\n---\n\n# Design review\n\n',
    )
  })

  it('is on that day’s agenda the moment it exists', async () => {
    const { vault, ev } = await fresh()
    const { path } = await ev.newEventNote('Design review', '2026-09-21T09:30', '2026-09-21T10:30')
    expect(vault.eventsByDay.value.get(DAY)?.map((e) => e.path)).toEqual([path])
  })

  it('gives two of one name on one day the `2` every collision in the vault gets', async () => {
    const { vault, ev } = await fresh()
    const a = await ev.newEventNote('Standup', '2026-09-21T09:30', '2026-09-21T10:30')
    const b = await ev.newEventNote('Standup', '2026-09-21T14:00', '2026-09-21T15:00')
    expect(a.path).toBe('Calendar/2026/09/Standup.md')
    expect(b.path).toBe('Calendar/2026/09/Standup 2.md')
    expect(vault.resolveLink('Standup')).toBe(a.path)
    expect(vault.resolveLink('Standup 2')).toBe(b.path)
  })

  it('keeps the name it was given when the day or time is changed afterwards', async () => {
    const { vault, ev } = await fresh()
    const { path } = await ev.newEventNote('Design review', '2026-09-21T09:30', '2026-09-21T10:30')
    await vault.saveNote(
      path,
      '---\nstart: 2026-10-05T14:00\nend: 2026-10-05T15:00\n---\n\n# Design review\n',
    )
    /*
     * The file does not rename itself — a rename would break every `[[link]]`
     * pointing at it — and it does not need to, because nothing about when it
     * happens was ever written into the name. It simply moves.
     */
    expect(vault.resolveLink('Design review')).toBe(path)
    expect(vault.eventsByDay.value.get(DAY)).toBeUndefined()
    expect(vault.eventsByDay.value.get(parseYmd('2026-10-05')!)?.length).toBe(1)
    expect(vault.getEntry(path)?.calendarDate).toBe(parseYmd('2026-10-05'))
  })

  it('takes a template from Calendar/, not only from the month it landed in', async () => {
    const { vault, ev, templates } = await fresh()
    await vault.createNote('Templates', 'Meeting', '# {{title}}\n\n## Attendees\n\n## Notes\n')
    await templates.setFolderTemplate('Calendar', 'Templates/Meeting.md')
    const { path } = await ev.newEventNote('Design review', '2026-09-21T09:30', '2026-09-21T10:30')
    const text = vault.getRaw(path)?.text ?? ''
    expect(text).toContain('## Attendees')
    expect(text).toContain('# Design review')
  })

  it('keeps the start on a template that brings frontmatter of its own', async () => {
    const { vault, ev, templates } = await fresh()
    await vault.createNote(
      'Templates',
      'Meeting',
      '---\nattendees: []\n---\n\n# {{title}}\n\n## Notes\n',
    )
    await templates.setFolderTemplate('Calendar', 'Templates/Meeting.md')
    const { path } = await ev.newEventNote('Design review', '2026-09-21T09:30', '2026-09-21T10:30')
    const text = vault.getRaw(path)?.text ?? ''
    // One block, not two: a second `---` fence would make the template's keys
    // body text and the event would have no start at all.
    expect(text.match(/^---$/gm)?.length).toBe(2)
    expect(text).toContain('start: 2026-09-21T09:30')
    expect(text).toContain('attendees: []')
    expect(vault.getEntry(path)?.event?.start).toBe(new Date(2026, 8, 21, 9, 30).getTime())
  })

  it('fills {{time}} with the time the event starts, not with midnight', async () => {
    const { vault, ev, templates } = await fresh()
    await vault.createNote('Templates', 'Meeting', '# {{title}}\n\nAt {{time}} on {{date}}\n')
    await templates.setFolderTemplate('Calendar', 'Templates/Meeting.md')
    const { path } = await ev.newEventNote('Design review', '2026-09-21T14:30', '2026-09-21T15:30')
    expect(vault.getRaw(path)?.text).toContain('At 14:30 on 2026-09-21')
  })

  it('leaves a template’s own start alone rather than writing a second one', async () => {
    const { vault, ev, templates } = await fresh()
    await vault.createNote(
      'Templates',
      'Meeting',
      '---\nstart: {{date}}T{{time}}\nend:\ntags: [meeting]\n---\n\n# {{title}}\n',
    )
    await templates.setFolderTemplate('Calendar', 'Templates/Meeting.md')
    const { path } = await ev.newEventNote('Design review', '2026-09-21T14:30', '2026-09-21T15:30')
    const text = vault.getRaw(path)?.text ?? ''
    expect(text.match(/^start:/gm)?.length).toBe(1)
    // An empty `end:` is the template saying "fill this in", not forgetting to.
    expect(text.match(/^end:/gm)?.length).toBe(1)
    expect(text).toContain('start: 2026-09-21T14:30')
    const e = vault.getEntry(path)?.event
    expect(e?.start).toBe(new Date(2026, 8, 21, 14, 30).getTime())
    expect(e!.end - e!.start).toBe(60 * 60 * 1000)
  })

  it('still supplies an end when the template wrote only a start', async () => {
    const { vault, ev, templates } = await fresh()
    await vault.createNote('Templates', 'M', '---\nstart: {{date}}T{{time}}\n---\n\n# {{title}}\n')
    await templates.setFolderTemplate('Calendar', 'Templates/M.md')
    const { path } = await ev.newEventNote('Design review', '2026-09-21T14:30', '2026-09-21T15:30')
    expect(vault.getRaw(path)?.text).toContain('end: 2026-09-21T15:30')
  })

  it('lands the caret where the template asked, past the frontmatter', async () => {
    const { vault, ev, templates } = await fresh()
    await vault.createNote('Templates', 'Meeting', '# {{title}}\n\n{{cursor}}\n')
    await templates.setFolderTemplate('Calendar', 'Templates/Meeting.md')
    const { path, caret } = await ev.newEventNote('Design review', '2026-09-21T09:30', '2026-09-21T10:30')
    const text = vault.getRaw(path)?.text ?? ''
    expect(caret).toBeGreaterThan(text.indexOf('# Design review'))
  })
})

/**
 * A meeting note is an event now, so it has to behave like one wherever it is
 * written — including outside `Calendar/`, where nothing in the filename says
 * which day it belongs to.
 */
describe('a note made from the Meeting starter', () => {
  it('lands on the agenda for the day it happened, not the day it was typed', async () => {
    const { vault } = await fresh()
    const meeting = STARTER_TEMPLATES.find((t) => t.name === 'Meeting')!
    const { text } = expandTemplate(meeting.text, { title: 'Kickoff', when: DAY_AT_0930 })
    const path = await vault.createNote('Work', 'Kickoff', text)
    expect(vault.eventsByDay.value.get(DAY)?.map((e) => e.path)).toEqual([path])
    // And the calendar marks the same day, off the event rather than the file.
    expect(vault.getEntry(path)?.calendarDate).toBe(DAY)
  })

  it('wires an attendee written as a link into that person’s backlinks', async () => {
    const { vault } = await fresh()
    await vault.createNote('', 'Ana Ruiz', '# Ana\n')
    await vault.createNote(
      'Work',
      'Kickoff',
      '---\nstart: 2026-09-21T09:30\nattendees: ["[[Ana Ruiz]]", Bo]\n---\n\n# Kickoff\n',
    )
    expect(vault.backlinkMap.value.get('Ana Ruiz.md')).toEqual(['Work/Kickoff.md'])
  })
})

/**
 * Moving the start takes the end with it.
 *
 * Without this a two-field dialog is worse than a one-field one: nudging a
 * meeting an hour later would mean re-typing when it finishes, every time.
 */
describe('an end that follows its start', () => {
  it('keeps the length the event had', () => {
    expect(keepDuration('2026-09-21T09:00', '2026-09-21T10:30', '2026-09-21T14:00')).toBe(
      '2026-09-21T15:30',
    )
  })

  it('carries it over midnight rather than wrapping', () => {
    expect(keepDuration('2026-09-21T09:00', '2026-09-21T11:00', '2026-09-21T23:00')).toBe(
      '2026-09-22T01:00',
    )
  })

  it('gives an hour to an end that had no length worth keeping', () => {
    expect(keepDuration('2026-09-21T09:00', '2026-09-21T08:00', '2026-09-21T14:00')).toBe(
      '2026-09-21T15:00',
    )
    expect(keepDuration('2026-09-21T09:00', '', '2026-09-21T14:00')).toBe('2026-09-21T15:00')
  })

  it('leaves the end alone when the start is not a time at all', () => {
    expect(keepDuration('2026-09-21T09:00', '2026-09-21T10:00', 'rubbish')).toBe(
      '2026-09-21T10:00',
    )
  })
})

/** What the dialog hands over goes into the file exactly as it is. */
describe('the times the dialog chose', () => {
  it('are written as given, and files the note in the start’s own month', async () => {
    const { vault, ev } = await fresh()
    const { path } = await ev.newEventNote('Budget call', '2026-11-03T16:45', '2026-11-03T17:15')
    expect(path).toBe('Calendar/2026/11/Budget call.md')
    const text = vault.getRaw(path)?.text ?? ''
    expect(text).toContain('start: 2026-11-03T16:45')
    expect(text).toContain('end: 2026-11-03T17:15')
    expect(vault.getEntry(path)?.event?.start).toBe(new Date(2026, 10, 3, 16, 45).getTime())
  })

  it('make an all-day event from two bare dates', async () => {
    const { vault, ev } = await fresh()
    const { path } = await ev.newEventNote('Office closed', '2026-09-21', '2026-09-22')
    const e = vault.getEntry(path)?.event
    expect(e?.allDay).toBe(true)
    expect(e?.end).toBe(parseYmd('2026-09-22'))
    // Inclusive, so it is on both days rather than on one and a half.
    expect(vault.eventsByDay.value.get(DAY)?.length).toBe(1)
    expect(vault.eventsByDay.value.get(parseYmd('2026-09-22')!)?.length).toBe(1)
  })

  it('overwrite a template’s own start and end rather than losing to them', async () => {
    const { vault, ev, templates } = await fresh()
    await vault.createNote(
      'Templates',
      'Meeting',
      '---\nstart: {{date}}T{{time}}\nend:\ntags: [meeting]\n---\n\n# {{title}}\n',
    )
    await templates.setFolderTemplate('Calendar', 'Templates/Meeting.md')
    const { path } = await ev.newEventNote('Design review', '2026-09-21T14:30', '2026-09-21T16:00')
    const text = vault.getRaw(path)?.text ?? ''
    expect(text.match(/^start:/gm)?.length).toBe(1)
    expect(text.match(/^end:/gm)?.length).toBe(1)
    // The dialog asked, so the dialog's answer wins — a template cannot know it.
    expect(text).toContain('start: 2026-09-21T14:30')
    expect(text).toContain('end: 2026-09-21T16:00')
    expect(text).toContain('tags: [meeting]')
  })
})

/**
 * What time a new event opens on.
 *
 * The suggestion is the next round half hour, and the rollover is the whole
 * reason it is carried as an instant: at 23:45 the next half hour is midnight
 * *tomorrow*, and rounding to "00:00" and hanging it on today opened every
 * late-night event twenty-four hours in the past.
 */
describe('the time a new event opens on', () => {
  const at = (h: number, mi: number, s = 0) => new Date(2026, 8, 21, h, mi, s).getTime()

  it('rolls into tomorrow rather than back to this morning', () => {
    expect(defaultEventTimes(DAY, at(23, 45))).toEqual({
      start: '2026-09-22T00:00',
      end: '2026-09-22T01:00',
    })
  })

  it('counts the seconds, so half past already gone rounds to the hour', () => {
    expect(defaultEventTimes(DAY, at(14, 30, 15)).start).toBe('2026-09-21T15:00')
    // And exactly on the half hour is not already gone.
    expect(defaultEventTimes(DAY, at(14, 30)).start).toBe('2026-09-21T14:30')
  })

  it('keeps a day you chose, and only puts the clock time on it', () => {
    // The rollover is about "now". A day picked out of the calendar is not now.
    expect(defaultEventTimes(parseYmd('2026-10-05')!, at(23, 45))).toEqual({
      start: '2026-10-05T00:00',
      end: '2026-10-05T01:00',
    })
  })

  it('crosses a month, and a year, without landing in the wrong one', () => {
    const nye = new Date(2026, 11, 31, 23, 45).getTime()
    expect(defaultEventTimes(new Date(2026, 11, 31).getTime(), nye).start).toBe('2027-01-01T00:00')
  })
})
