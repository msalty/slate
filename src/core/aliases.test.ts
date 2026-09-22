/**
 * `aliases:` as extra link targets.
 *
 * The rule worth guarding is the one that is not obvious: a name written on a
 * file always beats the same name written in somebody else's alias list. One
 * pass over the notes would decide that by whichever note the walk reached
 * first, which is to say by modified time, which is to say at random.
 */

import { describe, expect, it, vi } from 'vitest'

type Vault = typeof import('./vault')

let seq = 0

async function fresh(): Promise<Vault> {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = `slate-aliases-${++seq}`
  const vault = await import('./vault')
  await vault.initVault()
  return vault
}

const fm = (...aliases: string[]) => `---\naliases: [${aliases.join(', ')}]\n---\n\nBody.\n`

describe('aliases', () => {
  it('reads an inline list off the frontmatter', async () => {
    const vault = await fresh()
    await vault.createNote('', 'Jane Doe', fm('Jane Smith', 'JD'))
    expect(vault.getEntry('Jane Doe.md')?.aliases).toEqual(['Jane Smith', 'JD'])
  })

  it('reads a block list, and a bare string, as aliases too', async () => {
    const vault = await fresh()
    await vault.createNote('', 'Block', '---\naliases:\n  - One\n  - Two\n---\n')
    await vault.createNote('', 'Scalar', '---\naliases: Solo\n---\n')
    expect(vault.getEntry('Block.md')?.aliases).toEqual(['One', 'Two'])
    expect(vault.getEntry('Scalar.md')?.aliases).toEqual(['Solo'])
  })

  it('has no aliases when the key is absent, empty or blank', async () => {
    const vault = await fresh()
    await vault.createNote('', 'Plain', '# Plain\n')
    await vault.createNote('', 'Empty', '---\naliases:\n---\n')
    await vault.createNote('', 'Blank', '---\naliases: "   "\n---\n')
    expect(vault.getEntry('Plain.md')?.aliases).toEqual([])
    expect(vault.getEntry('Empty.md')?.aliases).toEqual([])
    expect(vault.getEntry('Blank.md')?.aliases).toEqual([])
  })

  it('resolves a link written with an alias', async () => {
    const vault = await fresh()
    await vault.createNote('', 'Jane Doe', fm('Jane Smith'))
    expect(vault.resolveLink('Jane Smith')).toBe('Jane Doe.md')
    expect(vault.resolveLink('jane smith')).toBe('Jane Doe.md')
  })

  it('counts an aliased link as a backlink, not a broken one', async () => {
    const vault = await fresh()
    await vault.createNote('', 'Jane Doe', fm('Jane Smith'))
    await vault.createNote('', 'Lunch', 'Ate with [[Jane Smith]].\n')
    expect(vault.backlinkMap.value.get('Jane Doe.md')).toEqual(['Lunch.md'])
    expect([...vault.unresolvedLinks.value.keys()]).toEqual([])
  })

  it('never lets an alias take a name another note is actually called', async () => {
    const vault = await fresh()
    // Written first, so it is the *older* note: without the two-pass rule the
    // newest note wins the name, and that is this one.
    await vault.createNote('', 'Mercury', '# The planet\n')
    await vault.createNote('', 'Freddie', fm('Mercury'))
    expect(vault.resolveLink('Mercury')).toBe('Mercury.md')
  })

  it('and still answers to its other aliases when one of them is taken', async () => {
    const vault = await fresh()
    await vault.createNote('', 'Mercury', '# The planet\n')
    await vault.createNote('', 'Freddie', fm('Mercury', 'Farrokh'))
    expect(vault.resolveLink('Farrokh')).toBe('Freddie.md')
  })

  it('gives a contested alias to one note and leaves the other its own name', async () => {
    const vault = await fresh()
    await vault.createNote('', 'First', fm('Shared'))
    await vault.createNote('', 'Second', fm('Shared'))
    // Whoever gets it, the answer is one of them and both are still reachable
    // by their own names — the property that matters is that nothing is lost.
    expect(['First.md', 'Second.md']).toContain(vault.resolveLink('Shared'))
    expect(vault.resolveLink('First')).toBe('First.md')
    expect(vault.resolveLink('Second')).toBe('Second.md')
  })

  it('leaves an exact path alone: a file still beats every name', async () => {
    const vault = await fresh()
    await vault.createNote('Work', 'Report', fm('Summary'))
    await vault.createNote('', 'Summary', '# A different note\n')
    expect(vault.resolveLink('Work/Report')).toBe('Work/Report.md')
    expect(vault.resolveLink('Summary')).toBe('Summary.md')
  })
})

describe('an alias with a comma in it', () => {
  it('is one name, and resolves', async () => {
    const vault = await fresh()
    await vault.createNote('', 'Jane Doe', '---\naliases: ["Doe, Jane", JD]\n---\n\nBody.\n')
    expect(vault.getEntry('Jane Doe.md')?.aliases).toEqual(['Doe, Jane', 'JD'])
    expect(vault.resolveLink('Doe, Jane')).toBe('Jane Doe.md')
    expect(vault.resolveLink('JD')).toBe('Jane Doe.md')
  })

  it('and the halves of it are not names of their own', async () => {
    const vault = await fresh()
    await vault.createNote('', 'Jane Doe', '---\naliases: ["Doe, Jane"]\n---\n')
    // `"Doe` and `Jane"` were two aliases, neither of them anything anybody
    // would write, and `[[Doe, Jane]]` resolved to nothing.
    expect(vault.resolveLink('"Doe')).toBeUndefined()
    expect(vault.resolveLink('Jane"')).toBeUndefined()
  })
})
