/** Reading a fenced block back out, for the copy button. */

import { describe, expect, it } from 'vitest'
import { fencedBody } from './codeblock'

const lines = (s: string) => s.split('\n')

describe('fencedBody', () => {
  it('returns the code without its fences', () => {
    expect(fencedBody(lines('```js\nconst a = 1\nconst b = 2\n```'), 0)).toBe(
      'const a = 1\nconst b = 2',
    )
  })

  it('is undefined on a line that is not an opening fence', () => {
    expect(fencedBody(lines('not a fence\n```\nx\n```'), 0)).toBeUndefined()
  })

  /* A block being typed into has no closing fence yet and still has a body. */
  it('runs to the end of the document when the fence is never closed', () => {
    expect(fencedBody(lines('```\nhalf a thought'), 0)).toBe('half a thought')
  })

  it('does not stop at a fence of the other kind', () => {
    expect(fencedBody(lines('```\n~~~\ncode\n```'), 0)).toBe('~~~\ncode')
  })

  it('closes only on a fence at least as long as the one that opened it', () => {
    expect(fencedBody(lines('````\n```\ninner\n```\n````'), 0)).toBe('```\ninner\n```')
  })

  /* A fence nested in a list item copies as code, not as code plus indent. */
  it('strips the opening fence\'s own indentation', () => {
    expect(fencedBody(lines('  ```\n  indented\n  ```'), 2 - 2)).toBe('indented')
  })

  it('leaves relative indentation inside the block intact', () => {
    expect(fencedBody(lines('```py\nif x:\n    y()\n```'), 0)).toBe('if x:\n    y()')
  })

  it('copies an empty block as nothing rather than failing', () => {
    expect(fencedBody(lines('```\n```'), 0)).toBe('')
  })
})
