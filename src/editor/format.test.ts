/**
 * The formatting rules behind the Rich Text toolbar.
 *
 * These run against a bare EditorState — no DOM, no view — because that is
 * exactly what the commands are: text edits on markdown. `‸` marks the caret in
 * these fixtures and `«…»` marks a selection.
 */

import { describe, expect, it } from 'vitest'
import { EditorState, type TransactionSpec } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import {
  expandToMarkup,
  indentList,
  inspect,
  parseLine,
  scanInline,
  setBlockStyle,
  toggleInline,
  toggleList,
  toggleQuote,
} from './format'

/**
 * Build a state from a fixture, stripping the caret/selection markers.
 *
 * With the markdown language in it, because one of these rules asks the parser
 * what kind of block a position is in rather than deciding for itself — and a
 * state with no parse would answer "not code" to everything and quietly pass
 * the tests that are here to catch exactly that.
 */
function st(fixture: string): EditorState {
  const extensions = [markdown({ base: markdownLanguage })]
  const caret = fixture.indexOf('‸')
  if (caret >= 0) {
    const doc = fixture.replace('‸', '')
    return EditorState.create({ doc, selection: { anchor: caret }, extensions })
  }
  const from = fixture.indexOf('«')
  const to = fixture.indexOf('»') - 1
  const doc = fixture.replace('«', '').replace('»', '')
  return EditorState.create({ doc, selection: { anchor: from, head: to }, extensions })
}

/** Apply a spec and render the result with the caret/selection marked. */
function out(state: EditorState, spec: TransactionSpec | null): string {
  if (!spec) return state.doc.toString()
  const tr = state.update(spec)
  const text = tr.state.doc.toString()
  const { from, to } = tr.state.selection.main
  return from === to
    ? `${text.slice(0, from)}‸${text.slice(from)}`
    : `${text.slice(0, from)}«${text.slice(from, to)}»${text.slice(to)}`
}

/** Result text only, for cases where the selection is not the point. */
function text(state: EditorState, spec: TransactionSpec | null): string {
  return spec ? state.update(spec).state.doc.toString() : state.doc.toString()
}

describe('parseLine', () => {
  it('splits every markdown prefix off the content', () => {
    expect(parseLine('  - [x] done')).toMatchObject({
      indent: '  ',
      marker: '- ',
      task: '[x] ',
      markerKind: 'check',
      content: 'done',
    })
    expect(parseLine('> ## Quoted heading')).toMatchObject({
      quote: '> ',
      level: 2,
      content: 'Quoted heading',
    })
    expect(parseLine('3) third')).toMatchObject({ markerKind: 'number', marker: '3) ' })
    expect(parseLine('plain text')).toMatchObject({ level: 0, markerKind: null, quote: '' })
  })

  it('does not mistake a horizontal rule for a bullet', () => {
    expect(parseLine('---').markerKind).toBe(null)
  })
})

describe('block styles', () => {
  it('applies and replaces heading levels', () => {
    expect(text(st('Groceries‸'), setBlockStyle(st('Groceries‸'), 'title'))).toBe('# Groceries')
    const h1 = st('# Groceries‸')
    expect(text(h1, setBlockStyle(h1, 'heading'))).toBe('## Groceries')
    const h3 = st('### Groceries‸')
    expect(text(h3, setBlockStyle(h3, 'body'))).toBe('Groceries')
  })

  it('keeps the caret in the text when the prefix changes', () => {
    const s = st('# Trip‸')
    expect(out(s, setBlockStyle(s, 'heading'))).toBe('## Trip‸')
  })

  it('keeps the caret in the text when the marker goes in front of it', () => {
    const s = st('‸Trip')
    expect(out(s, setBlockStyle(s, 'heading'))).toBe('## ‸Trip')
    const q = st('‸thought')
    expect(out(q, toggleQuote(q))).toBe('> ‸thought')
  })

  it('keeps indent and quote, and drops a list marker', () => {
    const q = st('> note‸')
    expect(text(q, setBlockStyle(q, 'heading'))).toBe('> ## note')
    const li = st('- item‸')
    expect(text(li, setBlockStyle(li, 'title'))).toBe('# item')
  })

  it('styles every line of a selection', () => {
    const s = st('«one\ntwo\nthree»')
    expect(text(s, setBlockStyle(s, 'subheading'))).toBe('### one\n### two\n### three')
  })

  it('reports nothing to do when the style is already set', () => {
    const s = st('## Heading‸')
    expect(setBlockStyle(s, 'heading')).toBe(null)
  })
})

describe('lists', () => {
  it('turns a line into a bullet and back', () => {
    const s = st('milk‸')
    expect(text(s, toggleList(s, 'bullet'))).toBe('- milk')
    const b = st('- milk‸')
    expect(text(b, toggleList(b, 'bullet'))).toBe('milk')
  })

  it('converts between list kinds', () => {
    const b = st('- milk‸')
    expect(text(b, toggleList(b, 'number'))).toBe('1. milk')
    const n = st('1. milk‸')
    expect(text(n, toggleList(n, 'check'))).toBe('- [ ] milk')
    const c = st('- [x] milk‸')
    expect(text(c, toggleList(c, 'bullet'))).toBe('- milk')
  })

  it('numbers a selection sequentially', () => {
    const s = st('«milk\neggs\nbread»')
    expect(text(s, toggleList(s, 'number'))).toBe('1. milk\n2. eggs\n3. bread')
  })

  it('continues the numbering of the list it joins', () => {
    const s = st('1. milk\n2. eggs\nbread‸')
    expect(text(s, toggleList(s, 'number'))).toBe('1. milk\n2. eggs\n3. bread')
  })

  it('leaves the caret after the marker, ready to type', () => {
    // The reason this matters: on an empty line the caret sits exactly where
    // the marker is inserted, and the default mapping would leave it in front
    // of the checkbox — so the first word typed lands before it.
    const empty = st('‸')
    expect(out(empty, toggleList(empty, 'check'))).toBe('- [ ] ‸')
    const start = st('‸milk')
    expect(out(start, toggleList(start, 'check'))).toBe('- [ ] ‸milk')
    const bullet = st('‸milk')
    expect(out(bullet, toggleList(bullet, 'bullet'))).toBe('- ‸milk')
    // And back out again, with the caret still against the text.
    const done = st('- [ ] ‸milk')
    expect(out(done, toggleList(done, 'check'))).toBe('‸milk')
  })

  it('quotes and unquotes', () => {
    const s = st('thought‸')
    expect(text(s, toggleQuote(s))).toBe('> thought')
    const q = st('> thought‸')
    expect(text(q, toggleQuote(q))).toBe('thought')
  })
})

describe('nesting', () => {
  it('indents and outdents list items', () => {
    const s = st('- item‸')
    expect(text(s, indentList(s, 1))).toBe('  - item')
    const nested = st('  - item‸')
    expect(text(nested, indentList(nested, -1))).toBe('- item')
  })

  it('leaves prose alone, where four spaces would mean a code block', () => {
    const s = st('just a paragraph‸')
    expect(indentList(s, 1)).toBe(null)
  })
})

describe('inline marks', () => {
  it('wraps a selection', () => {
    const s = st('make «this» bold')
    expect(out(s, toggleInline(s, 'bold'))).toBe('make **«this»** bold')
  })

  it('unwraps when the caret sits inside the span', () => {
    const s = st('make **th‸is** bold')
    expect(out(s, toggleInline(s, 'bold'))).toBe('make th‸is bold')
  })

  /*
   * The toggle has to be an exact round trip. It was not: unwrapping left the
   * anchor where it stood while the text moved back two characters under it,
   * so highlighting and unhighlighting the same phrase repeatedly ate it two
   * characters at a time, without the user touching the selection.
   */
  it('gives back exactly the selection it wrapped', () => {
    let s = st('«Some» sample words')
    for (let i = 0; i < 4; i++) {
      expect(out(s, toggleInline(s, 'highlight'))).toBe('==«Some»== sample words')
      s = s.update(toggleInline(s, 'highlight')).state
      expect(out(s, toggleInline(s, 'highlight'))).toBe('«Some» sample words')
      s = s.update(toggleInline(s, 'highlight')).state
    }
  })

  it('keeps a caret against the same character when the wrapper goes', () => {
    expect(out(st('a **bo‸ld** b'), toggleInline(st('a **bo‸ld** b'), 'bold'))).toBe('a bo‸ld b')
    expect(out(st('a **‸bold** b'), toggleInline(st('a **‸bold** b'), 'bold'))).toBe('a ‸bold b')
    expect(out(st('a **bold‸** b'), toggleInline(st('a **bold‸** b'), 'bold'))).toBe('a bold‸ b')
  })

  it('wraps the word under a bare caret', () => {
    const s = st('make thi‸s bold')
    expect(text(s, toggleInline(s, 'italic'))).toBe('make *this* bold')
  })

  it('leaves an empty pair to type into when there is no word', () => {
    const s = st('start ‸')
    expect(out(s, toggleInline(s, 'bold'))).toBe('start **‸**')
  })

  it('uses HTML for underline, which markdown has no syntax for', () => {
    const s = st('«note»')
    expect(text(s, toggleInline(s, 'underline'))).toBe('<u>note</u>')
    const u = st('<u>no‸te</u>')
    expect(text(u, toggleInline(u, 'underline'))).toBe('note')
  })

  it('does not read bold as an empty italic', () => {
    const spans = scanInline('a **bold** b')
    expect(spans.map((s) => s.mark)).toEqual(['bold'])
  })

  it('finds nested marks', () => {
    const spans = scanInline('**bold with *italic* inside**')
    expect(spans.map((s) => s.mark).sort()).toEqual(['bold', 'italic'])
  })

  it('treats code content as literal', () => {
    expect(scanInline('`a *b* c`').map((s) => s.mark)).toEqual(['code'])
  })
})

describe('expandToMarkup', () => {
  const range = (fixture: string) => {
    const s = st(fixture)
    const { from, to } = s.selection.main
    const g = expandToMarkup(s, from, to)
    const doc = s.doc.toString()
    return `${doc.slice(0, g.from)}«${doc.slice(g.from, g.to)}»${doc.slice(g.to)}`
  }

  it('takes in the delimiters a selection sits exactly inside', () => {
    expect(range('a ==«word»== b')).toBe('a «==word==» b')
    expect(range('a **«word»** b')).toBe('a «**word**» b')
  })

  it('unwraps nested marks one layer at a time', () => {
    expect(range('**==«word»==**')).toBe('«**==word==**»')
  })

  /*
   * A selection can run across several constructs, and every one whose visible
   * text it takes in full leaves its delimiters behind. Cutting the visible
   * text of `**bold** and *italic*` left `***` — the opener of the first and
   * the closer of the second, orphaned by a rule that only widened when both
   * edges matched one span.
   */
  it('takes in every span whose visible text the selection covers', () => {
    expect(range('**«bold** and *italic»*')).toBe('«**bold** and *italic*»')
    expect(range('**«bold** and more»')).toBe('«**bold** and more»')
    expect(range('a **«bold** b»')).toBe('a «**bold** b»')
  })

  it('reaches a span on the last line of a selection that spans lines', () => {
    // The scan only ever looked at the line the selection started on, so a
    // closer on any later line was left behind.
    expect(range('**«bold**\nand *italic»*')).toBe('«**bold**\nand *italic*»')
  })

  it('knows the underscore spellings, which the editor renders the same', () => {
    // `__bold__` is StrongEmphasis and `_italic_` is Emphasis to the parser
    // that draws them — but the scanner knew only the asterisk spellings, so
    // cutting the visible word left `____` behind.
    expect(range('a __«word»__ b')).toBe('a «__word__» b')
    expect(range('a _«word»_ b')).toBe('a «_word_» b')
  })

  it('but not an underscore inside a word, which nothing renders', () => {
    // `foo_bar_baz` is one plain word to CommonMark. Widening over it would
    // invent a construct the editor never drew.
    expect(range('a foo_«bar»_baz b')).toBe('a foo_«bar»_baz b')
  })

  it('leaves everything inside a fenced block alone', () => {
    /*
     * In a code block the asterisks are the point — they are what the sample
     * is showing. Widening over them meant selecting `literal` and pasting
     * replaced `**literal**`, deleting two pairs of characters nobody had
     * selected, in the one place in a note where markup is not markup.
     */
    expect(range('```\n**«literal»**\n```')).toBe('```\n**«literal»**\n```')
    expect(range('```\n# «Heading»\n```')).toBe('```\n# «Heading»\n```')
    // And still widens in the prose on either side of one.
    expect(range('```\ncode\n```\n\na ==«word»== b')).toBe('```\ncode\n```\n\na «==word==» b')
  })

  /*
   * A code block is not only three backticks in column one, and a guard that
   * thought so protected the one spelling it recognised. An indented block
   * lost its asterisks *and* its indentation — the leading spaces being read
   * as a line prefix with content after it — and a fenced block inside a
   * blockquote lost its `> ` as well, which is the whole quote.
   */
  it('leaves an indented code block alone too', () => {
    expect(range('text\n\n    **«literal»**\n')).toBe('text\n\n    **«literal»**\n')
    expect(range('text\n\n    # «Heading»\n')).toBe('text\n\n    # «Heading»\n')
  })

  it('and a fenced block inside a blockquote', () => {
    expect(range('> ```\n> **«literal»**\n> ```\n')).toBe('> ```\n> **«literal»**\n> ```\n')
    // The quote's own prose still widens, markers and all: `> ` is a prefix
    // there, and cutting the whole line of it should not leave one behind.
    expect(range('> a ==«word»== b\n')).toBe('> a «==word==» b\n')
  })

  /*
   * The trap in every rule of the "four spaces means code" kind, and the
   * reason this reads the editor's own parse instead of counting spaces: a
   * nested list is indented too, and after a blank line it is indented past
   * the four a hand-written rule would have called code. It is a list, its
   * markup is markup, and widening there has to go on working.
   */
  it('and still widens in a nested list, which is indented and is not code', () => {
    expect(range('- item\n    - sub ==«word»== here\n')).toBe(
      '- item\n    - sub «==word==» here\n',
    )
    expect(range('- item\n\n    - sub ==«word»== here\n')).toBe(
      '- item\n\n    - sub «==word==» here\n',
    )
  })

  it('leaves a selection that covers only part of a span', () => {
    expect(range('a ==w«or»d== b')).toBe('a ==w«or»d== b')
    expect(range('a «==word==» b')).toBe('a «==word==» b')
    expect(range('«a ==word== b»')).toBe('«a ==word== b»')
  })

  /*
   * The line's own markers, for the same reason: Home-then-Shift-End on a
   * heading can only ever select the words, so the copy came out plain and a
   * cut left the `## ` behind on a line of its own.
   */
  it('takes in the markers at the head of the line', () => {
    expect(range('## «Heading line»')).toBe('«## Heading line»')
    expect(range('- [ ] «a task»')).toBe('«- [ ] a task»')
    expect(range('> «quoted»')).toBe('«> quoted»')
    expect(range('## «Heading line\nand the line below»')).toBe(
      '«## Heading line\nand the line below»',
    )
  })

  it('and both at once, when the whole line is one highlight', () => {
    expect(range('## ==«Heading line»==')).toBe('«## ==Heading line==»')
  })

  it('leaves a selection that starts inside the line alone', () => {
    expect(range('## Heading «line»')).toBe('## Heading «line»')
    expect(range('## «Heading» line')).toBe('## «Heading» line')
  })
})

describe('inspect', () => {
  it('reports what is active at the caret', () => {
    const s = st('## Plans‸')
    expect(inspect(s)).toMatchObject({ block: 'heading', list: null, quote: false })

    const l = st('- [ ] buy **mi‸lk**')
    const snap = inspect(l)
    expect(snap.list).toBe('check')
    expect(snap.marks.bold).toBe(true)
    expect(snap.marks.italic).toBe(false)
    expect(snap.canIndent).toBe(true)
    expect(snap.canOutdent).toBe(false)
  })

  it('reports body for plain prose', () => {
    expect(inspect(st('just writing‸')).block).toBe('body')
  })
})
