/**
 * Which files count as orphaned.
 *
 * The whole point of the feature is that it never cries wolf: a file the user
 * has genuinely referenced — however they wrote the reference — must not be
 * offered up for deletion. So these run against a real vault and check the
 * shapes a link actually comes in.
 */

import { describe, expect, it, vi } from 'vitest'

type Vault = typeof import('./vault')

let seq = 0

async function fresh(): Promise<Vault> {
  vi.resetModules()
  ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = `slate-orphan-${++seq}`
  const vault = await import('./vault')
  await vault.initVault()
  return vault
}

async function file(v: Vault, path: string): Promise<string> {
  return v.addAttachment(new Blob(['x'], { type: 'image/png' }), path)
}

function orphans(v: Vault): string[] {
  return [...v.orphanFiles.value].sort()
}

describe('orphan files', () => {
  it('lists a file nothing references', async () => {
    const v = await fresh()
    await file(v, 'attachments/stray.png')
    expect(orphans(v)).toEqual(['attachments/stray.png'])
  })

  it('counts every way a note can point at a file', async () => {
    const v = await fresh()
    await file(v, 'attachments/embedded.png')
    await file(v, 'attachments/wiki.png')
    await file(v, 'attachments/spec.pdf')
    await file(v, 'attachments/sized.png')
    await file(v, 'attachments/spaced name.png')
    await file(v, 'attachments/stray.png')

    await v.createNote(
      '',
      'Uses',
      [
        '![shot](attachments/embedded.png)',
        '![[wiki.png]]',
        // A plain link is a use too — the file is not embedded, but it is not
        // spare either.
        '[the spec](attachments/spec.pdf)',
        '![resized](attachments/sized.png#w=400)',
        '![spaces](attachments/spaced%20name.png)',
      ].join('\n\n'),
    )

    expect(orphans(v)).toEqual(['attachments/stray.png'])
  })

  it('resolves a reference relative to the note that makes it', async () => {
    const v = await fresh()
    await file(v, 'Work/diagram.png')
    await v.createNote('Work', 'Plan', '![](diagram.png)\n')
    expect(orphans(v)).toEqual([])
  })

  it('matches on filename alone, the way an embed does', async () => {
    const v = await fresh()
    await file(v, 'attachments/logo.png')
    await v.createNote('Work', 'Brand', '![[logo.png]]\n')
    expect(orphans(v)).toEqual([])
  })

  it('ignores links inside code, and external URLs', async () => {
    const v = await fresh()
    await file(v, 'attachments/sample.png')
    await v.createNote(
      '',
      'Docs',
      '```md\n![](attachments/sample.png)\n```\n\n![](https://example.com/attachments/sample.png)\n',
    )
    expect(orphans(v)).toEqual(['attachments/sample.png'])
  })

  it('drops a file from the list as soon as a note uses it', async () => {
    const v = await fresh()
    await file(v, 'attachments/shot.png')
    const p = await v.createNote('', 'Log', 'nothing yet\n')
    expect(orphans(v)).toEqual(['attachments/shot.png'])
    await v.saveNote(p, '![](attachments/shot.png)\n')
    expect(orphans(v)).toEqual([])
  })

  it('does not let a deleted note keep a file alive', async () => {
    const v = await fresh()
    await file(v, 'attachments/shot.png')
    const p = await v.createNote('', 'Log', '![](attachments/shot.png)\n')
    expect(orphans(v)).toEqual([])
    await v.deleteNote(p)
    expect(orphans(v)).toEqual(['attachments/shot.png'])
  })
})
