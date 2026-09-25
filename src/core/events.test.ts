/**
 * What a note says about when it happens, and which day it lands on.
 *
 * Two things here are easy to get wrong and expensive to notice. An all-day
 * `end:` is *inclusive* where iCalendar's is exclusive, so a one-day event
 * copied through literally draws itself two days long. And an evening that
 * finishes at midnight belongs to the evening, not to the morning after it.
 */

import { describe, expect, it, vi } from 'vitest'
import { eventFor } from './markdown'
import { parseYmd, startOfDay } from './util'

type Vault = typeof import('./vault')

let seq = 0

async function fresh(): Promise<Vault> {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = `slate-events-${++seq}`
  const vault = await import('./vault')
  await vault.initVault()
  return vault
}

const DAY = parseYmd('2026-09-21')!
const at = (h: number, mi = 0) => new Date(2026, 8, 21, h, mi).getTime()
const fm = (...lines: string[]) => `---\n${lines.join('\n')}\n---\n\nBody.\n`

describe('reading an event off the frontmatter', () => {
  it('is not an event without a start', () => {
    expect(eventFor({ end: '2026-09-21T10:00', location: 'Room 4B' })).toBeUndefined()
  })

  it('is not an event when the start is not a date', () => {
    expect(eventFor({ start: 'tomorrow' })).toBeUndefined()
    expect(eventFor({ start: '2026-13-01' })).toBeUndefined()
    expect(eventFor({ start: '2026-09-21T25:00' })).toBeUndefined()
    expect(eventFor({ start: true })).toBeUndefined()
  })

  it('refuses a date that does not exist rather than rolling it over', () => {
    // `Date` takes the 31st of September and hands back the 1st of October, so
    // without a check a mistyped day is not an error, it is the wrong day.
    expect(eventFor({ start: '2026-09-31' })).toBeUndefined()
    expect(eventFor({ start: '2026-02-30T09:00' })).toBeUndefined()
    // And a real leap day still works.
    expect(eventFor({ start: '2028-02-29' })?.start).toBe(new Date(2028, 1, 29).getTime())
  })

  it('reads a bare date as all day', () => {
    expect(eventFor({ start: '2026-09-21' })).toEqual({ start: DAY, end: DAY, allDay: true })
  })

  it('reads a time as a wall clock in the device’s own zone', () => {
    expect(eventFor({ start: '2026-09-21T09:30', end: '2026-09-21T10:00' })).toEqual({
      start: at(9, 30),
      end: at(10, 0),
      allDay: false,
    })
  })

  it('accepts seconds, and a space where the T should be', () => {
    expect(eventFor({ start: '2026-09-21T09:30:15' })?.start).toBe(
      new Date(2026, 8, 21, 9, 30, 15).getTime(),
    )
    expect(eventFor({ start: '2026-09-21 09:30' })?.start).toBe(at(9, 30))
  })

  it('gives an event with no end an hour', () => {
    const e = eventFor({ start: '2026-09-21T09:30' })!
    expect(e.end - e.start).toBe(60 * 60 * 1000)
  })

  it('gives an all-day event with no end that one day', () => {
    expect(eventFor({ start: '2026-09-21' })).toMatchObject({ start: DAY, end: DAY })
  })

  it('keeps an inclusive all-day end as the last day, not the day after', () => {
    const e = eventFor({ start: '2026-09-21', end: '2026-09-23' })!
    expect(e.end).toBe(parseYmd('2026-09-23'))
  })

  it('replaces an end that is before its start, or written in the other shape', () => {
    // A day cannot say when an appointment finished, and a time cannot close
    // an event filed as a whole day.
    expect(eventFor({ start: '2026-09-21T09:30', end: '2026-09-21T09:00' })?.end).toBe(at(10, 30))
    expect(eventFor({ start: '2026-09-21T09:30', end: '2026-09-22' })?.end).toBe(at(10, 30))
    expect(eventFor({ start: '2026-09-21', end: '2026-09-21T10:00' })?.end).toBe(DAY)
  })

  it('reads a zoned time as that zone’s wall clock', () => {
    // 14:00 in New York on a September day is 18:00 UTC.
    const e = eventFor({ start: '2026-09-21T14:00', tz: 'America/New_York' })!
    expect(new Date(e.start).toISOString()).toBe('2026-09-21T18:00:00.000Z')
    expect(e.tz).toBe('America/New_York')
  })

  it('gets the offset right on the far side of a daylight-saving change', () => {
    // New York leaves DST on 2026-11-01. Same wall clock, different offset.
    const summer = eventFor({ start: '2026-10-25T12:00', tz: 'America/New_York' })!
    const winter = eventFor({ start: '2026-11-08T12:00', tz: 'America/New_York' })!
    expect(new Date(summer.start).toISOString()).toBe('2026-10-25T16:00:00.000Z')
    expect(new Date(winter.start).toISOString()).toBe('2026-11-08T17:00:00.000Z')
  })

  it('ignores a zone on an all-day event', () => {
    // "The 21st" is the 21st wherever the calendar came from; converting it
    // would slide it onto the 20th for anybody far enough west.
    const e = eventFor({ start: '2026-09-21', tz: 'Asia/Tokyo' })!
    expect(e).toEqual({ start: DAY, end: DAY, allDay: true })
  })

  it('ignores a zone it cannot use rather than refusing the event', () => {
    const e = eventFor({ start: '2026-09-21T09:30', tz: 'Mars/Olympus' })!
    expect(e.start).toBe(at(9, 30))
    expect(e.tz).toBeUndefined()
  })

  it('but keeps the name it could not use, so the line is not silently dead', () => {
    /*
     * The worst shape of wrong: `Amercia/New_York` resolves to exactly the same
     * instant as no zone at all, so a typo and a correct file are identical on
     * screen while the event is hours out. Held on to for the row to show.
     */
    const typo = eventFor({ start: '2026-09-21T09:30', tz: 'Amercia/New_York' })!
    const none = eventFor({ start: '2026-09-21T09:30' })!
    expect(typo.start).toBe(none.start)
    expect(typo.badZone).toBe('Amercia/New_York')
    expect(none.badZone).toBeUndefined()
    // And a zone that works leaves no complaint behind.
    expect(eventFor({ start: '2026-09-21T09:30', tz: 'Asia/Tokyo' })!.badZone).toBeUndefined()
  })
})

describe('the agenda', () => {
  it('files an event under its day', async () => {
    const vault = await fresh()
    await vault.createNote('', 'Design review', fm('start: 2026-09-21T09:30'))
    expect(vault.eventsByDay.value.get(DAY)?.map((e) => e.title)).toEqual(['Design review'])
  })

  it('leaves a note with no start off it', async () => {
    const vault = await fresh()
    await vault.createNote('', 'Ordinary', '# Just a note\n')
    expect(vault.eventsByDay.value.size).toBe(0)
  })

  it('puts a multi-day event on every day it covers', async () => {
    const vault = await fresh()
    await vault.createNote('', 'Conference', fm('start: 2026-09-21', 'end: 2026-09-23'))
    const days = [...vault.eventsByDay.value.keys()].sort()
    expect(days).toEqual([parseYmd('2026-09-21'), parseYmd('2026-09-22'), parseYmd('2026-09-23')])
  })

  it('ends an evening at midnight on the evening, not the morning after', async () => {
    const vault = await fresh()
    await vault.createNote('', 'Late', fm('start: 2026-09-21T21:00', 'end: 2026-09-22T00:00'))
    expect([...vault.eventsByDay.value.keys()]).toEqual([DAY])
  })

  it('but carries an event that really does cross midnight into the next day', async () => {
    const vault = await fresh()
    await vault.createNote('', 'Flight', fm('start: 2026-09-21T23:00', 'end: 2026-09-22T02:00'))
    expect([...vault.eventsByDay.value.keys()].sort()).toEqual([DAY, parseYmd('2026-09-22')])
  })

  it('reads a day all-day first, then by the clock', async () => {
    const vault = await fresh()
    await vault.createNote('', 'Standup', fm('start: 2026-09-21T09:30'))
    await vault.createNote('', 'Retro', fm('start: 2026-09-21T09:00'))
    await vault.createNote('', 'Public holiday', fm('start: 2026-09-21'))
    expect(vault.eventsByDay.value.get(DAY)?.map((e) => e.title)).toEqual([
      'Public holiday',
      'Retro',
      'Standup',
    ])
  })

  it('keeps a template off the agenda', async () => {
    const vault = await fresh()
    await vault.createNote('Templates', 'Meeting', fm('start: 2026-09-21T09:30'))
    expect(vault.eventsByDay.value.size).toBe(0)
  })

  it('refuses to spread one mistyped year across four hundred thousand days', async () => {
    const vault = await fresh()
    await vault.createNote('', 'Typo', fm('start: 2026-09-21', 'end: 3026-09-21'))
    expect(vault.eventsByDay.value.size).toBe(400)
  })

  it('follows the note when its frontmatter is edited', async () => {
    const vault = await fresh()
    const path = await vault.createNote('', 'Moves', fm('start: 2026-09-21T09:30'))
    await vault.saveNote(path, fm('start: 2026-09-22T09:30'))
    expect(vault.eventsByDay.value.get(DAY)).toBeUndefined()
    expect(vault.eventsByDay.value.get(parseYmd('2026-09-22')!)?.length).toBe(1)
  })

  it('files a zoned event on the day it falls on where you are', async () => {
    const vault = await fresh()
    // Late evening in Tokyo is the same calendar day only well to the east.
    await vault.createNote('', 'Tokyo call', fm('start: 2026-09-22T09:00', 'tz: Asia/Tokyo'))
    const [day] = [...vault.eventsByDay.value.keys()]
    expect(day).toBe(startOfDay(new Date('2026-09-22T00:00:00.000Z').getTime()))
  })
})

/**
 * The two days a year a wall clock does not name one instant.
 *
 * An hour is skipped in spring, so 02:30 never happens; an hour is repeated in
 * autumn, so 01:30 happens twice. The rule for both is the one every calendar
 * has settled on — a skipped time moves forward by the gap, a repeated one
 * means the first — and the test that matters is that naming your *own* zone
 * cannot change an event, since it is the same statement either way.
 */
describe('daylight saving', () => {
  const NY = 'America/New_York'
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone

  it('moves a time the clocks skipped forward by the gap', () => {
    // 02:30 on 2026-03-08 does not exist in New York: 02:00 EST became 03:00 EDT.
    const e = eventFor({ start: '2026-03-08T02:30', tz: NY })!
    expect(new Date(e.start).toISOString()).toBe('2026-03-08T07:30:00.000Z')
  })

  it('takes the first of an hour the clocks repeated', () => {
    // 01:30 on 2026-11-01 happens twice; the earlier one is still EDT.
    const e = eventFor({ start: '2026-11-01T01:30', tz: NY })!
    expect(new Date(e.start).toISOString()).toBe('2026-11-01T05:30:00.000Z')
  })

  it('answers the same whether or not the reader’s own zone is named', () => {
    /*
     * The case this is really for. Writing `tz:` with the zone you are already
     * in says nothing new, so it must not move anything — and an earlier
     * version moved a skipped hour by ninety minutes when you did.
     */
    for (const t of [
      '2026-03-08T01:30',
      '2026-03-08T02:30',
      '2026-03-08T03:30',
      '2026-11-01T00:30',
      '2026-11-01T01:30',
      '2026-11-01T02:30',
      '2026-06-01T09:00',
    ]) {
      expect(eventFor({ start: t, tz: here })!.start).toBe(eventFor({ start: t })!.start)
    }
  })

  it('keeps a whole hour a whole hour across the transition', () => {
    const e = eventFor({ start: '2026-03-08T01:30', end: '2026-03-08T03:30', tz: NY })!
    // 01:30 EST to 03:30 EDT is one hour of clock time either side of the gap.
    expect(e.end - e.start).toBe(60 * 60 * 1000)
  })

  it('and gets an ordinary day right, which is the other 363', () => {
    const e = eventFor({ start: '2026-06-01T09:00', tz: NY })!
    expect(new Date(e.start).toISOString()).toBe('2026-06-01T13:00:00.000Z')
  })
})
