/**
 * Renaming and moving a note, and what happens to the links that point at it.
 *
 * A rename is only safe if every link that meant this note still means it
 * afterwards, and no link that meant some *other* note is touched. The rewrite
 * used to decide which links were this note's by comparing their text with its
 * old title, which was wrong both ways: a rename that collided sent the note to
 * `Foo 2` and its links to `[[Foo]]`, and of two notes called `A`, renaming the
 * one `[[A]]` did not mean rewrote it anyway. It now resolves each link and
 * rewrites the ones that actually arrived here.
 */

import { describe, expect, it, vi } from 'vitest'

let seq = 0

async function fresh() {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = `slate-rename-${++seq}`
  const vault = await import('./vault')
  await vault.initVault()
  return { vault, folders: await import('./folders') }
}

const base = (p: string) => p.slice(p.lastIndexOf('/') + 1, -'.md'.length)

/** A note as a sync pull hands it over. */
function pulled(path: string, text: string) {
  return {
    path,
    kind: 'note' as const,
    text,
    mime: 'text/markdown',
    size: text.length,
    hash: `h-${path}`,
    mtime: Date.now(),
    ctime: Date.now(),
    deleted: false,
    dirty: false,
    sync: {},
  }
}

describe('renaming onto a name already taken', () => {
  it('sends the links where the note went, not to the note that had the name', async () => {
    const { vault } = await fresh()
    const foo = await vault.createNote('', 'Foo', 'the original Foo')
    const a = await vault.createNote('', 'A', 'note A')
    const linker = await vault.createNote('', 'Linker', 'see [[A]]')
    const moved = await vault.renameNote(a, 'Foo')
    expect(moved).toBe('Foo 2.md')
    // Was `see [[Foo]]` — a link to the other note, with nothing to say so.
    expect(vault.getRaw(linker)?.text).toBe('see [[Foo 2]]')
    expect(vault.resolveLink('Foo 2')).toBe(moved)
    expect(vault.resolveLink('Foo')).toBe(foo)
  })
})

describe('which links a rename takes with it', () => {
  it('leaves a link that meant a different note of the same name', async () => {
    const { vault } = await fresh()
    const workA = await vault.createNote('Work', 'A', 'work A')
    const homeA = await vault.createNote('Home', 'A', 'home A')
    const linker = await vault.createNote('', 'Linker', 'see [[A]]')
    const meant = vault.resolveLink('A')
    const other = meant === workA ? homeA : workA
    await vault.renameNote(other, 'Renamed')
    // It was rewritten to `[[Renamed]]`: taken by a note it never pointed at.
    expect(vault.getRaw(linker)?.text).toBe('see [[A]]')
    expect(vault.resolveLink('A')).toBe(meant)
  })

  it('takes one that did mean it', async () => {
    const { vault } = await fresh()
    const workA = await vault.createNote('Work', 'A', 'work A')
    const homeA = await vault.createNote('Home', 'A', 'home A')
    const linker = await vault.createNote('', 'Linker', 'see [[A]]')
    const meant = vault.resolveLink('A')!
    const moved = await vault.renameNote(meant, 'Renamed')
    expect(vault.getRaw(linker)?.text).toBe('see [[Renamed]]')
    expect(vault.resolveLink('Renamed')).toBe(moved)
    void workA
    void homeA
  })

  it('follows a link written as a path, in the shape it was written', async () => {
    const { vault } = await fresh()
    const a = await vault.createNote('Work', 'A', 'work A')
    const linker = await vault.createNote('', 'Linker', 'see [[Work/A]] and [[Work/A.md]]')
    const moved = await vault.renameNote(a, 'B')
    // A path link was not rewritten at all, and was left pointing at nothing.
    expect(vault.getRaw(linker)?.text).toBe('see [[Work/B]] and [[Work/B.md]]')
    expect(vault.resolveLink('Work/B')).toBe(moved)
  })

  it('writes a path when the new title belongs to another note too', async () => {
    const { vault } = await fresh()
    const homeB = await vault.createNote('Home', 'B', 'home B')
    const a = await vault.createNote('Work', 'A', 'work A')
    const linker = await vault.createNote('', 'Linker', 'see [[A]]')
    const moved = await vault.renameNote(a, 'B')
    expect(moved).toBe('Work/B.md')
    /*
     * `[[B]]` would mean whichever of the two the index met first — and the
     * index meets the most recently *edited* first, so which note a shared
     * title means changes every time either one is touched. A path cannot land
     * anywhere else, whichever that is.
     */
    expect(vault.getRaw(linker)?.text).toBe('see [[Work/B]]')
    expect(vault.resolveLink('Work/B')).toBe(moved)
    expect(vault.resolveLink('Home/B')).toBe(homeB)
  })

  it('leaves a link that reached the note through an alias', async () => {
    const { vault } = await fresh()
    const a = await vault.createNote('', 'A', '---\naliases: [Alpha]\n---\n\nnote A')
    const linker = await vault.createNote('', 'Linker', 'see [[Alpha]] and [[A]]')
    const moved = await vault.renameNote(a, 'B')
    // The alias is written in the note and went with it; how somebody chose
    // to link is theirs.
    expect(vault.getRaw(linker)?.text).toBe('see [[Alpha]] and [[B]]')
    expect(vault.resolveLink('Alpha')).toBe(moved)
  })

  it('keeps a heading, a display name and an embed as they were', async () => {
    const { vault } = await fresh()
    const a = await vault.createNote('', 'A', '# Costs\n\nnote A')
    const linker = await vault.createNote('', 'Linker', '[[A#Costs]] [[A|the plan]] ![[A]]')
    await vault.renameNote(a, 'B')
    expect(vault.getRaw(linker)?.text).toBe('[[B#Costs]] [[B|the plan]] ![[B]]')
  })

  it('leaves a link inside a code block alone', async () => {
    const { vault } = await fresh()
    const a = await vault.createNote('', 'A', 'note A')
    const linker = await vault.createNote('', 'Linker', 'see [[A]]\n\n```\n[[A]]\n```\n')
    await vault.renameNote(a, 'B')
    expect(vault.getRaw(linker)?.text).toBe('see [[B]]\n\n```\n[[A]]\n```\n')
  })

  it('takes a link the note makes to itself', async () => {
    const { vault } = await fresh()
    const a = await vault.createNote('', 'A', '# Costs\n\nsee [[A#Costs]]')
    const moved = await vault.renameNote(a, 'B')
    expect(vault.getRaw(moved)?.text).toBe('# Costs\n\nsee [[B#Costs]]')
  })

  it('and leaves nothing behind when the editor saves the old name once more', async () => {
    const { vault } = await fresh()
    const text = '# Costs\n\nsee [[A#Costs]]'
    const a = await vault.createNote('', 'A', text)
    const moved = await vault.renameNote(a, 'B')
    /*
     * What the editor does as a rename lands: saves the buffer it still holds
     * for the path it had open. A save that does not match the tombstone there
     * brings the note back — and rewriting the self-link before the move made
     * the tombstone record the rewritten text, so it never matched. Renaming a
     * note that linked to itself left a copy under its old name.
     */
    await vault.saveNote(a, text)
    expect(vault.occupied(a)).toBe(false)
    expect(vault.notes.value.map((n) => n.title)).toEqual(['B'])
    expect(vault.getRaw(moved)?.text).toBe('# Costs\n\nsee [[B#Costs]]')
  })
})

describe('renaming to a name the link syntax uses', () => {
  /*
   * `#`, `|` and `]` all mean something inside `[[…]]`, and renaming a note to
   * `C# Notes` wrote its links out as `[[C# Notes]]` — the note `C` and its
   * heading `Notes`. Every link to it went somewhere else.
   */
  it('keeps every link to a note renamed to a name with a #', async () => {
    const { vault } = await fresh()
    const a = await vault.createNote('', 'A', '# Costs\n\nnote A')
    const linker = await vault.createNote(
      '',
      'Linker',
      '[[A]] [[A#Costs|the plan]] ![[A]] [[#Here]]',
    )
    const moved = await vault.renameNote(a, 'C# Notes')
    expect(moved).toBe('C# Notes.md')
    const text = vault.getRaw(linker)?.text ?? ''
    expect(text).toBe('[[C\\# Notes]] [[C\\# Notes#Costs|the plan]] ![[C\\# Notes]] [[#Here]]')
    // And every one of them arrives.
    expect(vault.resolveLink('C# Notes')).toBe(moved)
    const { scanWikiLinks } = await import('./markdown')
    const targets = scanWikiLinks(text).map((l) => l.target)
    expect(targets).toEqual(['C# Notes', 'C# Notes', 'C# Notes', ''])
    expect(vault.backlinkMap.value.get(moved)).toEqual([linker])
  })

  it('and one renamed to a name with a ] in it', async () => {
    const { vault } = await fresh()
    const a = await vault.createNote('', 'A', 'note A')
    const linker = await vault.createNote('', 'Linker', 'see [[A]] then more')
    const moved = await vault.renameNote(a, 'Draft ]v2')
    expect(vault.getRaw(linker)?.text).toBe('see [[Draft \\]v2]] then more')
    expect(vault.backlinkMap.value.get(moved)).toEqual([linker])
  })

  it('and one written as a path', async () => {
    const { vault } = await fresh()
    const a = await vault.createNote('Work', 'A', 'work A')
    const linker = await vault.createNote('', 'Linker', 'see [[Work/A]]')
    const moved = await vault.renameNote(a, 'C# Notes')
    expect(vault.getRaw(linker)?.text).toBe('see [[Work/C\\# Notes]]')
    expect(vault.backlinkMap.value.get(moved)).toEqual([linker])
  })

  it('keeps display text with a ] in it through a rename', async () => {
    const { vault } = await fresh()
    const { formatWikiLink } = await import('./wikilink')
    const { scanWikiLinks } = await import('./markdown')
    const a = await vault.createNote('', 'A', 'note A')
    const linker = await vault.createNote(
      '',
      'Linker',
      `see ${formatWikiLink({ target: 'A', alias: 'Status [draft]' })} after`,
    )
    await vault.renameNote(a, 'B')
    const text = vault.getRaw(linker)?.text ?? ''
    // Written back as `[[B|Status [draft]]]` it was `Status [draft` and a stray `]`.
    expect(text).toBe('see [[B|Status [draft\\]]] after')
    expect(scanWikiLinks(text)[0]).toMatchObject({ target: 'B', alias: 'Status [draft]' })
  })

  it('tells receipt%23 from receipt#, both ways a link can name one', async () => {
    const { vault } = await fresh()
    const blob = () => new Blob(['x'], { type: 'image/png' })
    const hash = await vault.addAttachment(blob(), 'receipt#.png')
    const photo = await vault.addAttachment(blob(), 'photo.png')
    const note = await vault.createNote('', 'Receipts', `![](${photo})`)
    const literal = await vault.renameAttachment(photo, 'receipt%23')
    expect([hash, literal]).toEqual(['receipt#.png', 'receipt%23.png'])
    // Its `%` is encoded like any other, so the address is `receipt%2523.png` —
    expect(vault.getRaw(note)?.text).toBe('![](receipt%2523.png)')
    // which decoded the old way, everything first and `%23` after, came back
    // as `receipt#.png`: the other file.
    expect(vault.getEntry(note)!.embeds).toEqual([literal])
    expect(vault.resolveEmbed('receipt%2523.png', note)).toBe(literal)
    expect(vault.resolveEmbed('receipt%23.png', note)).toBe(hash)
  })

  it('keeps an attachment’s embeds when it is renamed to a name with a #', async () => {
    const { vault } = await fresh()
    const photo = await vault.addAttachment(new Blob(['x'], { type: 'image/png' }), 'photo.png')
    const note = await vault.createNote('', 'Receipts', `![[${photo}]] and ![](${photo})`)
    const renamed = await vault.renameAttachment(photo, 'receipt#2')
    expect(renamed).toBe('receipt#2.png')
    /*
     * A wikilink escapes the `#`, and a markdown link encodes it: in an
     * address `#` starts the fragment, and `encodeURI` leaves it alone on
     * purpose, so it was written bare and read as `receipt` plus `#2.png`.
     */
    expect(vault.getRaw(note)?.text).toBe('![[receipt\\#2.png]] and ![](receipt%232.png)')
    // Both read back as the file, by the index and by the embed resolver.
    expect(vault.resolveEmbed('receipt%232.png', note)).toBe(renamed)
    const entry = vault.getEntry(note)!
    expect(entry.embeds).toEqual([renamed, renamed])
  })
})

describe('moving a note into a folder', () => {
  it('never overwrites the note that already has its name there', async () => {
    const { vault, folders } = await fresh()
    const work = await vault.createNote('Work', 'Foo', 'WORK FOO')
    const home = await vault.createNote('Home', 'Foo', 'home foo')
    const dest = await folders.moveNoteToFolder(home, 'Work')
    // It moved straight onto `Work/Foo.md`, and that note was gone.
    expect(vault.getRaw(work)?.text).toBe('WORK FOO')
    expect(dest).toBe('Work/Foo 2.md')
    expect(vault.getRaw(dest)?.text).toBe('home foo')
  })

  it('takes its links along when the move has to rename it', async () => {
    const { vault, folders } = await fresh()
    await vault.createNote('Work', 'Foo', 'WORK FOO')
    const home = await vault.createNote('Home', 'Foo', 'home foo')
    const linker = await vault.createNote('', 'Linker', 'see [[Home/Foo]]')
    const dest = await folders.moveNoteToFolder(home, 'Work')
    expect(vault.getRaw(linker)?.text).toBe('see [[Work/Foo 2]]')
    expect(vault.resolveLink('Work/Foo 2')).toBe(dest)
  })

  it('keeps its name where nothing is in the way', async () => {
    const { vault, folders } = await fresh()
    const home = await vault.createNote('Home', 'Foo', 'home foo')
    const linker = await vault.createNote('', 'Linker', 'see [[Foo]]')
    const dest = await folders.moveNoteToFolder(home, 'Work')
    expect(dest).toBe('Work/Foo.md')
    expect(vault.getRaw(linker)?.text).toBe('see [[Foo]]')
    expect(vault.resolveLink('Foo')).toBe(dest)
  })
})

describe('renaming a folder', () => {
  /*
   * It moved every note and rewrote nothing, so a link by path into the folder
   * pointed at nothing while the note sat at its new path.
   */
  it('takes every link into it along, in the shape each was written', async () => {
    const { vault, folders } = await fresh()
    const note = await vault.createNote('Projects/Alpha', 'Note', '# H\n\nnote')
    await vault.createNote('Projects/Alpha/Sub', 'Deep', 'deep')
    const png = new Blob(['x'], { type: 'image/png' })
    const img = await vault.addAttachment(png, 'Projects/Alpha/img.png')
    const linker = await vault.createNote(
      '',
      'Linker',
      [
        '[[Projects/Alpha/Note]]',
        '[[Projects/Alpha/Note.md#H|shown]]',
        '![[Projects/Alpha/Note]]',
        '[[Projects/Alpha/Sub/Deep]]',
        '[[Note]]',
        `![[${img}|400]]`,
        `![](${img}#w=200)`,
      ].join('\n'),
    )
    const dest = await folders.renameFolder('Projects/Alpha', 'Beta')
    expect(dest).toBe('Projects/Beta')
    expect(vault.getRaw(linker)?.text).toBe(
      [
        '[[Projects/Beta/Note]]',
        '[[Projects/Beta/Note.md#H|shown]]',
        '![[Projects/Beta/Note]]',
        '[[Projects/Beta/Sub/Deep]]',
        // By its name, which a folder does not change.
        '[[Note]]',
        '![[Projects/Beta/img.png|400]]',
        '![](Projects/Beta/img.png#w=200)',
      ].join('\n'),
    )
    expect(vault.resolveLink('Projects/Beta/Note')).toBe('Projects/Beta/Note.md')
    expect(vault.occupied(note)).toBe(false)
  })

  it('leaves links between notes inside it that do not need to change', async () => {
    const { vault, folders } = await fresh()
    await vault.addAttachment(new Blob(['x'], { type: 'image/png' }), 'Projects/Alpha/img.png')
    const inside = await vault.createNote(
      'Projects/Alpha',
      'Inside',
      '![](img.png) and ![[img.png]] and [[Projects/Alpha/Other]]',
    )
    await vault.createNote('Projects/Alpha', 'Other', 'other')
    await folders.renameFolder('Projects/Alpha', 'Beta')
    const moved = inside.replace('Alpha', 'Beta')
    // Relative, and still right from where the note now is; the path is not.
    expect(vault.getRaw(moved)?.text).toBe(
      '![](img.png) and ![[img.png]] and [[Projects/Beta/Other]]',
    )
    // And the note it moved from is gone — rewritten after the move, so no
    // save of the old path can bring it back.
    await vault.saveNote(inside, '![](img.png) and ![[img.png]] and [[Projects/Alpha/Other]]')
    expect(vault.occupied(inside)).toBe(false)
  })
})

describe('moving a note, and the links it makes', () => {
  it('keeps a relative link to a file that stayed behind pointing at it', async () => {
    const { vault, folders } = await fresh()
    await vault.addAttachment(new Blob(['x'], { type: 'image/png' }), 'Home/img.png')
    const note = await vault.createNote('Home', 'Trip', 'see ![](img.png)')
    const dest = await folders.moveNoteToFolder(note, 'Work')
    // `img.png` from `Work/` is a file that is not there.
    expect(vault.getRaw(dest)?.text).toBe('see ![](Home/img.png)')
    expect(vault.resolveEmbed('Home/img.png', dest)).toBe('Home/img.png')
  })
})

describe('two notes with one name', () => {
  /*
   * `[[Name]]` meant whichever had been edited most recently, and then
   * whichever was made first — by a clock that is local, so a synced vault's
   * devices could each be sure a different note was older.
   */
  it('means the first by path, whatever order they were made or edited in', async () => {
    const { vault } = await fresh()
    const work = await vault.createNote('Work', 'Name', 'work')
    const home = await vault.createNote('Home', 'Name', 'home')
    expect(vault.resolveLink('Name')).toBe(home)
    await vault.saveNote(work, 'work, edited')
    expect(vault.resolveLink('Name')).toBe(home)
  })

  it('keeps a link on its note when a new one would take the name', async () => {
    const { vault } = await fresh()
    const work = await vault.createNote('Work', 'Name', 'work')
    const ref = await vault.createNote('', 'Ref', 'see [[Name#Costs|the costs]]')
    const archive = await vault.createNote('Archive', 'Name', 'archive')
    expect(vault.resolveLink('Name')).toBe(archive)
    expect(vault.getRaw(ref)?.text).toBe('see [[Work/Name#Costs|the costs]]')
    expect(vault.resolveLink('Work/Name')).toBe(work)
  })

  it('and when a move would hand it to the other note', async () => {
    const { vault, folders } = await fresh()
    const home = await vault.createNote('Home', 'Name', 'home')
    const work = await vault.createNote('Work', 'Name', 'work')
    const ref = await vault.createNote('', 'Ref', 'see [[Name]]')
    // `Archive/Name` sorts before `Home/Name`: the bare name would go with it.
    await folders.moveNoteToFolder(work, 'Archive')
    expect(vault.getRaw(ref)?.text).toBe('see [[Home/Name]]')
    expect(vault.resolveLink('Home/Name')).toBe(home)
  })

  it('and follows its own note when that one moves out of first place', async () => {
    const { vault, folders } = await fresh()
    await vault.createNote('Home', 'Name', 'home')
    await vault.createNote('Work', 'Name', 'work')
    const ref = await vault.createNote('', 'Ref', 'see [[Name]]')
    await folders.moveNoteToFolder('Home/Name.md', 'Zed')
    expect(vault.getRaw(ref)?.text).toBe('see [[Zed/Name]]')
  })

  it('leaves a link alone when it means the same note afterwards', async () => {
    const { vault, folders } = await fresh()
    await vault.createNote('Home', 'Name', 'home')
    const work = await vault.createNote('Work', 'Name', 'work')
    const ref = await vault.createNote('', 'Ref', 'see [[Name]]')
    await folders.moveNoteToFolder(work, 'Zed')
    expect(vault.getRaw(ref)?.text).toBe('see [[Name]]')
  })

  it('is asked about by path, so the question is about the note on screen', async () => {
    const { vault } = await fresh()
    await vault.createNote('Home', 'Name', 'home')
    const work = await vault.createNote('Work', 'Name', 'work')
    const ask = await import('../ui/AskDialog')
    ask.askAboutNote(work)
    expect(ask.draft.value?.pin).toBe('Work/Name')
    expect(vault.resolveLink(ask.draft.value!.pin!)).toBe(work)
  })

  /*
   * The dialog held `Name` while `Work/Name` was the only one, and an
   * `Archive/Name` arriving before it was sent took the question.
   */
  it('and stays that note if another of the name turns up while the dialog is open', async () => {
    const { vault } = await fresh()
    const work = await vault.createNote('Work', 'Name', 'work')
    const ask = await import('../ui/AskDialog')
    ask.askAboutNote(work)
    expect(ask.draft.value?.pinLabel).toBe('Name')
    await vault.createNote('Archive', 'Name', 'archive')
    expect(vault.resolveLink(ask.draft.value!.pin!)).toBe(work)
  })

  it('keeps a link on its note when one of that name is pulled in by sync', async () => {
    const { vault } = await fresh()
    const work = await vault.createNote('Work', 'Name', 'work')
    const ref = await vault.createNote('', 'Ref', 'see [[Name]]')
    const text = 'from elsewhere, see [[Name]]'
    await vault.installFromRemote([pulled('Archive/Name.md', text)])
    expect(vault.resolveLink('Name')).toBe('Archive/Name.md')
    expect(vault.getRaw(ref)?.text).toBe('see [[Work/Name]]')
    expect(vault.resolveLink('Work/Name')).toBe(work)
    // Its own links were written by a device that already had it: left alone.
    expect(vault.getRaw('Archive/Name.md')?.text).toBe(text)
  })

  it('and when a note pulled in brings an alias another note answers to', async () => {
    const { vault } = await fresh()
    const work = await vault.createNote('Work', 'X', '---\naliases: [Nick]\n---\nx')
    const ref = await vault.createNote('', 'Ref', 'see [[Nick]]')
    await vault.installFromRemote([pulled('Archive/Y.md', '---\naliases: [Nick]\n---\ny')])
    expect(vault.getRaw(ref)?.text).toBe('see [[Work/X]]')
    expect(vault.resolveLink('Work/X')).toBe(work)
  })

  it('keeps a link on its note when an alias it was reached by is removed', async () => {
    const { vault } = await fresh()
    const a = await vault.createNote('Archive', 'A', '---\naliases: [Nick]\n---\na')
    await vault.createNote('Work', 'B', '---\naliases: [Nick]\n---\nb')
    const ref = await vault.createNote('', 'Ref', 'see [[Nick]]')
    expect(vault.resolveLink('Nick')).toBe(a)
    await vault.saveNote(a, 'a')
    expect(vault.getRaw(ref)?.text).toBe('see [[Archive/A]]')
  })

  it('and when an alias added to an earlier note would take it', async () => {
    const { vault } = await fresh()
    const a = await vault.createNote('Archive', 'A', 'a')
    const b = await vault.createNote('Work', 'B', '---\naliases: [Nick]\n---\nb')
    const ref = await vault.createNote('', 'Ref', 'see [[Nick]]')
    await vault.saveNote(a, '---\naliases: [Nick]\n---\na')
    expect(vault.resolveLink('Nick')).toBe(a)
    expect(vault.getRaw(ref)?.text).toBe('see [[Work/B]]')
    expect(vault.resolveLink('Work/B')).toBe(b)
  })

  it('and when the note it leads to is deleted and the name would pass on', async () => {
    const { vault } = await fresh()
    const archive = await vault.createNote('Archive', 'Name', 'archive')
    await vault.createNote('Work', 'Name', 'work')
    const ref = await vault.createNote('', 'Ref', 'see [[Name]]')
    await vault.deleteNote(archive)
    expect(vault.getRaw(ref)?.text).toBe('see [[Archive/Name]]')
    expect(vault.resolveLink('Archive/Name')).toBeUndefined()
  })

  it('and at the root, where the path without .md is the name', async () => {
    const { vault } = await fresh()
    const root = await vault.createNote('', 'Name', 'root')
    await vault.createNote('Work', 'Name', 'work')
    const ref = await vault.createNote('', 'Ref', 'see [[Name]]')
    await vault.deleteNote(root)
    expect(vault.getRaw(ref)?.text).toBe('see [[Name.md]]')
    // And back from the trash, it is that note's again.
    const [trashed] = vault.trashItems()
    await vault.restoreFromTrash(trashed.path)
    expect(vault.resolveLink('Name.md')).toBe(root)
  })

  it('and when a note restored from the trash would take it', async () => {
    const { vault } = await fresh()
    const root = await vault.createNote('', 'Name', 'root')
    await vault.deleteNote(root)
    const work = await vault.createNote('Work', 'Name', 'work')
    const ref = await vault.createNote('', 'Ref', 'see [[Name]]')
    const [trashed] = vault.trashItems()
    await vault.restoreFromTrash(trashed.path)
    expect(vault.getRaw(ref)?.text).toBe('see [[Work/Name]]')
    expect(vault.resolveLink('Work/Name')).toBe(work)
  })

  it('and when sync deletes the note it leads to', async () => {
    const { vault } = await fresh()
    const archive = await vault.createNote('Archive', 'Name', 'archive')
    await vault.createNote('Work', 'Name', 'work')
    const ref = await vault.createNote('', 'Ref', 'see [[Name]]')
    await vault.forget(archive)
    expect(vault.getRaw(ref)?.text).toBe('see [[Archive/Name]]')
  })

  it('leaves a link alone when the note it led to goes and nothing takes the name', async () => {
    const { vault } = await fresh()
    const only = await vault.createNote('Archive', 'Only', 'only')
    const ref = await vault.createNote('', 'Ref', 'see [[Only]]')
    await vault.deleteNote(only)
    expect(vault.getRaw(ref)?.text).toBe('see [[Only]]')
  })

  it('follows a note renamed while something held its old path', async () => {
    const { vault } = await fresh()
    const a = await vault.createNote('', 'A', 'a')
    const b = await vault.renameNote(a, 'B')
    expect(vault.currentPath(a)).toBe(b)
    const back = await vault.renameNote(b, 'A')
    expect(vault.currentPath(a)).toBe(back)
    expect(vault.currentPath(b)).toBe(back)
    await vault.deleteNote(back)
    expect(vault.currentPath(a)).toBeUndefined()
  })

  it('keeps a conversation’s scope on its note, through arrivals and moves', async () => {
    const { vault, folders } = await fresh()
    await vault.createNote('Work', 'Name', 'work')
    const convo = await vault.createNote('', 'Chat', '---\nsource: "links:Name"\n---\n# Chat\n')
    await vault.createNote('Archive', 'Name', 'archive')
    expect(vault.getRaw(convo)?.text).toContain('source: "links:Work/Name"')
    await folders.moveNoteToFolder('Work/Name.md', 'Zed')
    expect(vault.getRaw(convo)?.text).toContain('source: "links:Zed/Name"')
  })

  it('is linked to by path, so a new link means the note that was picked', async () => {
    const { vault } = await fresh()
    const home = await vault.createNote('Home', 'Name', 'home')
    const only = await vault.createNote('', 'Only', 'only')
    expect(vault.linkNameFor(home)).toBe('Name')
    const work = await vault.createNote('Work', 'Name', 'work')
    expect(vault.linkNameFor(home)).toBe('Home/Name')
    expect(vault.linkNameFor(work)).toBe('Work/Name')
    expect(vault.linkNameFor(only)).toBe('Only')
  })
})

describe('a folder renamed onto one that is there', () => {
  /*
   * A folder holding only an attachment was not seen as a folder, so the
   * rename went ahead: links were rewritten, a note moved, and the attachment
   * that collided threw — leaving the folder half in each place.
   */
  it('is refused before anything is touched', async () => {
    const { vault, folders } = await fresh()
    const png = () => new Blob(['x'], { type: 'image/png' })
    await vault.addAttachment(png(), 'Dest/img.png')
    await vault.addAttachment(png(), 'Src/img.png')
    const note = await vault.createNote('Src', 'Note', 'n')
    const ref = await vault.createNote('', 'Ref', 'see [[Src/Note]]')
    await expect(folders.renameFolder('Src', 'Dest')).rejects.toThrow(/already exists/)
    expect(vault.getRaw(ref)?.text).toBe('see [[Src/Note]]')
    expect(vault.occupied(note)).toBe(true)
    expect(vault.occupied('Dest/Note.md')).toBe(false)
  })

  it('and so is any set of moves that could not all land', async () => {
    const { vault } = await fresh()
    await vault.addAttachment(new Blob(['x'], { type: 'image/png' }), 'Dest/img.png')
    await vault.addAttachment(new Blob(['y'], { type: 'image/png' }), 'Src/img.png')
    const note = await vault.createNote('Src', 'Note', 'n')
    const moves = new Map([
      [note, 'Dest/Note.md'],
      ['Src/img.png', 'Dest/img.png'],
    ])
    await expect(vault.relocate(moves)).rejects.toThrow(/already exists/)
    expect(vault.occupied(note)).toBe(true)
    const twice = new Map([
      [note, 'Else/Same.md'],
      ['Src/img.png', 'Else/Same.md'],
    ])
    await expect(vault.relocate(twice)).rejects.toThrow(/already exists/)
    expect(vault.occupied(note)).toBe(true)
  })
})

describe('a rename racing an edit', () => {
  /*
   * The plan checked the note's text, then awaited the hash of the rewrite; an
   * edit saved in that gap was written over: `see [[A]] plus my edit` became
   * `see [[B]]`.
   */
  it('keeps the edit and still rewrites the link', async () => {
    const { vault } = await fresh()
    const a = await vault.createNote('', 'A', 'a')
    const ref = await vault.createNote('', 'Ref', 'see [[A]]')
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    let raced = false
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (alg, data) => {
      const text = new TextDecoder().decode(data as ArrayBuffer)
      if (!raced && text === 'see [[B]]') {
        raced = true
        await vault.saveNote(ref, 'see [[A]] plus my edit')
      }
      return digest(alg, data as ArrayBuffer)
    })
    await vault.renameNote(a, 'B')
    spy.mockRestore()
    expect(raced).toBe(true)
    expect(vault.getRaw(ref)?.text).toBe('see [[B]] plus my edit')
  })
})

describe('a rename racing an edit to another note it rewrites', () => {
  /*
   * The rewrites were held and persisted together at the end, so an edit saved
   * to the first while the second was hashing stayed on screen and was then
   * written over in the database: gone on reload.
   */
  it('keeps the edit through a reload', async () => {
    const { vault } = await fresh()
    const a = await vault.createNote('', 'A', 'a')
    const one = await vault.createNote('', 'One', 'one [[A]]')
    await vault.createNote('', 'Two', 'two [[A]]')
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    let raced = false
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (alg, data) => {
      const text = new TextDecoder().decode(data as ArrayBuffer)
      if (!raced && text === 'two [[B]]') {
        raced = true
        await vault.saveNote(one, `${vault.getText(one)} plus my edit`)
      }
      return digest(alg, data as ArrayBuffer)
    })
    await vault.renameNote(a, 'B')
    spy.mockRestore()
    expect(raced).toBe(true)
    expect(vault.getText(one)).toBe('one [[B]] plus my edit')
    await vault.initVault()
    expect(vault.getText(one)).toBe('one [[B]] plus my edit')
  })
})

describe('the move underneath every rename', () => {
  it('refuses to write over a note that is there', async () => {
    const { vault } = await fresh()
    const a = await vault.createNote('', 'A', 'note A')
    const b = await vault.createNote('', 'B', 'note B')
    await expect(vault.movePath(a, b)).rejects.toThrow(/already exists/)
    expect(vault.getRaw(b)?.text).toBe('note B')
    expect(vault.getRaw(a)?.text).toBe('note A')
  })

  it('but a deleted note’s tombstone is not in the way', async () => {
    const { vault } = await fresh()
    const gone = await vault.createNote('', 'Gone', 'deleted')
    await vault.deleteNote(gone)
    const a = await vault.createNote('', 'A', 'note A')
    await vault.movePath(a, gone)
    expect(vault.getRaw(gone)?.text).toBe('note A')
  })
})

describe('the counter a name already taken is given', () => {
  it('fits inside the limit when a note is made', async () => {
    const { vault } = await fresh()
    const long = 'M'.repeat(200)
    await vault.createNote('', long)
    const second = await vault.createNote('', long)
    expect(base(second).length).toBe(120)
    expect(base(second).endsWith(' 2')).toBe(true)
  })

  it('and when one is renamed onto a name already in use', async () => {
    const { vault } = await fresh()
    const long = 'M'.repeat(200)
    await vault.createNote('', long)
    const other = await vault.createNote('', 'Other')
    const renamed = await vault.renameNote(other, long)
    expect(base(renamed).length).toBe(120)
    expect(base(renamed).endsWith(' 2')).toBe(true)
  })

  /*
   * An event's name ends in its date, and a counter makes room for itself by
   * cutting the end: a 120-character event moved into a folder holding its
   * twin came out `… - 2026-09- 2`, and the agenda showed the mangled name.
   */
  it('keeps an event’s date whole when a move has to count', async () => {
    const { vault, folders } = await fresh()
    const ev = await import('./eventnote')
    const { eventTitle } = await import('./agenda')
    const long = 'M'.repeat(200)
    const { path } = await ev.newEventNote(long, '2026-09-21T09:30', '2026-09-21T10:30')
    await vault.createNote('Elsewhere', base(path), 'its twin')
    const dest = await folders.moveNoteToFolder(path, 'Elsewhere')
    expect(base(dest).length).toBe(120)
    expect(base(dest).endsWith(' - 2026-09-21 2')).toBe(true)
    const e = vault.getEntry(dest)!
    // Still made from the title it records, so still read by it.
    expect(eventTitle(e.title, e.event?.title)).toBe(long)
  })

  it('and one with no recorded title, by the title in its name', async () => {
    const { vault, folders } = await fresh()
    const stem = `${'M'.repeat(107)} - 2026-09-21`
    const p = await vault.createNote('', stem, '---\nstart: 2026-09-21T09:30\n---\n')
    await vault.createNote('Elsewhere', stem, 'its twin')
    const dest = await folders.moveNoteToFolder(p, 'Elsewhere')
    expect(base(dest)).toBe(`${'M'.repeat(105)} - 2026-09-21 2`)
  })

  it('and when it comes back out of the trash to a name now taken', async () => {
    const { vault } = await fresh()
    const ev = await import('./eventnote')
    const { eventTitle } = await import('./agenda')
    const long = 'M'.repeat(200)
    const { path } = await ev.newEventNote(long, '2026-09-21T09:30', '2026-09-21T10:30')
    await vault.deleteNote(path)
    // A restore goes to the vault root — the trash keeps only the name — so
    // that is where the name has to be taken.
    await vault.createNote('', base(path), 'its twin')
    const trashed = vault.trashFiles.value[0].path
    const back = await vault.restoreFromTrash(trashed)
    expect(base(back).length).toBe(120)
    expect(base(back).endsWith(' - 2026-09-21 2')).toBe(true)
    const e = vault.getEntry(back)!
    expect(eventTitle(e.title, e.event?.title)).toBe(long)
  })

  it('and keeps a restore in the folder it was sent to', async () => {
    const { vault } = await fresh()
    const p = await vault.createNote('', 'Foo', 'the one deleted')
    await vault.deleteNote(p)
    await vault.createNote('Work', 'Foo', 'already there')
    const back = await vault.restoreFromTrash(vault.trashFiles.value[0].path, 'Work/Foo.md')
    // The counter was built from the bare name, which put it at the root.
    expect(back).toBe('Work/Foo 2.md')
  })

  it('and when an attachment is renamed onto a long name already in use', async () => {
    const { vault } = await fresh()
    const blob = () => new Blob(['x'], { type: 'image/png' })
    const long = 'M'.repeat(200)
    await vault.renameAttachment(await vault.addAttachment(blob(), 'a.png'), long)
    const second = await vault.renameAttachment(await vault.addAttachment(blob(), 'b.png'), long)
    expect(second.length).toBe(120)
    expect(second.endsWith(' 2.png')).toBe(true)
  })

  it('and when one is moved into a folder that has its name', async () => {
    const { vault, folders } = await fresh()
    const long = 'M'.repeat(200)
    await vault.createNote('Work', long)
    const home = await vault.createNote('Home', long)
    const dest = await folders.moveNoteToFolder(home, 'Work')
    expect(base(dest).length).toBe(120)
    expect(base(dest).endsWith(' 2')).toBe(true)
  })
})
