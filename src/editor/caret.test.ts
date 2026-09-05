/**
 * The two edges of a line whose head is hidden, and what each key does on each.
 *
 * Same fixture notation as format.test.ts: `‸` is the caret. `‸- [ ] Task` is
 * the caret in front of the checkbox and `- [ ] ‸Task` is behind it — one place
 * on screen each, and the whole point of this file is that they do not mean the
 * same thing.
 */

import { describe, expect, it } from 'vitest'
import { EditorState, type TransactionSpec } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { breakAbove, lineHead, planBackspace, planDelete, planEnter, snapOutOfPrefix } from './caret'

function st(fixture: string): EditorState {
  const caret = fixture.indexOf('‸')
  return EditorState.create({
    doc: fixture.replace('‸', ''),
    selection: caret < 0 ? undefined : { anchor: caret },
    // The plans consult the syntax tree to leave code blocks alone.
    extensions: [markdown({ base: markdownLanguage })],
  })
}

/** The document after a plan is applied, with the caret marked. */
function mark(state: EditorState, spec: TransactionSpec | null): string | null {
  if (!spec) return null
  const tr = state.update(spec)
  const text = tr.state.doc.toString()
  const at = tr.state.selection.main.from
  return `${text.slice(0, at)}‸${text.slice(at)}`
}

/** Enter: where the caret ends up, marked in the resulting document. */
function after(fixture: string): string {
  const state = st(fixture)
  const plan = planEnter(state)
  if (!plan) return fixture
  if (plan.kind === 'break-above')
    return mark(state, breakAbove(state, plan.prefix, plan.caret)) as string
  const text = state.doc.toString()
  return `${text.slice(0, plan.to)}‸${text.slice(plan.to)}`
}

const backspace = (fixture: string) => {
  const state = st(fixture)
  return mark(state, planBackspace(state))
}

const forwardDelete = (fixture: string) => {
  const state = st(fixture)
  const spec = planDelete(state)
  return spec ? state.update(spec).state.doc.toString() : null
}

describe('lineHead', () => {
  it('finds what is hidden at the head of a line', () => {
    expect(lineHead(st('- [ ] ‸task'), 6)).toMatchObject({ from: 0, hiddenTo: 6, hasMarker: true })
    expect(lineHead(st('## ‸Heading'), 3)).toMatchObject({ from: 0, hiddenTo: 3, hasMarker: false })
    expect(lineHead(st('> ‸quoted'), 2)).toMatchObject({ from: 0, hiddenTo: 2, hasMarker: false })
  })

  /* An ordered list keeps its number on screen, so its positions are real. */
  it('leaves a line with nothing hidden alone', () => {
    expect(lineHead(st('1. ‸numbered'), 3)).toBe(null)
    expect(lineHead(st('   ‸indented'), 3)).toBe(null)
    expect(lineHead(st('plain ‸line'), 6)).toBe(null)
    expect(lineHead(st('```\n- ‸[ ] not a task\n```'), 6)).toBe(null)
  })

  /* But the quote in front of that number is hidden, and it stops there. */
  it('stops the hidden run where the visible markup starts', () => {
    expect(lineHead(st('> 1. ‸numbered'), 5)).toMatchObject({ hiddenTo: 2, contentStart: 5 })
  })
})

describe('snapOutOfPrefix', () => {
  const snapped = (fixture: string) => {
    const state = st(fixture)
    const at = snapOutOfPrefix(state, state.selection.main.from)
    const text = state.doc.toString()
    return `${text.slice(0, at)}‸${text.slice(at)}`
  }

  /*
   * The seam between the hidden `- ` and the checkbox widget, which is where
   * Home lands. Whichever edge is nearer wins, which is the rule a click
   * follows too — so the two never disagree about the same pixel.
   */
  it('takes a caret inside the head to the nearer edge', () => {
    expect(snapped('- ‸[ ] Test task')).toBe('‸- [ ] Test task')
    expect(snapped('- [ ]‸ Test task')).toBe('- [ ] ‸Test task')
    expect(snapped('#‸# Heading line')).toBe('## ‸Heading line')
  })

  it('leaves both edges, and the text, alone', () => {
    expect(snapped('‸- [ ] Test task')).toBe('‸- [ ] Test task')
    expect(snapped('- [ ] ‸Test task')).toBe('- [ ] ‸Test task')
    expect(snapped('## Heading ‸line')).toBe('## Heading ‸line')
  })

  it('leaves a visible number, and a code block, alone', () => {
    expect(snapped('1.‸ numbered')).toBe('1.‸ numbered')
    expect(snapped('```\n  ‸- not a bullet\n```')).toBe('```\n  ‸- not a bullet\n```')
  })
})

describe('planEnter', () => {
  it('leaves the caret alone where nothing is hidden around it', () => {
    expect(planEnter(st('a plain line‸'))).toBe(null)
    expect(planEnter(st('a plain ‸line'))).toBe(null)
    expect(planEnter(st('- [ ] a ‸task'))).toBe(null)
    expect(planEnter(st('- [ ] a task‸'))).toBe(null)
    expect(planEnter(st('1. ‸numbered'))).toBe(null)
  })

  it('does nothing when there is a selection to replace', () => {
    const s = EditorState.create({ doc: '## Heading', selection: { anchor: 3, head: 7 } })
    expect(planEnter(s)).toBe(null)
  })

  /* In front of the marker: the line goes down, marker and all. */
  it('moves the whole line down from the front edge', () => {
    expect(after('‸- [ ] Task 1')).toBe('\n‸- [ ] Task 1')
    expect(after('‸- a bullet')).toBe('\n‸- a bullet')
    expect(after('‸## Heading line')).toBe('\n‸## Heading line')
  })

  /* And the caret rides down with it, so a second Enter does the same again. */
  it('keeps the caret on the front edge, ready to do it again', () => {
    expect(after('\n‸- [ ] Task 1')).toBe('\n\n‸- [ ] Task 1')
  })

  /* Behind the marker: another item like this one, above. */
  it('opens another item of the same kind from the text edge', () => {
    expect(after('- [ ] ‸Task 1')).toBe('- [ ] \n- [ ] ‸Task 1')
    expect(after('- ‸a bullet')).toBe('- \n- ‸a bullet')
    expect(after('  - [x] ‸done')).toBe('  - [x] \n  - [x] ‸done')
  })

  /*
   * A heading has no marker drawn for it, so its one edge answers for both: the
   * heading goes down with its words and leaves blank space above.
   */
  it('takes a heading down with its words from either edge', () => {
    expect(after('## ‸Heading line')).toBe('\n## ‸Heading line')
    expect(after('# ‸Title')).toBe('\n# ‸Title')
  })

  /*
   * An item with nothing in it yet is still an item: Enter behind its marker
   * makes another one. Markdown's own Enter would end the list here, and that
   * way out is Backspace instead — which is what says "no more checkboxes" in
   * so many words.
   */
  it('opens another item from an empty one, rather than ending the list', () => {
    expect(after('- [ ] ‸')).toBe('- [ ] \n- [ ] ‸')
    expect(after('- ‸')).toBe('- \n- ‸')
  })

  it('leaves an empty heading to start the line below it', () => {
    expect(planEnter(st('## ‸'))).toBe(null)
  })

  /*
   * `==phrase|==` and `==phrase==|` are the same pixel with the `==` hidden.
   * Splitting at the first left the closing pair stranded on the next line.
   */
  it('steps over a closing inline delimiter', () => {
    expect(after('==Highlighted phrase‸==')).toBe('==Highlighted phrase==‸')
    expect(after('**bold‸** and more')).toBe('**bold**‸ and more')
    expect(after('`code‸`')).toBe('`code`‸')
  })

  it('steps out of nested closing delimiters at once', () => {
    expect(after('**==word‸==**')).toBe('**==word==**‸')
  })

  it('steps back in front of an opening delimiter', () => {
    expect(after('==‸phrase== tail')).toBe('‸==phrase== tail')
  })

  it('leaves code blocks alone, where the fences are text and are shown', () => {
    expect(planEnter(st('```js\n‸const a = 1\n```'))).toBe(null)
    expect(planEnter(st('```\n- ‸[ ] not a task\n```'))).toBe(null)
  })
})

describe('planBackspace', () => {
  /* In front of the marker: the line comes back up, marker and all. */
  it('moves the whole line up from the front edge', () => {
    expect(backspace('intro\n\n‸- [ ] Task 1')).toBe('intro\n‸- [ ] Task 1')
    expect(backspace('\n‸- [ ] Task 1')).toBe('‸- [ ] Task 1')
    expect(backspace('intro\n\n‸## Heading line')).toBe('intro\n‸## Heading line')
  })

  /*
   * With text directly above there is no space to take, so the lines join —
   * and a line that has joined another can only carry one style.
   */
  it('joins with the line above when there is no space between them', () => {
    expect(backspace('intro\n‸- [ ] Task 1')).toBe('intro‸Task 1')
  })

  it('has nothing to do at the very top of a note', () => {
    expect(backspace('‸- [ ] Task 1')).toBe(null)
  })

  /*
   * Behind the marker: the marker itself, all of it. Half of `- [ ] ` is not
   * anything — `- [ ]` without its trailing space is a bullet reading "[ ]".
   */
  it('takes the whole marker off from the text edge', () => {
    expect(backspace('- [ ] ‸a task')).toBe('‸a task')
    expect(backspace('- ‸a bullet')).toBe('‸a bullet')
    expect(backspace('- [ ] ‸')).toBe('‸')
    // Even with space above it: that edge is behind the marker, not in front.
    expect(backspace('intro\n\n- [ ] ‸a task')).toBe('intro\n\n‸a task')
  })

  /*
   * A heading has no marker to be behind, so its one edge does both, in that
   * order — until the blank line above is gone, Backspace has not reached the
   * top of anything, and taking the style off cannot be undone by the same key.
   */
  it('takes a blank line above a heading before it takes the heading', () => {
    expect(backspace('intro\n\n## ‸Heading line')).toBe('intro\n## ‸Heading line')
    expect(backspace('intro\n## ‸Heading line')).toBe('intro\n‸Heading line')
    expect(backspace('## ‸Heading line')).toBe('‸Heading line')
    expect(backspace('> ‸quoted')).toBe('‸quoted')
  })

  it('leaves every other position to the ordinary Backspace', () => {
    expect(backspace('## Heading ‸line')).toBe(null)
    expect(backspace('‸plain line')).toBe(null)
    expect(backspace('plain ‸line')).toBe(null)
    expect(backspace('1. ‸numbered')).toBe(null)
    expect(backspace('```\n- ‸[ ] not a task\n```')).toBe(null)
  })
})

describe('planDelete', () => {
  /*
   * One press used to turn `intro`, a blank line and a heading into the single
   * paragraph `introHeading line` — a blank line and a paragraph style gone
   * together, with nothing on screen to say the second thing had happened.
   */
  it('takes the blank line first, leaving the heading below it', () => {
    expect(forwardDelete('intro‸\n\n## Heading line')).toBe('intro\n## Heading line')
    // The same one line break, with nothing at all under it.
    expect(forwardDelete('intro‸\n')).toBe('intro')
  })

  it('then pulls the line up, which can only carry one style', () => {
    expect(forwardDelete('intro‸\n## Heading line')).toBe('introHeading line')
    expect(forwardDelete('intro‸\n- [ ] a task')).toBe('introa task')
  })

  /* An empty line has no style to impose, so what comes up keeps its own. */
  it('lets a prefixed line keep its markers when it moves up into nothing', () => {
    expect(forwardDelete('‸\n## Heading line')).toBe('## Heading line')
  })

  it('leaves every other position to the ordinary Delete', () => {
    expect(forwardDelete('intro‸\nplain line')).toBe(null)
    expect(forwardDelete('int‸ro\n## Heading line')).toBe(null)
    expect(forwardDelete('last line‸')).toBe(null)
  })
})
