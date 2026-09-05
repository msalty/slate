/**
 * The templates `Templates/` is created with.
 *
 * These are content rather than code, and that is exactly why they are tested:
 * a typo in a template is invisible in review and then appears, verbatim, in
 * every note somebody makes from it. So each one is put through the engine it
 * has to survive — the fields filled in, the frontmatter read back as
 * properties, the tasks and callouts recognised — rather than being eyeballed.
 */

import { describe, expect, it } from 'vitest'
import { STARTER_TEMPLATES } from './starters'
import { expandTemplate } from './templates'
import { readProperties } from './properties'
import { parseFrontmatter, scanTasks } from './markdown'
import { parseYmd, safeSegment } from './util'
import { calloutSpec } from '../editor/callout'

// A Tuesday, so the weekday tokens have something to be wrong about.
const AT = new Date(2026, 8, 8, 9, 30, 0).getTime()

const filled = (text: string, title = 'Kickoff with Acme') =>
  expandTemplate(text, { title, when: AT })

/** Every `{{field}}` a template asks for, arguments dropped. */
function fieldsIn(text: string): string[] {
  return [...text.matchAll(/\{\{([a-z]+)(?::[^}]*)?\}\}/gi)].map((m) => m[1].toLowerCase())
}

const KNOWN = ['title', 'date', 'time', 'year', 'month', 'day', 'weekday', 'cursor']

describe('the starter set', () => {
  it('names each one distinctly, and in a way a file system will keep', () => {
    const names = STARTER_TEMPLATES.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    for (const n of names) expect(safeSegment(n)).toBe(n)
  })

  it('asks only for fields the engine knows', () => {
    for (const t of STARTER_TEMPLATES) {
      // A field nobody recognises is left in the note as typed, so a typo here
      // ships as `{{weekdya}}` in somebody's meeting note.
      const unknown = fieldsIn(t.text).filter((f) => !KNOWN.includes(f))
      expect([t.name, unknown]).toEqual([t.name, []])
    }
  })

  it('leaves nothing unfilled', () => {
    for (const t of STARTER_TEMPLATES) {
      expect([t.name, filled(t.text).text.includes('{{')]).toEqual([t.name, false])
    }
  })

  /*
   * The caret is the difference between a template and a wall of text. Every
   * one of these puts it somewhere you would want to start typing, which is
   * never the top of the file — that is where it sits without a `{{cursor}}`,
   * in front of the frontmatter fence.
   */
  it('puts the caret where writing starts, not at the top of the file', () => {
    for (const t of STARTER_TEMPLATES) {
      const { text, caret } = filled(t.text)
      expect([t.name, caret > 0 && caret < text.length]).toEqual([t.name, true])
      expect([t.name, text.slice(0, caret).includes('---\n')]).toEqual([t.name, true])
    }
  })

  it('reads back as properties once it has been filled in', () => {
    for (const t of STARTER_TEMPLATES) {
      const { text } = filled(t.text)
      const props = readProperties(text)
      expect([t.name, props.length > 0]).toEqual([t.name, true])
      const keys = props.map((p) => p.key)
      expect([t.name, new Set(keys).size]).toEqual([t.name, keys.length])
      // And the block is a block: closed, with the note underneath it.
      expect([t.name, parseFrontmatter(text).bodyStart > 0]).toEqual([t.name, true])
    }
  })

  it('writes callouts the app actually tints', () => {
    for (const t of STARTER_TEMPLATES) {
      for (const m of t.text.matchAll(/^> \[!([A-Za-z]+)\]/gm)) {
        expect([t.name, m[1], calloutSpec(m[1]) !== undefined]).toEqual([t.name, m[1], true])
      }
    }
  })

  /*
   * A blank `- [ ]` is the point — it is a line to type into rather than a
   * task anybody owes. What would be wrong is a *ticked* one, or a due date
   * baked in, either of which would put something into the task list on the
   * day the note was made.
   */
  it('leaves its tasks blank, unticked and undated', () => {
    for (const t of STARTER_TEMPLATES) {
      for (const task of scanTasks(filled(t.text).text)) {
        expect([t.name, task.done]).toEqual([t.name, false])
        expect([t.name, task.due]).toEqual([t.name, undefined])
      }
    }
  })

  it('gives a note that has not been named yet an empty heading', () => {
    for (const t of STARTER_TEMPLATES) {
      const { text } = filled(t.text, '')
      expect([t.name, text.includes('Untitled')]).toEqual([t.name, false])
    }
  })
})

const byName = (name: string) => STARTER_TEMPLATES.find((t) => t.name === name)!

describe('the daily note', () => {
  it('is dated for the day it is filed under, in the block and in the heading', () => {
    const { text } = filled(byName('Daily Note').text, '2026-09-08')
    expect(text).toContain('date: 2026-09-08')
    expect(text).toContain('# Tuesday, 8 September 2026')
    // And the calendar files it under that day rather than under today.
    const fm = parseFrontmatter(text)
    expect(fm.data.date).toBe('2026-09-08')
  })

  it('stamps the log line with the time', () => {
    expect(filled(byName('Daily Note').text).text).toContain('- 09:30 —')
  })

  it('starts you on a task rather than in the heading it already wrote', () => {
    const { text, caret } = filled(byName('Daily Note').text, '2026-09-08')
    expect(text.slice(0, caret).endsWith('- [ ] ')).toBe(true)
  })
})

describe('the meeting note', () => {
  it('carries the fields you would search a year later by', () => {
    const keys = readProperties(filled(byName('Meeting').text).text).map((p) => p.key)
    expect(keys).toEqual(
      expect.arrayContaining(['date', 'time', 'tags', 'client', 'project', 'attendees', 'location']),
    )
  })

  it('offers attendees as a list, so the form takes "Ana, Bo"', () => {
    const attendees = readProperties(filled(byName('Meeting').text).text).find(
      (p) => p.key === 'attendees',
    )!
    expect(attendees.kind).toBe('list')
    expect(attendees.items).toEqual([])
  })

  it('titles itself from the note, and dates itself in words underneath', () => {
    const { text, caret } = filled(byName('Meeting').text)
    expect(text).toContain('# Kickoff with Acme')
    expect(text).toContain('**Tuesday, 8 September 2026 · 09:30**')
    // The caret is left in the heading, ready for a note made unnamed.
    expect(text.slice(0, caret).endsWith('# Kickoff with Acme')).toBe(true)
  })
})

describe('the person note', () => {
  /*
   * vCard is the point of this one: the fields are the ones a contact card
   * already agrees on, so a note written here can be read back out. This test
   * is the list, and changing it is how you say the list changed.
   */
  it('carries what a vCard carries', () => {
    const keys = readProperties(filled(byName('Person').text).text).map((p) => p.key)
    for (const k of [
      'name',
      'nickname',
      'org',
      'department',
      'role',
      'email',
      'phone',
      'website',
      'street',
      'city',
      'region',
      'postcode',
      'country',
      'timezone',
      'birthday',
      'anniversary',
      'social',
      'assistant',
      'partner',
    ])
      expect(keys).toContain(k)
  })

  it('takes several emails and phone numbers, the way a card does', () => {
    const props = readProperties(filled(byName('Person').text).text)
    for (const k of ['email', 'phone', 'social'])
      expect([k, props.find((p) => p.key === k)!.kind]).toEqual([k, 'list'])
  })

  it('names the person from the note, so a [[link]] fills the card in', () => {
    const { text } = filled(byName('Person').text, 'Ana Ruiz')
    expect(text).toContain('name: Ana Ruiz')
    expect(text).toContain('# Ana Ruiz')
    expect(text).toContain('- 2026-09-08 — added')
  })

  it('records the day it was added as a date the form can edit', () => {
    const date = readProperties(filled(byName('Person').text).text).find((p) => p.key === 'date')!
    expect(date.kind).toBe('date')
    expect(parseYmd(date.value)).toBeDefined()
  })
})

describe('the rest of the set', () => {
  it('gives a project its status and a milestone table', () => {
    const { text } = filled(byName('Project').text, 'Ridgeline')
    expect(readProperties(text).map((p) => p.key)).toEqual(
      expect.arrayContaining(['tags', 'status', 'owner', 'client', 'started', 'due', 'stakeholders']),
    )
    expect(text).toContain('| Milestone | Date | Status |')
  })

  it('gives a decision its options and the status that outlives it', () => {
    const { text } = filled(byName('Decision').text, 'Drop the queue')
    expect(text).toContain('status: proposed')
    expect(text).toContain('## Options')
    expect(text).toContain('## Consequences')
  })

  it('gives a reading note somewhere to put the source and the rating', () => {
    const keys = readProperties(filled(byName('Reading').text).text).map((p) => p.key)
    expect(keys).toEqual(
      expect.arrayContaining(['author', 'kind', 'source', 'status', 'started', 'finished', 'rating']),
    )
  })

  it('dates the weekly review by the week it closes', () => {
    const { text } = filled(byName('Weekly Review').text)
    expect(text).toContain('# Week ending 8 September 2026')
    expect(text).toContain('## Rolled over')
  })
})
