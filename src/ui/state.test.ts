/**
 * Which way a note opens, and what a click on a calendar day asks for.
 *
 * The rule is one line of code and the entire feel of opening a note: a page
 * you can read and scroll with no keyboard in the way, unless the note is one
 * you just made, in which case the caret is already waiting. Both halves are
 * easy to get wrong in the same invisible way — a stale "open this for writing"
 * request answering for the *next* note opened — so the one-shot nature of the
 * request is checked as carefully as the rule itself.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { activePath, calendarDayIntent, openNote, opensForWriting } from './state'

const NOTE = 'Notes/Lisbon.md'
const OTHER = 'Notes/Packing.md'

describe('opensForWriting', () => {
  beforeEach(() => {
    // Clear any request left behind by the previous case.
    opensForWriting('', '', false)
    activePath.value = undefined
  })

  it('opens a note that has something in it as a page to read', () => {
    expect(opensForWriting(NOTE, '# Lisbon\n\nFlights booked.\n', false)).toBe(false)
  })

  it('opens an empty note ready to type: there is nothing in it to read', () => {
    expect(opensForWriting(NOTE, '', false)).toBe(true)
  })

  it('counts a note holding nothing but whitespace as empty', () => {
    expect(opensForWriting(NOTE, '\n\n  \n', false)).toBe(true)
  })

  it('opens a note the shell seeded with a template ready to type', () => {
    openNote(NOTE, { editing: true })
    expect(opensForWriting(NOTE, '# Tuesday\n\n', false)).toBe(true)
  })

  it('answers only for the note that asked', () => {
    openNote(NOTE, { editing: true })
    expect(opensForWriting(OTHER, '# Packing\n', false)).toBe(false)
  })

  it('answers once, so the next note opened is not dragged into editing', () => {
    openNote(NOTE, { editing: true })
    expect(opensForWriting(NOTE, '# Tuesday\n\n', false)).toBe(true)
    expect(opensForWriting(NOTE, '# Tuesday\n\n', false)).toBe(false)
  })

  it('forgets a request as soon as a note is opened to be read', () => {
    openNote(NOTE, { editing: true })
    openNote(OTHER)
    expect(opensForWriting(NOTE, '# Tuesday\n\n', false)).toBe(false)
  })

  it('never opens a deleted note for writing, empty or not', () => {
    expect(opensForWriting(NOTE, '', true)).toBe(false)
    openNote(NOTE, { editing: true })
    expect(opensForWriting(NOTE, '# Tuesday\n\n', true)).toBe(false)
  })

  it('consumes the request even for a deleted note, so it cannot leak forward', () => {
    openNote(NOTE, { editing: true })
    expect(opensForWriting(NOTE, 'text', true)).toBe(false)
    expect(opensForWriting(NOTE, 'text', false)).toBe(false)
  })
})

/**
 * What a click on a calendar day does.
 *
 * The one case worth guarding is the fourth: in journal mode a day with no note
 * must ask rather than write, because the click is a guess about what somebody
 * meant and a file written on a guess is a file they have to go and delete.
 */
describe('calendarDayIntent', () => {
  it('filters the list to the day clicked', () => {
    expect(calendarDayIntent('filter', { hasDaily: false, isSelected: false })).toBe('filter')
  })

  it('takes the filter back off when the day showing is clicked again', () => {
    expect(calendarDayIntent('filter', { hasDaily: false, isSelected: true })).toBe('clear')
  })

  it('ignores whether the day has a daily note while filtering', () => {
    expect(calendarDayIntent('filter', { hasDaily: true, isSelected: false })).toBe('filter')
  })

  it('opens the day’s note in journal mode', () => {
    expect(calendarDayIntent('daily', { hasDaily: true, isSelected: false })).toBe('open')
  })

  it('offers to make one rather than writing a file nobody asked for', () => {
    expect(calendarDayIntent('daily', { hasDaily: false, isSelected: false })).toBe('offer')
  })

  it('opens the day again rather than clearing when it is already the one showing', () => {
    // A click that means "open this day's note" means it the second time too;
    // only the filtering mode has something to toggle off.
    expect(calendarDayIntent('daily', { hasDaily: true, isSelected: true })).toBe('open')
    expect(calendarDayIntent('daily', { hasDaily: false, isSelected: true })).toBe('offer')
  })
})
