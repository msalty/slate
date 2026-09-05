/**
 * The caret, where the markup around it is invisible.
 *
 * Same fixture notation as format.test.ts: `‸` is the caret. What is checked is
 * mostly where the caret is *taken* — before a newline goes in, or instead of
 * the characters a deletion would otherwise have eaten — because that is the
 * whole of the fix; the edits themselves are still markdown's own commands.
 */

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { breakAbove, planBackspace, planDelete, planEnter, snapOutOfPrefix } from './caret'

function st(fixture: string): EditorState {
  const caret = fixture.indexOf('‸')
  return EditorState.create({
    doc: fixture.replace('‸', ''),
    selection: caret < 0 ? undefined : { anchor: caret },
    // The plan consults the syntax tree to leave code blocks alone.
    extensions: [markdown({ base: markdownLanguage })],
  })
}

/** Where the caret ends up, marked in the resulting document. */
function after(fixture: string): string {
  const state = st(fixture)
  const plan = planEnter(state)
  if (!plan) return fixture
  if (plan.kind === 'break-above') {
    const tr = state.update(breakAbove(state, plan.prefix))
    const text = tr.state.doc.toString()
    const at = tr.state.selection.main.from
    return `${text.slice(0, at)}‸${text.slice(at)}`
  }
  const text = state.doc.toString()
  return `${text.slice(0, plan.to)}‸${text.slice(plan.to)}`
}

describe('planEnter', () => {
  it('leaves the caret alone where nothing is hidden around it', () => {
    expect(planEnter(st('a plain line‸'))).toBe(null)
    expect(planEnter(st('a plain ‸line'))).toBe(null)
    expect(planEnter(st('- [ ] a ‸task'))).toBe(null)
    expect(planEnter(st('- [ ] a task‸'))).toBe(null)
  })

  it('does nothing when there is a selection to replace', () => {
    const s = EditorState.create({ doc: '## Heading', selection: { anchor: 3, head: 7 } })
    expect(planEnter(s)).toBe(null)
  })

  it('moves out of a line prefix onto the text', () => {
    expect(after('> ‸thought')).toBe('> ‸thought')
    expect(after('‸> thought')).toBe('> ‸thought')
    expect(after('‸1. numbered')).toBe('1. ‸numbered')
  })

  it('sends an empty item to the end of its own marker, so Enter ends the list', () => {
    expect(after('- ‸[ ] ')).toBe('- [ ] ‸')
    expect(planEnter(st('- [ ] ‸'))).toBe(null)
  })

  /*
   * The reported bug: the caret between a hidden `- ` and a hidden `[ ] `, two
   * positions that draw at the same pixel, produced `- ⏎[ ] Test task`. The
   * item gets an empty one of itself above — with the space after `[ ]` that
   * markdown's own Enter would have trimmed, without which it is not a task.
   */
  it('opens an empty item of the same kind above a list item', () => {
    expect(after('- ‸[ ] Test task')).toBe('- [ ] \n- [ ] ‸Test task')
    expect(after('‸- [ ] Test task')).toBe('- [ ] \n- [ ] ‸Test task')
    expect(after('- [ ] ‸Test task')).toBe('- [ ] \n- [ ] ‸Test task')
    expect(after('  - ‸nested')).toBe('  - \n  - ‸nested')
  })

  /* A heading moves down with its words rather than being left behind. */
  it('pushes a heading down when Enter is pressed at the start of its text', () => {
    expect(after('## ‸Heading line')).toBe('\n## ‸Heading line')
    expect(after('# ‸Title')).toBe('\n# ‸Title')
    expect(after('‸## Heading line')).toBe('\n## ‸Heading line')
  })

  it('starts a new line below an empty heading instead', () => {
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

describe('snapOutOfPrefix', () => {
  /** The caret, marked where it would actually end up. */
  const snapped = (fixture: string) => {
    const state = st(fixture)
    const at = snapOutOfPrefix(state, state.selection.main.from)
    const text = state.doc.toString()
    return `${text.slice(0, at)}‸${text.slice(at)}`
  }

  /*
   * The position Home lands on in a checklist line: the bullet before it is
   * hidden and the checkbox after it is a widget, so the first place with any
   * geometry is between the two. Backspace there used to take the `- ` and
   * leave `[ ] a task` — a bullet with the characters of a checkbox in it.
   */
  it('takes a caret inside a hidden prefix to the start of the text', () => {
    expect(snapped('- ‸[ ] Test task')).toBe('- [ ] ‸Test task')
    expect(snapped('#‸# Heading line')).toBe('## ‸Heading line')
    expect(snapped('>‸ quoted')).toBe('> ‸quoted')
  })

  it('leaves the start of the line itself alone, so a copy still gets the prefix', () => {
    expect(snapped('‸## Heading line')).toBe('‸## Heading line')
  })

  it('leaves alone a caret that is already in the text', () => {
    expect(snapped('## Heading ‸line')).toBe('## Heading ‸line')
    expect(snapped('plain ‸line')).toBe('plain ‸line')
  })

  it('leaves code blocks alone, where the indentation is code', () => {
    expect(snapped('```\n  ‸- not a bullet\n```')).toBe('```\n  ‸- not a bullet\n```')
  })
})

describe('planBackspace', () => {
  /** The document after the deletion, or the fixture when there is none. */
  const del = (fixture: string, plan: typeof planBackspace) => {
    const state = st(fixture)
    const spec = plan(state)
    return spec ? state.update(spec).state.doc.toString() : null
  }

  /*
   * The reported bug: the blank line an Enter opened above a heading stayed,
   * and the heading itself came off instead — so Backspace could not undo the
   * Enter that had just been pressed.
   */
  it('takes a blank line above before it takes the heading', () => {
    expect(del('intro\n\n## ‸Heading line', planBackspace)).toBe('intro\n## Heading line')
    expect(del('\n## ‸Heading line', planBackspace)).toBe('## Heading line')
    expect(del('intro\n\n- [ ] ‸a task', planBackspace)).toBe('intro\n- [ ] a task')
  })

  it('then takes one layer of prefix off, the way the format bar would', () => {
    expect(del('## ‸Heading line', planBackspace)).toBe('Heading line')
    expect(del('intro\n## ‸Heading line', planBackspace)).toBe('intro\nHeading line')
    expect(del('> ## ‸Quoted heading', planBackspace)).toBe('> Quoted heading')
    expect(del('> ‸quoted', planBackspace)).toBe('quoted')
  })

  /* All of `- [ ] `, not the bullet on its own: half of it is not anything. */
  it('takes a whole checkbox off rather than stranding its brackets', () => {
    expect(del('- [ ] ‸a task', planBackspace)).toBe('a task')
    expect(del('- ‸a bullet', planBackspace)).toBe('a bullet')
  })

  it('leaves every other position to the ordinary Backspace', () => {
    expect(del('## Heading ‸line', planBackspace)).toBe(null)
    expect(del('‸plain line', planBackspace)).toBe(null)
    expect(del('plain ‸line', planBackspace)).toBe(null)
    expect(del('```\n- ‸[ ] not a task\n```', planBackspace)).toBe(null)
  })
})

describe('planDelete', () => {
  const del = (fixture: string) => {
    const state = st(fixture)
    const spec = planDelete(state)
    return spec ? state.update(spec).state.doc.toString() : null
  }

  /*
   * One press used to turn `intro`, a blank line and a heading into the single
   * paragraph `introHeading line` — a blank line and a paragraph style gone
   * together, with nothing on screen to say the second thing had happened.
   */
  it('takes the blank line first, leaving the heading below it', () => {
    expect(del('intro‸\n\n## Heading line')).toBe('intro\n## Heading line')
    // The same one line break, with nothing at all under it.
    expect(del('intro‸\n')).toBe('intro')
  })

  it('then pulls the line up, which can only carry one style', () => {
    expect(del('intro‸\n## Heading line')).toBe('introHeading line')
    expect(del('intro‸\n- [ ] a task')).toBe('introa task')
  })

  /* An empty line has no style to impose, so what comes up keeps its own. */
  it('lets a prefixed line keep its markers when it moves up into nothing', () => {
    expect(del('‸\n## Heading line')).toBe('## Heading line')
  })

  it('leaves every other position to the ordinary Delete', () => {
    expect(del('intro‸\nplain line')).toBe(null)
    expect(del('int‸ro\n## Heading line')).toBe(null)
    expect(del('last line‸')).toBe(null)
  })
})
