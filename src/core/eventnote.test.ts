/**
 * Making an event by hand.
 *
 * The name is the part worth pinning down. A note's title is its filename and
 * `titleIndex` hands a contested name to one note and leaves the other
 * unreachable by it, so two meetings called Standup on one day have to be two
 * names — and both have to stay linkable.
 */

import { describe, expect, it, vi } from 'vitest'
import { anHourAfter, eventFolderFor, eventNoteName, nextHalfHour } from './eventnote'
import { parseYmd } from './util'

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

describe('where an event goes and what it is called', () => {
  it('files it under the year and month', () => {
    expect(eventFolderFor(DAY)).toBe('Calendar/2026/09')
  })

  it('puts the date in the name, and only the date', () => {
    // Not the time: a filename does not follow the frontmatter, so a meeting
    // moved to the afternoon would keep a name saying 0930 forever.
    expect(eventNoteName('Design review', DAY)).toBe('2026-09-21 Design review')
    expect(eventNoteName('Office closed', DAY)).toBe('2026-09-21 Office closed')
  })

  it('suggests the next round half hour, never one that has gone', () => {
    expect(nextHalfHour(new Date(2026, 8, 21, 14, 7).getTime())).toBe('14:30')
    expect(nextHalfHour(new Date(2026, 8, 21, 14, 31).getTime())).toBe('15:00')
    expect(nextHalfHour(new Date(2026, 8, 21, 14, 30).getTime())).toBe('14:30')
  })

  it('adds an hour without falling off the end of the day', () => {
    expect(anHourAfter('09:30')).toBe('10:30')
    expect(anHourAfter('23:30')).toBe('00:30')
  })
})

describe('the note it writes', () => {
  it('lands in the calendar folder, named for its day', async () => {
    const { ev } = await fresh()
    const { path } = await ev.newEventNote('Design review', DAY, '09:30')
    expect(path).toBe('Calendar/2026/09/2026-09-21 Design review.md')
  })

  it('opens with a start and an end already written', async () => {
    const { vault, ev } = await fresh()
    const { path } = await ev.newEventNote('Design review', DAY, '09:30')
    expect(vault.getRaw(path)?.text).toBe(
      '---\nstart: 2026-09-21T09:30\nend: 2026-09-21T10:30\n---\n\n# Design review\n\n',
    )
  })

  it('is on that day’s agenda the moment it exists', async () => {
    const { vault, ev } = await fresh()
    const { path } = await ev.newEventNote('Design review', DAY, '09:30')
    expect(vault.eventsByDay.value.get(DAY)?.map((e) => e.path)).toEqual([path])
  })

  it('gives two meetings on one day two names, both of them linkable', async () => {
    const { vault, ev } = await fresh()
    const a = await ev.newEventNote('Standup', DAY, '09:30')
    const b = await ev.newEventNote('Standup', DAY, '14:00')
    expect(a.path).not.toBe(b.path)
    // The same `2` every other name collision in the vault gets — and unlike a
    // time, a `2` cannot go on to be wrong about anything.
    expect(vault.resolveLink('2026-09-21 Standup')).toBe(a.path)
    expect(vault.resolveLink('2026-09-21 Standup 2')).toBe(b.path)
  })

  it('and the same meeting on two days keeps two names without help', async () => {
    const { vault, ev } = await fresh()
    const a = await ev.newEventNote('Standup', DAY, '09:30')
    const b = await ev.newEventNote('Standup', DAY + 86_400_000, '09:30')
    expect(vault.resolveLink('2026-09-21 Standup')).toBe(a.path)
    expect(vault.resolveLink('2026-09-22 Standup')).toBe(b.path)
  })

  it('keeps the name it was given when the time is changed afterwards', async () => {
    const { vault, ev } = await fresh()
    const { path } = await ev.newEventNote('Design review', DAY, '09:30')
    await vault.saveNote(
      path,
      '---\nstart: 2026-09-21T14:00\nend: 2026-09-21T15:00\n---\n\n# Design review\n',
    )
    // The file does not rename itself, which is the point: a rename would
    // break every `[[link]]` pointing at it. The agenda reads the clock off
    // `start:`, so the moved meeting shows at 14:00 regardless.
    expect(vault.getEntry(path)?.event?.start).toBe(new Date(2026, 8, 21, 14, 0).getTime())
    expect(vault.resolveLink('2026-09-21 Design review')).toBe(path)
  })

  it('takes a template from Calendar/, not only from the month it landed in', async () => {
    const { vault, ev, templates } = await fresh()
    await vault.createNote('Templates', 'Meeting', '# {{title}}\n\n## Attendees\n\n## Notes\n')
    await templates.setFolderTemplate('Calendar', 'Templates/Meeting.md')
    const { path } = await ev.newEventNote('Design review', DAY, '09:30')
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
    const { path } = await ev.newEventNote('Design review', DAY, '09:30')
    const text = vault.getRaw(path)?.text ?? ''
    // One block, not two: a second `---` fence would make the template's keys
    // body text and the event would have no start at all.
    expect(text.match(/^---$/gm)?.length).toBe(2)
    expect(text).toContain('start: 2026-09-21T09:30')
    expect(text).toContain('attendees: []')
    expect(vault.getEntry(path)?.event?.start).toBe(new Date(2026, 8, 21, 9, 30).getTime())
  })

  it('lands the caret where the template asked, past the frontmatter', async () => {
    const { vault, ev, templates } = await fresh()
    await vault.createNote('Templates', 'Meeting', '# {{title}}\n\n{{cursor}}\n')
    await templates.setFolderTemplate('Calendar', 'Templates/Meeting.md')
    const { path, caret } = await ev.newEventNote('Design review', DAY, '09:30')
    const text = vault.getRaw(path)?.text ?? ''
    expect(caret).toBeGreaterThan(text.indexOf('# Design review'))
  })
})
