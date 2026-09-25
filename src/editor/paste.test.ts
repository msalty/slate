// @vitest-environment jsdom
/**
 * Pasting several files at once.
 *
 * `insertFiles` takes them in together, and each chose its name before
 * hashing: two `same.bin`s both became `attachments/same.bin`, and one blob
 * replaced the other. Camera shots named by the second do the same.
 */

import { describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { scanWikiLinks } from '../core/markdown'

// jsdom lays nothing out; the paste scrolls the caret into view, which measures.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList
Range.prototype.getBoundingClientRect = () => new DOMRect()

describe('pasting two files with one name', () => {
  it('keeps both, under two names', async () => {
    vi.resetModules()
    ;(globalThis as { __SLATE_DB__?: string }).__SLATE_DB__ = 'slate-paste-1'
    const vault = await import('../core/vault')
    const { insertFiles } = await import('./paste')
    await vault.initVault()
    const view = new EditorView({
      parent: document.body.appendChild(document.createElement('div')),
      state: EditorState.create({ doc: '' }),
    })
    insertFiles(view, [
      new File(['first body'], 'same.bin', { type: 'application/octet-stream' }),
      new File(['second body'], 'same.bin', { type: 'application/octet-stream' }),
    ])
    await vi.waitFor(() => expect(view.state.doc.toString()).not.toContain('slate-uploading'))
    const paths = scanWikiLinks(view.state.doc.toString()).map((l) => l.target)
    expect(paths).toHaveLength(2)
    expect(new Set(paths).size).toBe(2)
    const bodies = await Promise.all(paths.map((p) => vault.getRaw(p)!.blob!.text()))
    expect(bodies.sort()).toEqual(['first body', 'second body'])
    view.destroy()
  })
})
