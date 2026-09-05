/**
 * What rich text does with a `---` block at the top of a note: nothing you can
 * see. The properties are edited in a form instead — see ui/Properties.tsx.
 */

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { frontmatterField } from './livePreview'
import { previewExtensions } from './setup'

function ranges(doc: string, mode: 'rich' | 'live' | 'source'): Array<[number, number]> {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage }), previewExtensions(mode)],
  })
  const set = state.field(frontmatterField, false)
  if (!set) return []
  const out: Array<[number, number]> = []
  const iter = set.iter()
  while (iter.value) {
    out.push([iter.from, iter.to])
    iter.next()
  }
  return out
}

const withFm = '---\ntitle: Trip\ntags: [travel]\n---\n\n# Trip\n\nBody\n'

describe('the frontmatter block in rich text', () => {
  it('hides the block, fences included', () => {
    expect(ranges(withFm, 'rich')).toEqual([[0, withFm.indexOf('\n\n# Trip')]])
  })

  it('leaves the body alone', () => {
    const [[, to]] = ranges(withFm, 'rich')
    expect(withFm.slice(to)).toBe('\n\n# Trip\n\nBody\n')
  })

  it('hides nothing in the modes that show the file', () => {
    expect(ranges(withFm, 'live')).toEqual([])
    expect(ranges(withFm, 'source')).toEqual([])
  })

  it('has nothing to hide in a note without frontmatter', () => {
    expect(ranges('# Trip\n\nBody\n', 'rich')).toEqual([])
    // A rule mid-note is not a block: frontmatter is the first line or nothing.
    expect(ranges('Body\n\n---\n\nMore\n', 'rich')).toEqual([])
  })

  it('keeps a block with no line under it', () => {
    // Hiding every line there is would leave nowhere to put the caret.
    expect(ranges('---\ntitle: Trip\n---', 'rich')).toEqual([])
    // A blank line under it is somewhere to type, so the block can go.
    expect(ranges('---\ntitle: Trip\n---\n', 'rich')).toEqual([[0, 19]])
  })

  it('follows the block as it grows', () => {
    const state = EditorState.create({
      doc: withFm,
      extensions: [markdown({ base: markdownLanguage }), previewExtensions('rich')],
    })
    const at = withFm.indexOf('tags')
    const next = state.update({ changes: { from: at, insert: 'status: draft\n' } }).state
    const set = next.field(frontmatterField)
    const iter = set.iter()
    expect(iter.to).toBe(withFm.indexOf('\n\n# Trip') + 'status: draft\n'.length)
  })
})
