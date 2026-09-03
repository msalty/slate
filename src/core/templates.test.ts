/**
 * Folder templates.
 *
 * Two things are being guarded here. One is the expansion — a template is
 * plain markdown with a few fields in it, and the fields have to be filled in
 * with what the *note* is, not with what the template said. The other is that
 * the whole feature stays out of the way: a vault that has never made a
 * `Templates/` folder must behave as though none of this existed.
 */

import { describe, expect, it, vi } from 'vitest'
import { parseYmd } from './util'

type Vault = typeof import('./vault')
type Templates = typeof import('./templates')

let seq = 0

async function fresh(): Promise<{ vault: Vault; t: Templates }> {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = `slate-tpl-${++seq}`
  const vault = await import('./vault')
  await vault.initVault()
  const t = await import('./templates')
  return { vault, t }
}

// A Tuesday, so the weekday tokens are checkable.
const DAY = parseYmd('2026-09-08')!
const AT = new Date(2026, 8, 8, 14, 5, 9).getTime()

describe('filling in a template', () => {
  it('puts the note’s own name in {{title}}', async () => {
    const { t } = await fresh()
    expect(t.expandTemplate('# {{title}}\n', { title: 'Call with TAC', when: AT }).text).toBe(
      '# Call with TAC\n',
    )
  })

  it('defaults a date to YYYY-MM-DD and a time to HH:mm', async () => {
    const { t } = await fresh()
    expect(t.expandTemplate('{{date}} {{time}}', { title: '', when: AT }).text).toBe(
      '2026-09-08 14:05',
    )
  })

  it('takes a pattern for the ones that want one', async () => {
    const { t } = await fresh()
    expect(
      t.expandTemplate('{{date:DDDD, D MMMM YYYY}}', { title: '', when: AT }).text,
    ).toBe('Tuesday, 8 September 2026')
    expect(t.expandTemplate('{{date:DDD MMM YY}}', { title: '', when: AT }).text).toBe(
      'Tue Sep 26',
    )
  })

  /*
   * MMMM has to be consumed before MMM, or "September" comes out as "Sep" with
   * a stray "M" after it.
   */
  it('does not let a short pattern eat a long one', async () => {
    const { t } = await fresh()
    expect(t.expandTemplate('{{date:MMMM}}', { title: '', when: AT }).text).toBe('September')
    expect(t.expandTemplate('{{date:DDDD}}', { title: '', when: AT }).text).toBe('Tuesday')
  })

  it('fills the standalone parts too', async () => {
    const { t } = await fresh()
    expect(
      t.expandTemplate('{{year}}/{{month}}/{{day}} {{weekday}}', { title: '', when: AT }).text,
    ).toBe('2026/09/08 Tuesday')
  })

  /* A typo should look like a typo in the note, not vanish into it. */
  it('leaves a token nobody recognises exactly as written', async () => {
    const { t } = await fresh()
    expect(t.expandTemplate('{{nonsense}} {{titel}}', { title: 'x', when: AT }).text).toBe(
      '{{nonsense}} {{titel}}',
    )
  })

  it('is case-insensitive about the field names', async () => {
    const { t } = await fresh()
    expect(t.expandTemplate('{{TITLE}}', { title: 'Trip', when: AT }).text).toBe('Trip')
  })
})

describe('where the caret lands', () => {
  it('is wherever {{cursor}} was, and the marker itself goes', async () => {
    const { t } = await fresh()
    const out = t.expandTemplate('# {{title}}\n\n{{cursor}}\n\n## Notes', {
      title: 'Ab',
      when: AT,
    })
    expect(out.text).toBe('# Ab\n\n\n\n## Notes')
    expect(out.caret).toBe('# Ab\n\n'.length)
  })

  /*
   * The end, not position 0. A note that opens with a heading already in it
   * would otherwise take the first keystroke into the middle of that heading.
   */
  it('is the end of the template when it does not say', async () => {
    const { t } = await fresh()
    const out = t.expandTemplate('# {{title}}\n\n', { title: 'Ab', when: AT })
    expect(out.caret).toBe(out.text.length)
  })

  it('takes the first {{cursor}} and leaves any others as text', async () => {
    const { t } = await fresh()
    const out = t.expandTemplate('a{{cursor}}b{{cursor}}c', { title: '', when: AT })
    expect(out.text).toBe('ab{{cursor}}c')
    expect(out.caret).toBe(1)
  })
})

describe('staying out of the way', () => {
  it('has nothing to offer a vault with no Templates folder', async () => {
    const { vault, t } = await fresh()
    await vault.createNote('Work', 'Note', 'body\n')
    expect(t.hasTemplates.value).toBe(false)
    expect(t.templateNotes.value).toEqual([])
    expect(t.templateBodyFor('Work', 'Untitled')).toBeUndefined()
  })

  it('does not create the folder by being asked about it', async () => {
    const { vault, t } = await fresh()
    t.templateBodyFor('Work', 'Untitled')
    t.assignedTemplate('Work')
    expect(vault.notes.value.some((n) => n.path.startsWith('Templates/'))).toBe(false)
  })

  it('offers nothing until a folder is actually pointed at a template', async () => {
    const { vault, t } = await fresh()
    await vault.createNote('Templates', 'Meeting', '# {{title}}\n')
    expect(t.hasTemplates.value).toBe(true)
    // The templates exist; no folder uses one yet.
    expect(t.templateBodyFor('Work', 'Untitled')).toBeUndefined()
  })
})

describe('applying one to a folder', () => {
  it('starts a new note in that folder from it', async () => {
    const { vault, t } = await fresh()
    await vault.createNote('Templates', 'Meeting', '# {{title}}\n\nAttendees:\n')
    await t.setFolderTemplate('Work', 'Templates/Meeting.md')
    expect(t.templateBodyFor('Work', 'Standup', AT)?.text).toBe('# Standup\n\nAttendees:\n')
  })

  /*
   * Exact folder, no inheritance. A template on the vault root would otherwise
   * apply to every note anywhere, which is how an optional feature stops being
   * one.
   */
  it('applies to that folder and not to the ones inside it', async () => {
    const { vault, t } = await fresh()
    await vault.createNote('Templates', 'Meeting', 'M\n')
    await t.setFolderTemplate('Work', 'Templates/Meeting.md')
    expect(t.templateBodyFor('Work/Projects', 'x')).toBeUndefined()
    await t.setFolderTemplate('', 'Templates/Meeting.md')
    expect(t.templateBodyFor('Work/Projects', 'x')).toBeUndefined()
    expect(t.templateBodyFor('', 'x')?.text).toBe('M\n')
  })

  it('never applies a template to a template', async () => {
    const { vault, t } = await fresh()
    await vault.createNote('Templates', 'Meeting', 'M\n')
    await t.setFolderTemplate('Templates', 'Templates/Meeting.md')
    expect(t.templateBodyFor('Templates', 'Another')).toBeUndefined()
  })

  it('is cleared by assigning nothing', async () => {
    const { vault, t } = await fresh()
    await vault.createNote('Templates', 'Meeting', 'M\n')
    await t.setFolderTemplate('Work', 'Templates/Meeting.md')
    await t.setFolderTemplate('Work', undefined)
    expect(t.assignedTemplate('Work')).toBeUndefined()
    expect(t.templateBodyFor('Work', 'x')).toBeUndefined()
  })

  /*
   * An assignment is a path, and a path goes stale when the note it points at
   * is renamed or deleted. The menu names what `resolvedTemplate` returns, so
   * the difference between "assigned" and "assigned to something that is still
   * there" is what stops a folder looking configured while applying nothing.
   */
  it('tells an assignment apart from one that still resolves', async () => {
    const { vault, t } = await fresh()
    const path = await vault.createNote('Templates', 'Meeting', 'M\n')
    await t.setFolderTemplate('Work', path)
    expect(t.resolvedTemplate('Work')?.title).toBe('Meeting')

    await vault.renameNote(path, 'Meeting notes')
    expect(t.assignedTemplate('Work')).toBe(path)
    expect(t.resolvedTemplate('Work')).toBeUndefined()
    expect(t.templateBodyFor('Work', 'x')).toBeUndefined()
  })

  it('goes quiet rather than wrong when the template is deleted', async () => {
    const { vault, t } = await fresh()
    const path = await vault.createNote('Templates', 'Meeting', 'M\n')
    await t.setFolderTemplate('Work', path)
    await vault.deleteNote(path)
    expect(t.templateBodyFor('Work', 'x')).toBeUndefined()
  })

  it('ignores a template with nothing in it', async () => {
    const { vault, t } = await fresh()
    const path = await vault.createNote('Templates', 'Empty', '   \n')
    await t.setFolderTemplate('Work', path)
    expect(t.templateBodyFor('Work', 'x')).toBeUndefined()
  })
})

describe('following the folder it is attached to', () => {
  /*
   * The assignment is keyed by folder path. Without this, renaming a folder
   * leaves it looking identical and quietly not applying its template any more
   * — the worst kind of failure, because nothing about it is visible.
   */
  it('survives the folder being renamed', async () => {
    const { vault, t } = await fresh()
    const folders = await import('./folders')
    await vault.createNote('Templates', 'Meeting', '# {{title}}\n')
    await vault.createNote('Work', 'Kickoff', 'x\n')
    await t.setFolderTemplate('Work', 'Templates/Meeting.md')

    const dest = await folders.renameFolder('Work', 'Work 2026')
    expect(dest).toBe('Work 2026')
    expect(t.templateBodyFor('Work 2026', 'Standup')?.text).toBe('# Standup\n')
    expect(t.assignedTemplate('Work')).toBeUndefined()
  })

  it('carries the folders nested inside it along too', async () => {
    const { vault, t } = await fresh()
    const folders = await import('./folders')
    await vault.createNote('Templates', 'Meeting', 'M\n')
    await vault.createNote('Work/Projects', 'One', 'x\n')
    await t.setFolderTemplate('Work/Projects', 'Templates/Meeting.md')

    await folders.renameFolder('Work', 'Work 2026')
    expect(t.assignedTemplate('Work 2026/Projects')).toBe('Templates/Meeting.md')
  })

  it('is forgotten when the folder is deleted', async () => {
    const { vault, t } = await fresh()
    const folders = await import('./folders')
    await vault.createNote('Templates', 'Meeting', 'M\n')
    await vault.createNote('Work', 'Kickoff', 'x\n')
    await t.setFolderTemplate('Work', 'Templates/Meeting.md')

    await folders.deleteFolder('Work')
    expect(t.assignedTemplate('Work')).toBeUndefined()
  })
})

/*
 * The vault root is where ⌘N puts a note with no folder selected, and where a
 * note created from a broken [[link]] always goes. The link case is the one
 * `{{title}}` exists for — the note is named for the link text — so a root
 * template is what makes that field reachable at all.
 */
describe('a note that has not been named yet', () => {
  /*
   * The pairing this feature turns on. "Untitled" is the absence of a title,
   * not a title, so one template can serve both: a note that has a name gets
   * its heading, and one that does not gets an empty heading to type into.
   */
  it('leaves {{title}} empty rather than writing the word Untitled', async () => {
    const { vault, t } = await fresh()
    await vault.createNote('Templates', 'Any', '# {{title}}{{cursor}}\n\nbody\n')
    await t.setFolderTemplate('Work', 'Templates/Any.md')

    const unnamed = t.templateBodyFor('Work', 'Untitled')!
    expect(unnamed.text).toBe('# \n\nbody\n')
    // ...and the caret is sitting in the heading, ready for a name.
    expect(unnamed.caret).toBe(2)
  })

  it('uses the name when it has one, from the same template', async () => {
    const { vault, t } = await fresh()
    await vault.createNote('Templates', 'Any', '# {{title}}{{cursor}}\n\nbody\n')
    await t.setFolderTemplate('Work', 'Templates/Any.md')

    const named = t.templateBodyFor('Work', 'Highway 9')!
    expect(named.text).toBe('# Highway 9\n\nbody\n')
    expect(named.caret).toBe('# Highway 9'.length)
  })
})

describe('notes outside any folder', () => {
  it('can have a template of their own', async () => {
    const { vault, t } = await fresh()
    await vault.createNote('Templates', 'Stub', '# {{title}}\n\nFrom a link.\n')
    await t.setFolderTemplate('', 'Templates/Stub.md')
    expect(t.templateBodyFor('', 'Highway 9')?.text).toBe('# Highway 9\n\nFrom a link.\n')
  })

  /*
   * And it stays outside them. Without this a root template would apply to
   * every note anywhere, which is the whole reason folder matching is exact.
   */
  it('does not become a template for the whole vault', async () => {
    const { vault, t } = await fresh()
    await vault.createNote('Templates', 'Stub', 'S\n')
    await vault.createNote('Work', 'Existing', 'x\n')
    await t.setFolderTemplate('', 'Templates/Stub.md')
    expect(t.templateBodyFor('Work', 'Kickoff')).toBeUndefined()
    expect(t.templateBodyFor('Work/Deep', 'Kickoff')).toBeUndefined()
  })
})

describe('the daily note', () => {
  it('starts from the Daily folder’s template when there is one', async () => {
    const { vault, t } = await fresh()
    const daily = await import('./daily')
    await vault.createNote('Templates', 'Day', '# {{date:DDDD}}\n\n## Log\n')
    await t.setFolderTemplate('Daily', 'Templates/Day.md')

    const made = await daily.dailyNotePath(DAY)
    expect(vault.getRaw(made.path)?.text).toBe('# Tuesday\n\n## Log\n')
  })

  /*
   * The day the note is *for*, not the day it was written. A note started on
   * Saturday about Thursday is Thursday's, and the file is named for Thursday
   * — the date inside it has to agree.
   */
  it('dates it for the day it is filed under, not for today', async () => {
    const { vault, t } = await fresh()
    const daily = await import('./daily')
    await vault.createNote('Templates', 'Day', '{{date}}\n')
    await t.setFolderTemplate('Daily', 'Templates/Day.md')

    const made = await daily.dailyNotePath(DAY)
    expect(vault.getRaw(made.path)?.text).toBe('2026-09-08\n')
    expect(made.path).toBe('Daily/2026-09-08.md')
  })

  it('still writes the plain heading when Daily has no template', async () => {
    const { vault } = await fresh()
    const daily = await import('./daily')
    const made = await daily.dailyNotePath(DAY)
    expect(vault.getRaw(made.path)?.text).toBe('# 2026-09-08\n\n')
  })
})
