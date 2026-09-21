/**
 * How an event reads on a day.
 *
 * The rows answer "when, today", so the cases worth pinning are the ones where
 * today is not the whole of the event: a conference that started on Monday has
 * no useful start time to show on Wednesday.
 */

import { describe, expect, it } from 'vitest'
import { eventIsPast, eventTimeLabel, eventZoneLabel } from './agenda'
import { eventFor } from './markdown'
import { parseYmd } from './util'

const DAY = parseYmd('2026-09-21')!
const ev = (...lines: string[]) => eventFor(Object.fromEntries(lines.map((l) => {
  const i = l.indexOf(': ')
  return [l.slice(0, i), l.slice(i + 2)]
})))!

describe('the time on a row', () => {
  it('says so for an all-day event rather than leaving the column empty', () => {
    expect(eventTimeLabel(ev('start: 2026-09-21'), DAY)).toBe('all day')
  })

  it('gives the start time for an event that begins today', () => {
    const label = eventTimeLabel(ev('start: 2026-09-21T09:30'), DAY)
    expect(label).toMatch(/09.30|9.30/)
  })

  it('says when something that started earlier finishes', () => {
    const label = eventTimeLabel(ev('start: 2026-09-20T23:00', 'end: 2026-09-21T02:00'), DAY)
    expect(label).toMatch(/^until /)
  })

  it('says "all day" for a timed event that covers the whole of today', () => {
    expect(eventTimeLabel(ev('start: 2026-09-20T09:00', 'end: 2026-09-22T17:00'), DAY)).toBe(
      'all day',
    )
  })

  it('ends an evening at midnight on the evening', () => {
    // Not "all day" on the 21st, and not on the 22nd at all — the same rule
    // `eventsByDay` files by.
    const e = ev('start: 2026-09-21T21:00', 'end: 2026-09-22T00:00')
    expect(eventTimeLabel(e, DAY)).toMatch(/21.00|9.00/)
  })
})

/*
 * Whether a zone is worth naming depends on where the *reader* is, so these
 * cannot name one and hope: a test that says "New York is elsewhere" fails for
 * anybody in New York. They ask the runner where it is and pick accordingly.
 */
const HERE = Intl.DateTimeFormat().resolvedOptions().timeZone
const ELSEWHERE =
  ['America/New_York', 'Asia/Tokyo', 'Europe/Berlin', 'UTC'].find(
    (tz) => eventZoneLabel(ev('start: 2026-09-21T14:00', `tz: ${tz}`)) !== '',
  ) ?? 'UTC'

describe('the zone on a row', () => {
  it('says nothing when there is no zone', () => {
    expect(eventZoneLabel(ev('start: 2026-09-21T09:30'))).toBe('')
  })

  it('says nothing when the zone agrees with the reader’s clock', () => {
    expect(eventZoneLabel(ev('start: 2026-09-21T09:30', `tz: ${HERE}`))).toBe('')
  })

  it('names the city and its clock when the zone disagrees', () => {
    const label = eventZoneLabel(ev('start: 2026-09-21T14:00', `tz: ${ELSEWHERE}`))
    expect(label).toContain(ELSEWHERE.slice(ELSEWHERE.lastIndexOf('/') + 1).replace(/_/g, ' '))
    expect(label).toMatch(/\d{1,2}.\d{2}/)
  })

  it('reads the clock in the event’s own zone, not by moving the instant', () => {
    /*
     * A London event at 03:30 on the morning New York's clocks change. Shifting
     * the instant and formatting it locally landed on the far side of the
     * *device's* transition and came out an hour late; asking Intl for the time
     * in London cannot.
     */
    const e = ev('start: 2026-03-08T03:30', 'tz: Europe/London')
    const truth = new Intl.DateTimeFormat(undefined, {
      timeZone: 'Europe/London',
      hour: '2-digit',
      minute: '2-digit',
    }).format(e.start)
    const label = eventZoneLabel(e)
    expect(label === '' || label.startsWith(truth)).toBe(true)
  })

  it('says nothing for an event carrying seconds in the reader’s own zone', () => {
    // The offset is compared at the instant itself, so :30 past the minute is
    // not mistaken for a different zone.
    expect(eventZoneLabel(ev('start: 2026-06-01T14:00:30', `tz: ${HERE}`))).toBe('')
  })

  it('says nothing for an all-day event, which has no clock to disagree with', () => {
    expect(eventZoneLabel(ev('start: 2026-09-21', `tz: ${ELSEWHERE}`))).toBe('')
  })
})

describe('what is already over', () => {
  it('is past once its end has gone by', () => {
    const e = ev('start: 2026-09-21T09:30', 'end: 2026-09-21T10:00')
    expect(eventIsPast(e, e.end + 1)).toBe(true)
    expect(eventIsPast(e, e.end - 1)).toBe(false)
  })

  it('is never past while it is an all-day event', () => {
    const e = ev('start: 2026-09-21')
    expect(eventIsPast(e, e.end + 86_400_000)).toBe(false)
  })
})

describe('what a row is called', () => {
  it('drops the date and time the filename carries for uniqueness', async () => {
    const { eventTitle } = await import('./agenda')
    expect(eventTitle('2026-09-21 0930 Standup')).toBe('Standup')
    expect(eventTitle('2026-09-21 Office closed')).toBe('Office closed')
  })

  it('leaves a name alone when there is no stamp on it', async () => {
    const { eventTitle } = await import('./agenda')
    expect(eventTitle('Standup')).toBe('Standup')
    expect(eventTitle('Q3 2026 planning')).toBe('Q3 2026 planning')
  })

  it('keeps a note that is genuinely called nothing but a date', async () => {
    const { eventTitle } = await import('./agenda')
    expect(eventTitle('2026-09-21')).toBe('2026-09-21')
  })
})
