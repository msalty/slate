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
  instantOf,
  keepDuration,
  knownZones,
  setEventStart,
  localDateTime,
  wallPlusHour,
} from './eventnote'
import { parseYmd, roundUpToHalfHour } from './util'
import { eventFor, parseFrontmatter } from './markdown'
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

  it('reads its own field values back as instants, in the zone chosen', () => {
    expect(instantOf('2026-09-21T14:30')).toBe(new Date(2026, 8, 21, 14, 30).getTime())
    expect(instantOf('2026-09-21')).toBe(DAY)
    expect(instantOf('not a date')).toBeUndefined()
    expect(new Date(instantOf('2026-09-21T14:00', 'America/New_York')!).toISOString()).toBe(
      '2026-09-21T18:00:00.000Z',
    )
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

/**
 * The zone the dialog collected, and the one a template happens to carry.
 *
 * The dialog's fields are a local wall clock, so a zone arriving from anywhere
 * else reinterprets what was just typed. Choosing the first of October at half
 * past midnight in New York, with a Tokyo template on the folder, used to make
 * an event on the thirtieth of September at half eleven in the morning — filed
 * in a folder that still said October.
 */
describe('the zone on a new event', () => {
  const tokyoTemplate = async (v: Awaited<ReturnType<typeof fresh>>) => {
    await v.vault.createNote('Templates', 'M', '---\ntz: Asia/Tokyo\n---\n\n# {{title}}\n')
    await v.templates.setFolderTemplate('Calendar', 'Templates/M.md')
  }

  it('writes none at all by default, which is a floating time', async () => {
    const { vault, ev } = await fresh()
    const { path } = await ev.newEventNote('Standup', '2026-09-21T09:30', '2026-09-21T10:00')
    expect(vault.getRaw(path)?.text).not.toContain('tz:')
    expect(vault.getEntry(path)?.event?.tz).toBeUndefined()
  })

  it('writes the one it was given', async () => {
    const { vault, ev } = await fresh()
    const { path } = await ev.newEventNote(
      'Call',
      '2026-09-21T09:30',
      '2026-09-21T10:00',
      'Asia/Tokyo',
    )
    expect(vault.getRaw(path)?.text).toContain('tz: Asia/Tokyo')
    expect(vault.getEntry(path)?.event?.tz).toBe('Asia/Tokyo')
  })

  it('takes a template’s zone off when the dialog did not ask for one', async () => {
    const v = await fresh()
    await tokyoTemplate(v)
    const { path } = await v.ev.newEventNote('Kickoff', '2026-10-01T00:30', '2026-10-01T01:30')
    expect(v.vault.getRaw(path)?.text).not.toContain('tz:')
    // The day the dialog said, in the month the dialog said.
    expect(path).toBe('Calendar/2026/10/Kickoff.md')
    expect(v.vault.getEntry(path)?.calendarDate).toBe(parseYmd('2026-10-01'))
  })

  it('and the folder agrees with the index when it does ask for one', async () => {
    const v = await fresh()
    const { path } = await v.ev.newEventNote(
      'Kickoff',
      '2026-10-01T00:30',
      '2026-10-01T01:30',
      'Asia/Tokyo',
    )
    const filed = v.vault.getEntry(path)!.calendarDate
    // Whatever day that lands on locally, the folder and the calendar say the
    // same one — they used to disagree, the folder reading it as local time.
    expect(v.ev.eventFolderFor(filed)).toBe(dirnameOf(path))
  })

  it('offers a template’s zone to the dialog rather than applying it', async () => {
    const v = await fresh()
    await tokyoTemplate(v)
    expect(v.ev.templateZoneFor(DAY)).toBe('Asia/Tokyo')
  })

  it('and offers nothing when the template has no opinion', async () => {
    const v = await fresh()
    await v.vault.createNote('Templates', 'M', '# {{title}}\n')
    await v.templates.setFolderTemplate('Calendar', 'Templates/M.md')
    expect(v.ev.templateZoneFor(DAY)).toBeUndefined()
  })
})

const dirnameOf = (p: string) => p.slice(0, p.lastIndexOf('/'))

/**
 * A field holds a wall clock, and a wall clock is only a moment once you say
 * whose. Everything the dialog does with one — is the end after the start, how
 * long is it, which folder does it land in — has to ask in the zone that was
 * chosen, or it answers about a different event than the one being saved.
 */
describe('the zone the dialog is working in', () => {
  it('judges an end by the chosen clock, not the device’s', () => {
    /*
     * 02:30 to 03:00 in Tokyo is an ordinary half hour. Read as New York on the
     * morning its clocks go forward, the start moves to 03:30 and the end looks
     * like it comes first — so a valid pair was being replaced by an hour
     * nobody asked for.
     */
    const from = instantOf('2026-03-08T02:30', 'Asia/Tokyo')!
    const to = instantOf('2026-03-08T03:00', 'Asia/Tokyo')!
    expect(to).toBeGreaterThan(from)
    expect(to - from).toBe(30 * 60 * 1000)
  })

  it('keeps a duration on the chosen clock face, not the device’s', () => {
    expect(keepDuration('2026-06-01T09:00', '2026-06-01T10:30', '2026-06-01T14:00', 'Asia/Tokyo')).toBe(
      '2026-06-01T15:30',
    )
  })

  it('gives an hour on the clock to an end with no length worth keeping', () => {
    expect(wallPlusHour('2026-03-08T02:30')).toBe('2026-03-08T03:30')
    expect(wallPlusHour('2026-09-21T23:30')).toBe('2026-09-22T00:30')
  })

  it('files where it said it would, whatever zone was picked', async () => {
    const { ev } = await fresh()
    // Midnight-and-a-half on 1 October in Tokyo is 30 September almost
    // everywhere west of it. The preview and the folder must agree, and both
    // must agree with what the calendar files it under.
    const at = instantOf('2026-10-01T00:30', 'Asia/Tokyo')!
    const { path } = await ev.newEventNote('Kickoff', '2026-10-01T00:30', '2026-10-01T01:30', 'Asia/Tokyo')
    expect(path.startsWith(`${ev.eventFolderFor(at)}/`)).toBe(true)
  })

  it('offers a zone list that holds every zone it might have to show', () => {
    // `supportedValuesOf` lists the canonical zones, and a name can be valid
    // without being on it — a select that cannot show its own value is a
    // control with nothing selected saving something anyway.
    expect(knownZones()).toContain('UTC')
    expect(knownZones('Asia/Calcutta')).toContain('Asia/Calcutta')
    expect(knownZones(Intl.DateTimeFormat().resolvedOptions().timeZone)).toContain(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    )
    // And a name that is not a zone is not smuggled in by asking for it.
    expect(knownZones('Mars/Olympus')).not.toContain('Mars/Olympus')
  })
})

/** The suggestion has to be a moment still to come once it is a string. */
describe('the suggested time on a fall-back morning', () => {
  it('never names an instant that has already gone', () => {
    // The second 01:15 in New York. Its wall clock rounds to "01:30", which
    // reads back as the *first* 01:30 — forty-five minutes earlier.
    const secondOhOneFifteen = Date.UTC(2026, 10, 1, 6, 15)
    expect(roundUpToHalfHour(secondOhOneFifteen)).toBeGreaterThanOrEqual(secondOhOneFifteen)
    const { start } = defaultEventTimes(parseYmd('2026-11-01')!, secondOhOneFifteen)
    expect(instantOf(start)!).toBeGreaterThanOrEqual(secondOhOneFifteen)
  })
})

/**
 * Two ways a correction can be worse than the thing it corrects.
 *
 * Both of these were introduced by earlier fixes in this file, which is the
 * shape worth remembering: a rule written for one case ("never suggest a time
 * that has gone", "keep the length") applied without asking whether the case
 * was in front of it.
 */
describe('corrections that must know when to stop', () => {
  it('leaves a day you picked on the day you picked', () => {
    /*
     * At ten past eleven at night on the twenty-first, asking for the twentieth
     * is asking for a day that is *supposed* to be in the past. Checking it
     * against now walked the suggestion off that day and onto the next one.
     */
    const now = new Date(2026, 8, 21, 23, 10).getTime()
    expect(defaultEventTimes(parseYmd('2026-09-20')!, now).start).toBe('2026-09-20T23:30')
    expect(defaultEventTimes(parseYmd('2026-09-25')!, now).start).toBe('2026-09-25T23:30')
    // Today still rolls past midnight, which is what the check was for.
    expect(defaultEventTimes(parseYmd('2026-09-21')!, now).start).toBe('2026-09-21T23:30')
  })

  it('and still will not suggest a moment gone, on today', () => {
    const second = Date.UTC(2026, 10, 1, 6, 15)
    const { start } = defaultEventTimes(parseYmd('2026-11-01')!, second)
    expect(instantOf(start)!).toBeGreaterThanOrEqual(second)
  })

  it('never lets an event collapse to nothing when it is moved', () => {
    /*
     * An hour a year happens twice and this format has one spelling for both.
     * An hour-long event moved to 01:30 on that morning ends at the *second*
     * 01:30 — which writes out as "01:30", reads back as the first, and leaves
     * an event starting and finishing at the same moment.
     */
    const NY = 'America/New_York'
    const end = keepDuration('2026-10-31T01:30', '2026-10-31T02:30', '2026-11-01T01:30', NY)
    expect(end).not.toBe('2026-11-01T01:30')
    expect(instantOf(end, NY)!).toBeGreaterThan(instantOf('2026-11-01T01:30', NY)!)
    // The length is kept on the clock face, which the file can always say.
    expect(end).toBe('2026-11-01T02:30')
  })

  it('keeps the exact instant wherever the clock face can still name it', () => {
    // Into the skipped hour, where the representable spelling is the later one.
    const NY = 'America/New_York'
    expect(keepDuration('2026-06-01T01:00', '2026-06-01T02:00', '2026-03-08T01:30', NY)).toBe(
      '2026-03-08T03:30',
    )
    // And an ordinary move, which is every other day of the year.
    expect(keepDuration('2026-06-01T09:00', '2026-06-01T10:30', '2026-06-02T14:00', NY)).toBe(
      '2026-06-02T15:30',
    )
  })
})

/**
 * Moving an event's start from the properties form.
 *
 * The form edits one key at a time and keeps everything else byte for byte,
 * which is right for a form over somebody's frontmatter. This pair is the
 * deliberate exception, because leaving the end behind does not leave it
 * behind: `eventFor` replaces an end that precedes its start with an hour, so
 * a two-hour meeting dragged to the afternoon quietly became a one-hour one.
 */
describe('moving a start', () => {
  const note = (...lines: string[]) => `---\n${lines.join('\n')}\n---\n\n# Meeting\n`
  const lengthOf = (text: string) => {
    const e = eventFor(parseFrontmatter(text).data)!
    return (e.end - e.start) / 60_000
  }

  it('takes the end with it, keeping the length', () => {
    const before = note('start: 2026-09-21T09:00', 'end: 2026-09-21T11:00')
    expect(lengthOf(before)).toBe(120)
    const after = setEventStart(before, '2026-09-21T14:00')
    expect(after).toContain('start: 2026-09-21T14:00')
    expect(after).toContain('end: 2026-09-21T16:00')
    expect(lengthOf(after)).toBe(120)
  })

  it('in the zone the note names, not the device’s', () => {
    const before = note('start: 2026-09-21T09:00', 'end: 2026-09-21T10:30', 'tz: Asia/Tokyo')
    expect(setEventStart(before, '2026-09-21T14:00')).toContain('end: 2026-09-21T15:30')
  })

  it('leaves an empty end alone, which already means an hour', () => {
    const before = note('start: 2026-09-21T09:00', 'end:')
    const after = setEventStart(before, '2026-09-21T14:00')
    expect(after).toContain('\nend:\n')
    expect(lengthOf(after)).toBe(60)
  })

  it('and leaves a note that is not an event as one key edited', () => {
    const before = note('start: chapter three')
    expect(setEventStart(before, 'chapter four')).toBe(note('start: chapter four'))
  })

  it('touching nothing else in the file', () => {
    const before = `---\n# why this is here\nstart: 2026-09-21T09:00\nend: 2026-09-21T11:00\ntags: [meeting]\n---\n\nBody.\n`
    const after = setEventStart(before, '2026-09-21T14:00')
    expect(after).toContain('# why this is here')
    expect(after).toContain('tags: [meeting]')
    expect(after).toContain('Body.')
  })
})
