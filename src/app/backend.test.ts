/**
 * What a vault records about where its content is kept.
 *
 * Only ever read to notice that two vaults have been pointed at the same place,
 * which is the one mistake in the vaults feature that destroys something: two
 * sets of notes reconciling against one target merge into each other within a
 * few sync runs, and there is no way back except by hand. So the keys have to
 * answer the question the *server* would answer, not the question the settings
 * form happens to be spelled with.
 */

import { describe, expect, it } from 'vitest'
import { targetsOf } from './backend'
import type { AppSettings } from '../core/types'

function settingsWith(patch: Partial<AppSettings>): AppSettings {
  return {
    backend: 'none',
    webdav: { url: '', username: '', password: '', root: '' },
    gdrive: { clientId: '', folderId: '', folderName: 'Slate' },
    folder: { enabled: false, name: '', pollSec: 5 },
    ...patch,
  } as AppSettings
}

const webdav = (url: string, root: string) =>
  targetsOf(
    settingsWith({ backend: 'webdav', webdav: { url, root, username: '', password: '' } }),
  )

describe('the places a vault keeps its content', () => {
  it('reads three spellings of one WebDAV folder as one place', () => {
    /*
     * `WebdavAdapter` puts the root through `normPath` before joining it to the
     * URL, so all of these talk to the same folder on the same server. Compared
     * as typed, the two vaults most likely to collide — one server, set up twice
     * by hand — slipped past the warning on a leading slash.
     */
    const plain = webdav('https://dav.example.com', 'Notes')
    expect(webdav('https://dav.example.com', '/Notes')).toEqual(plain)
    expect(webdav('https://dav.example.com', '/Notes/')).toEqual(plain)
    expect(webdav('https://dav.example.com', 'Notes//')).toEqual(plain)
    // And a trailing slash on the URL is the same server.
    expect(webdav('https://dav.example.com/', 'Notes')).toEqual(plain)
  })

  it('still tells two different folders on one server apart', () => {
    expect(webdav('https://dav.example.com', 'Work')).not.toEqual(
      webdav('https://dav.example.com', 'Personal'),
    )
    expect(webdav('https://dav.example.com', '')).not.toEqual(
      webdav('https://dav.example.com', 'Notes'),
    )
  })

  it('says nothing at all for a vault kept only on this device', () => {
    expect(targetsOf(settingsWith({}))).toEqual([])
    // A backend chosen but not filled in is not a place either.
    expect(targetsOf(settingsWith({ backend: 'webdav' }))).toEqual([])
  })

  it('records one entry per place, so either can collide on its own', () => {
    const both = targetsOf(
      settingsWith({
        backend: 'gdrive',
        gdrive: { clientId: 'x', folderId: '', folderName: 'Slate' },
      }),
    )
    expect(both).toEqual(['gdrive:Slate'])
  })
})
