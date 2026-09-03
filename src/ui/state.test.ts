/**
 * Which way a note opens.
 *
 * The rule is one line of code and the entire feel of opening a note: a page
 * you can read and scroll with no keyboard in the way, unless the note is one
 * you just made, in which case the caret is already waiting. Both halves are
 * easy to get wrong in the same invisible way — a stale "open this for writing"
 * request answering for the *next* note opened — so the one-shot nature of the
 * request is checked as carefully as the rule itself.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { activePath, openNote, opensForWriting } from './state'

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
