/**
 * Markdown introspection: frontmatter, wikilinks, embeds, tags, tasks.
 *
 * These are deliberately regex-level rather than a full parse. The index is
 * rebuilt on every save, so this runs often and must stay cheap; and being
 * lenient here is safer than being strict — a link the parser misses is a
 * broken feature, but a note it refuses is lost work.
 */

import { WIKI_SOURCE, splitWikiInner, unescapeWiki } from './wikilink'
import { normPath, parseYmd, splitInlineList, startOfDay, titleFromPath, unquote, ymd } from './util'

/** What a single frontmatter key can hold, once parsed. */
export type FrontmatterValue = string | string[] | boolean | number

export interface Frontmatter {
  data: Record<string, FrontmatterValue>
  /** Character offset in the source where the body begins. */
  bodyStart: number
  raw: string
}

/** Parse a leading `---` YAML-ish block. Supports scalars and `[a, b]` / `- a` lists. */
export function parseFrontmatter(text: string): Frontmatter {
  if (!text.startsWith('---')) return { data: {}, bodyStart: 0, raw: '' }
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!m) return { data: {}, bodyStart: 0, raw: '' }
  const data: Record<string, FrontmatterValue> = {}
  let lastKey: string | undefined
  for (const line of m[1].split(/\r?\n/)) {
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item && lastKey) {
      const prev = data[lastKey]
      const arr = Array.isArray(prev) ? prev : prev === '' || prev === undefined ? [] : [String(prev)]
      arr.push(unquote(item[1]))
      data[lastKey] = arr
      continue
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    lastKey = kv[1]
    const rawVal = kv[2].trim()
    if (rawVal === '') {
      data[lastKey] = ''
    } else if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
      // Quote-aware: a comma inside `"Doe, Jane"` is part of the name.
      data[lastKey] = splitInlineList(rawVal.slice(1, -1)).map(unquote).filter(Boolean)
    } else if (rawVal === 'true' || rawVal === 'false') {
      data[lastKey] = rawVal === 'true'
    } else if (/^-?\d+(\.\d+)?$/.test(rawVal)) {
      data[lastKey] = Number(rawVal)
    } else {
      data[lastKey] = unquote(rawVal)
    }
  }
  return { data, bodyStart: m[0].length, raw: m[0] }
}

/** Replace or insert a single frontmatter key, preserving everything else. */
export function setFrontmatterKey(text: string, key: string, value: string): string {
  const fm = parseFrontmatter(text)
  const line = `${key}: ${/[:#\-[\]{}]|^\s|\s$/.test(value) ? JSON.stringify(value) : value}`
  if (!fm.raw) return `---\n${line}\n---\n\n${text}`
  const inner = fm.raw.replace(/^---\r?\n/, '').replace(/\r?\n---[ \t]*\r?\n?$/, '')
  const lines = inner.split(/\r?\n/)
  const idx = lines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l))
  if (idx >= 0) lines[idx] = line
  else lines.push(line)
  return `---\n${lines.join('\n')}\n---\n${text.slice(fm.bodyStart)}`
}

/**
 * Replace or insert a frontmatter key holding a list of values.
 *
 * Written in the block form — `key:` then `  - "value"` — rather than the flow
 * form `key: [a, b]`, for one reason: the flow reader splits on commas, so a
 * value containing one comes back in two pieces. A note called
 * `Plan, revised` is an ordinary note name, and losing it to punctuation would
 * be the kind of silent failure this list format exists to avoid.
 *
 * Every value is quoted, because the values this was written for are wikilinks
 * and YAML reads a bare `[[A]]` as a nested sequence.
 *
 * An empty list removes the key rather than leaving `key: []` behind — a key
 * that holds nothing is a key somebody has to work out the meaning of later.
 */
export function setFrontmatterList(text: string, key: string, values: string[]): string {
  const clean = values.map((v) => v.trim()).filter(Boolean)
  const block = [`${key}:`, ...clean.map((v) => `  - ${JSON.stringify(v)}`)]
  const fm = parseFrontmatter(text)
  if (!fm.raw) return clean.length ? `---\n${block.join('\n')}\n---\n\n${text}` : text

  const inner = fm.raw.replace(/^---\r?\n/, '').replace(/\r?\n---[ \t]*\r?\n?$/, '')
  const lines = inner.split(/\r?\n/)
  const idx = lines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l))
  if (idx >= 0) {
    // A block list's `- item` lines belong to the key above them, so they are
    // replaced with it. Left behind, they would reattach to whichever key ended
    // up above them and quietly become part of a different list.
    let end = idx + 1
    while (end < lines.length && /^\s*-\s+/.test(lines[end])) end++
    lines.splice(idx, end - idx, ...(clean.length ? block : []))
  } else if (clean.length) {
    lines.push(...block)
  }
  // Removing the only key leaves an empty block, which is worse than no block.
  if (!lines.length) return text.slice(fm.bodyStart)
  return `---\n${lines.join('\n')}\n---\n${text.slice(fm.bodyStart)}`
}

/* --------------------------------------------------------------- variables */

/**
 * `$(key)` — a frontmatter value, written into the body of the note.
 *
 * The note file keeps the token; only the rendered views swap it for the
 * value, which is what makes it safe: nothing rewrites the file, and a note
 * carrying these opens in any other markdown editor as the text that was
 * typed. That is the same bargain live preview makes everywhere else.
 *
 * `$(...)` rather than `{{...}}` on purpose. Templates already use `{{title}}`
 * and `{{date}}`, and those are expanded *once*, when the note is made; this
 * one is resolved every time the note is drawn. Two different things deserve
 * two different shapes.
 *
 * The key charset is the one `parseFrontmatter` accepts, so anything nameable
 * in the properties form is nameable here.
 */
const VAR = /\$\(([A-Za-z0-9_.-]+)\)/g

export interface VarRef {
  from: number
  to: number
  key: string
}

/** Every `$(key)` in `text`, with positions offset by `offset`. */
export function scanVars(text: string, offset = 0): VarRef[] {
  const out: VarRef[] = []
  VAR.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = VAR.exec(text))) {
    out.push({ from: offset + m.index, to: offset + m.index + m[0].length, key: m[1] })
  }
  return out
}

/**
 * A single-backtick span: the one place a `$(key)` is left as it was typed.
 *
 * Which is what makes the syntax writable about — a note explaining
 * `$(client)` has to be able to say it — and it is single backticks alone, so
 * that a fenced block, whose fences are three, still fills itself in. A span
 * cannot cross a line, which is also what keeps a lone backtick in prose from
 * swallowing the rest of the paragraph.
 */
const INLINE_CODE = /(?<!`)`[^`\n]+`(?!`)/g

/**
 * Swap every `$(key)` this data can answer for. Anything else is left alone —
 * a name nobody declared, and a property still waiting to be filled in, both
 * stay as the text they are, because both are still questions. So is anything
 * in backticks.
 */
export function resolveVars(text: string, data: Record<string, FrontmatterValue>): string {
  const swap = (chunk: string) => {
    VAR.lastIndex = 0
    return chunk.replace(VAR, (raw, key: string) => (key in data ? (varText(data[key]) ?? raw) : raw))
  }
  let out = ''
  let at = 0
  INLINE_CODE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = INLINE_CODE.exec(text))) {
    out += swap(text.slice(at, m.index)) + m[0]
    at = m.index + m[0].length
  }
  return out + swap(text.slice(at))
}

/**
 * How a value reads in a sentence, or `undefined` when there is nothing to
 * read — which the views draw as a blank to fill in rather than as nothing at
 * all, since a template's empty property is the whole point of it.
 *
 * A list joins with commas, because that is how `tags: [travel, lisbon]` is
 * typed into the properties form and how it reads back out. `false` is a
 * value, not a blank.
 */
export function varText(value: FrontmatterValue | undefined): string | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value)) {
    const joined = value.filter((v) => String(v).trim()).join(', ')
    return joined || undefined
  }
  const s = String(value).trim()
  return s || undefined
}

/**
 * The property that makes a note's body read-only.
 *
 * A note carrying it is a form: the properties can be filled in, and nothing
 * else about it can be typed over — no caret, no checkbox to tick, no table
 * cell to edit. That is the point of pairing it with `$(name)`. A page whose
 * every changeable part is a labelled field cannot be knocked out of shape by
 * the person filling it in, and one built to be copied out of stays exactly as
 * it was written.
 *
 * Three spellings, because the hyphen is the one this documents and the other
 * two are what people type. The value is read the way a person means it rather
 * than the way YAML would: the properties form writes `true` for its checkbox,
 * and anyone writing the block by hand writes `yes`.
 */
const LOCK_KEYS = ['read-only', 'readonly', 'read_only']
const LOCK_YES = new Set(['true', 'yes', 'on', '1'])

export function isLocked(data: Record<string, FrontmatterValue>): boolean {
  return LOCK_KEYS.some((k) => {
    const v = data[k]
    if (v === undefined || Array.isArray(v)) return false
    return LOCK_YES.has(String(v).trim().toLowerCase())
  })
}

/* ----------------------------------------------------------------- regions */

/**
 * Byte ranges that must be ignored by link/tag/task scanning: fenced code
 * blocks and inline code. Without this, a `#hashtag` in a code sample becomes a
 * tag and a `[[foo]]` in a snippet becomes a phantom link.
 */
export function codeRegions(text: string): Array<[number, number]> {
  const out = fencedRegions(text)
  const inline = /`+[^`\n]*`+/g
  let m: RegExpExecArray | null
  while ((m = inline.exec(text))) {
    const s = m.index
    if (!out.some(([a, b]) => s >= a && s < b)) out.push([s, s + m[0].length])
  }
  return out
}

/**
 * The fenced blocks alone, without the inline spans.
 *
 * This is the index's answer, not the editor's. The editor asks its own
 * markdown parser, which knows an indented code block from a nested list; this
 * runs over every note in the vault at load and reads the lines. So it stops at
 * what can be read off a line on its own, and an indented block — four spaces,
 * which is also what a nested list and a wrapped list paragraph look like — is
 * deliberately not one of them: calling those code would lose the tags and
 * links people actually write inside lists to catch the few written in an
 * indented sample.
 *
 * What it does have to know is which *container* a fence is in, because both
 * of the questions asked about a fence are asked relative to one: how far its
 * closer may be indented, and where the block ends if no closer comes. Quote
 * markers answer the first container and the list markers walked here answer
 * the second; between them the regions this returns agree with the editor's
 * parser everywhere except the indented blocks above.
 */
function fencedRegions(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let openAt: number | null = null
  let openMark = ''
  let openDepth = 0
  let openContainer = 0
  let pos = 0
  const items: Array<{ depth: number; column: number }> = []

  for (const line of text.split('\n')) {
    let m = FENCE.exec(line)
    // At the backticks, not at the line: the markers before them belong to the
    // quote or the list that holds the block, not to the block.
    let fenceAt = m ? pos + m[1].length : pos
    const depth = quoteDepth(line)
    let fenceDepth = depth
    let fenceColumn = m ? indentColumns(m[1]) : 0
    const indent = indentColumns(INDENT.exec(line)![0])

    /*
     * A block ends where the thing holding it ends. An unclosed fence in the
     * body of a note runs to the end of the note, which is CommonMark and is
     * what somebody halfway through typing a code block should see; a fence
     * inside a blockquote is held by the quote, and ends where the quote does
     * — at a blank line, at an unquoted line, or at one quoted less deeply.
     * Reading the second as the first is how one `> ```` with no closer hid
     * every heading, tag and link below it from the index while the editor
     * went on rendering them: the note looked fine and was not there.
     *
     * At the top level the depth is zero and nothing is ever below it, so the
     * same comparison leaves that case exactly as it was.
     *
     * A list item holds a block the same way, and ends it the same way: at a
     * line that steps back out of the item. Not at a blank line, though, which
     * a list item carries on through where a blockquote does not — the one
     * place these two containers part company.
     */
    if (openAt !== null && (depth < openDepth || (line.trim() !== '' && indent < openContainer))) {
      out.push([openAt, pos])
      openAt = null
    }

    if (openAt === null) {
      /*
       * Which list item this line is in, kept only while no fence is open —
       * inside one the lines are code and say nothing about the note's shape.
       * A line steps back out of every item whose content starts further in
       * than the line does, and each marker on it opens one that starts after
       * that marker.
       */
      if (line.trim()) {
        /*
         * Leaving a blockquote ends the lists written inside it, the same way
         * it ends everything else in there — without that, a `> - item` left
         * its column standing and the next fence in the note, quoted by
         * nobody, was measured against a list it was not in.
         */
        while (items.length) {
          const held = items[items.length - 1]
          const gone = held.depth > depth || (held.depth === depth && indent < held.column)
          if (!gone) break
          items.pop()
        }

        /*
         * Every container the line opens for itself, in the order it opens
         * them. One line can open several — `- - ``` ` is two list items and
         * `- > ``` ` is an item holding a quote — and each moves where the
         * content after it begins, so they have to be walked rather than
         * counted. Reading one and stopping left the rest of the line looking
         * like prose, which for a fence meant no block at all: the sample's
         * tags and links went into the index as the note's own.
         */
        let at = 0
        let held = 0
        let column = 0
        let cursor = 0
        for (;;) {
          const li = LIST_ITEM.exec(line.slice(at))
          if (!li) break
          // A quote opened here restarts the column inside itself; without one
          // the marker is measured from the content it was written in.
          const quotes = quoteDepth(line.slice(at))
          held += quotes
          const base = quotes ? 0 : cursor
          column = contentColumn(li, base)
          /*
           * Where the line's text carries on, which is not always where the
           * item's content begins: a gap of five columns or more puts the
           * item's content one column after the marker and leaves the rest of
           * the gap as indented code inside it. Measuring a fence from the
           * item's column rather than from here opened a block on `-     ``` `,
           * which the parser reads as indented code, and hid what followed.
           */
          cursor = advance(base + indentColumns(li[1]) + li[2].length, li[3])
          items.push({ depth: held, column })
          at += li[0].length
        }

        /*
         * `- ``` ` — a fence as the item's first content, which is where
         * people put one when the whole item is a code sample. The region
         * starts at the fence rather than at the marker, since the marker is
         * the list's and not the block's.
         */
        if (!m && at) {
          const after = FENCE.exec(line.slice(at))
          if (after) {
            m = after
            // Past the markers to the backticks: a `>` between them belongs to
            // the quote, the same way the `- ` belongs to the list.
            fenceAt = pos + at + after[1].length
            const quotes = quoteDepth(line.slice(at))
            fenceDepth = held + quotes
            fenceColumn = (quotes ? 0 : cursor) + indentColumns(after[1])
          }
        }
      }

      // The line that ended a quote can be the one that opens the next block.
      const inner = items[items.length - 1]
      const container = inner && inner.depth === fenceDepth ? inner.column : 0
      /*
       * Three columns past the block it sits in and no further, the same
       * allowance its closer gets — because four columns in is not a fence at
       * all, it is a line of indented code that happens to be backticks. The
       * scan opened one there and, finding nothing able to close it, ran to the
       * end of the note: a sample indented one column too far took every
       * heading, tag and link below it out of the index.
       *
       * What is left is the indented block itself, whose contents this still
       * reads as prose — the gap this scan documents, and the mild half of it.
       * A tag written in such a sample is indexed as the note's own, where
       * before the whole rest of the note went missing.
       */
      if (m && fenceColumn - container <= 3) {
        openAt = fenceAt
        openMark = m[2]
        openDepth = fenceDepth
        openContainer = container
      }
    } else if (
      /*
       * In the same container as the fence it closes, and then the mark itself.
       *
       * Three columns of leeway, counted from where the container's own content
       * begins — from the *container*, which is the whole difficulty. An opener
       * is allowed three columns of its own, so counting the closer's allowance
       * from the opener handed it as many as six, and a block opened at one
       * space was closed by a four-space line that is a line of code and
       * nothing else. Counting from the margin instead is no better the other
       * way round: a fence written in a list begins at the item's column, and
       * measuring its closer from column zero leaves every one of those blocks
       * open to the end of the note.
       */
      m &&
      depth === openDepth &&
      indentColumns(m[1]) <= openContainer + 3 &&
      closes(m, openMark)
    ) {
      out.push([openAt, pos + line.length])
      openAt = null
    }

    pos += line.length + 1
  }

  if (openAt !== null) out.push([openAt, text.length])
  return out
}

/**
 * The whole run of fence characters, not the first three of it, because how
 * long a fence is decides what can close it — and after any blockquote
 * markers, because a fenced block quoted out of somewhere else is still a
 * fenced block and its `#tag` is still a code sample.
 */
const FENCE = /^([ \t>]*)(`{3,}|~{3,})(.*)$/

/**
 * Whether this fence line closes one opened with `openMark`.
 *
 * The same character, *at least as long*, and no language after it — all three
 * of them CommonMark, and all three of them the reason a four-backtick block
 * can quote a three-backtick one. Without the length, writing about markdown in
 * markdown ended the block at the inner example, and everything below it —
 * `# Not a heading` included — came back out as prose.
 *
 * The caller adds the container — the same quote depth, and close enough to
 * the same column. A closing fence closes the block it is *in*, so a `> ``` ` in
 * the middle of an ordinary block is a line of a sample about quoted markdown
 * and not the end of anything — while it counted, that one line both released
 * the example's headings and tags into the index as real ones and left the
 * fence that really closed the block to open a region that hid the prose after
 * it.
 */
function closes(m: RegExpExecArray, openMark: string): boolean {
  return m[2][0] === openMark[0] && m[2].length >= openMark.length && !m[3].trim()
}

/** The whitespace and quote markers a line opens with. */
const INDENT = /^[ \t>]*/

/** A list marker and the gap after it, which together say where the item's content begins. */
const LIST_ITEM = /^([ \t>]*)([-*+]|\d{1,9}[.)])([ \t]+|$)/

/**
 * The column a list item's content starts at, which is the column anything
 * inside it is measured from.
 *
 * The marker, then the gap after it — except that a gap of five columns or
 * more is indented code inside the item rather than a wider marker, and the
 * content begins one column after the marker instead.
 *
 * `base` is the column the marker itself was written at, for the second and
 * later markers on one line: `- - x` is an item inside an item, and the inner
 * one starts where the outer one's content does rather than at the margin.
 */
function contentColumn(li: RegExpExecArray, base = 0): number {
  const afterMark = base + indentColumns(li[1]) + li[2].length
  const gap = advance(afterMark, li[3])
  return gap - afterMark >= 5 || !li[3] ? afterMark + 1 : gap
}

/**
 * How far a line is indented inside whatever holds it, in columns.
 *
 * Measured from after the quote markers, past the single space each one is
 * allowed, with a tab going to the next stop of four the way a tab does.
 */
function indentColumns(prefix: string): number {
  const quoted = prefix.lastIndexOf('>')
  return advance(0, quoted < 0 ? prefix : prefix.slice(quoted + 1).replace(/^ /, ''))
}

/** That same walk, carried on from a column already reached. */
function advance(col: number, text: string): number {
  for (const c of text) col += c === '\t' ? 4 - (col % 4) : 1
  return col
}

/** How many blockquotes deep a line is, counted off its own markers. */
function quoteDepth(line: string): number {
  let n = 0
  for (const c of line) {
    if (c === '>') n++
    else if (c !== ' ' && c !== '\t') break
  }
  return n
}

export function inRegions(regions: Array<[number, number]>, i: number): boolean {
  for (const [a, b] of regions) if (i >= a && i < b) return true
  return false
}

/* ------------------------------------------------------------------- links */

export interface WikiLink {
  /** Full match including brackets and any leading "!". */
  from: number
  to: number
  /** Target as written, before "#" or "|". */
  target: string
  /** Heading/block anchor after "#", if any. */
  anchor?: string
  /** Display text or, for embeds, a width like "400". */
  alias?: string
  embed: boolean
}

/*
 * The target is allowed to be empty, which is what makes `[[#Costs]]` a link:
 * an anchor with no note in front of it means a heading in *this* note. Both
 * halves empty is not a link at all — see the guard in the scan — so `[[]]`
 * and `[[|alias]]` stay inert text the way they always were.
 *
 * What is inside is taken apart by `splitWikiInner`, the one reading of the
 * syntax everything shares, so an escaped `\#` in a name is part of the name
 * here exactly as it is in the editor.
 */
const WIKI = new RegExp(WIKI_SOURCE, 'g')

export function scanWikiLinks(text: string, regions = codeRegions(text)): WikiLink[] {
  const out: WikiLink[] = []
  WIKI.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = WIKI.exec(text))) {
    if (inRegions(regions, m.index)) continue
    const { target, anchor, alias } = splitWikiInner(m[2])
    // Brackets round nothing. Naming neither a note nor a place in one, it
    // points at nothing that could be opened.
    if (!target && !anchor) continue
    out.push({
      from: m.index,
      to: m.index + m[0].length,
      target,
      anchor,
      alias,
      embed: m[1] === '!',
    })
  }
  return out
}

/** A wikilink as the words it shows: its display text, or what it names. */
function wikiAsText(s: string): string {
  return s.replace(new RegExp(WIKI_SOURCE, 'g'), (_, _bang: string, inner: string) => {
    const { alias, head } = splitWikiInner(inner)
    return alias || unescapeWiki(head.trim())
  })
}

export interface MdLink {
  from: number
  to: number
  alt: string
  url: string
  embed: boolean
  /** Offsets of just the URL, so a resize can rewrite it in place. */
  urlFrom: number
  urlTo: number
}

// ![alt](path "title")  /  [text](path)
const MDLINK = /(!?)\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^)\s]*)(\s+"[^"\n]*")?\s*\)/g

export function scanMdLinks(text: string, regions = codeRegions(text)): MdLink[] {
  const out: MdLink[] = []
  MDLINK.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MDLINK.exec(text))) {
    if (inRegions(regions, m.index)) continue
    const rawUrl = m[3]
    const bracketed = rawUrl.startsWith('<') && rawUrl.endsWith('>')
    const urlStart = m.index + m[0].indexOf(rawUrl, m[1].length + m[2].length + 2)
    out.push({
      from: m.index,
      to: m.index + m[0].length,
      alt: m[2],
      url: bracketed ? rawUrl.slice(1, -1) : rawUrl,
      embed: m[1] === '!',
      urlFrom: urlStart + (bracketed ? 1 : 0),
      urlTo: urlStart + rawUrl.length - (bracketed ? 1 : 0),
    })
  }
  return out
}

/** Strip a `#w=400` sizing fragment from an embed URL. Returns [clean, width]. */
export function splitSizeFragment(url: string): [string, number | undefined] {
  const m = /^(.*?)#w=(\d+)$/.exec(url)
  if (!m) return [url, undefined]
  return [m[1], Number(m[2])]
}

/* -------------------------------------------------------------------- tags */

const TAG = /(^|[\s(>])#([A-Za-z0-9_][A-Za-z0-9/_-]*)/g

export function scanTags(text: string, regions = codeRegions(text)): string[] {
  const set = new Set<string>()
  TAG.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TAG.exec(text))) {
    const at = m.index + m[1].length
    if (inRegions(regions, at)) continue
    // A "#" at the very start of a line followed by a space is a heading.
    set.add(m[2])
  }
  return [...set]
}

/* ------------------------------------------------------------------- tasks */

export interface RawTask {
  line: number
  /** Character offset of the "[" in "- [ ]". */
  markerAt: number
  done: boolean
  text: string
  due?: number
  /** Tags written on the task's own line. */
  tags: string[]
}

const TASK = /^(\s*)(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s?(.*)$/

/** Is this line a `- [ ]` / `1. [x]` task? */
export function isTaskLine(line: string): boolean {
  return TASK.test(line)
}

/**
 * Every task in a note — which does not include an empty checkbox.
 *
 * `- [ ]` with nothing after it is a line waiting to be typed into, not a job
 * anybody has to do. The daily note's template opens with a few of them on
 * purpose, and a template's blank lines have no business turning up in the
 * Tasks view, in a Tag Folder, or in tomorrow's count of what is due. So they
 * are not indexed, by any of the lists that ask this function what a note
 * holds — `hasTasks` included, so a note holding nothing but blank checkboxes
 * does not answer to a `has:tasks` rule either.
 *
 * The editor draws its checkbox from `isTaskLine`, not from here, so an empty
 * one is still a checkbox in the note: tickable, and a task the moment it is
 * given something to say.
 */
export function scanTasks(text: string): RawTask[] {
  const out: RawTask[] = []
  const regions = codeRegions(text)
  let offset = 0
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = TASK.exec(line)
    const body = m ? m[3].trim() : ''
    if (m && body && !inRegions(regions, offset)) {
      const markerAt = offset + line.indexOf('[', m[1].length)
      out.push({
        line: i,
        markerAt,
        done: m[2].toLowerCase() === 'x',
        text: body,
        due: parseDue(m[3]),
        tags: scanTags(m[3]),
      })
    }
    offset += line.length + 1
  }
  return out
}

/**
 * The tags the note itself carries, as opposed to the ones written on its
 * tasks.
 *
 * `scanTags` reads the whole file, so a `#urgent` written on one task line
 * makes the note tagged `#urgent` — which is right for the note (it does
 * contain urgent work) and wrong as something for *every other task on it* to
 * inherit. A task inherits what the note says about itself, not what its
 * siblings say about themselves.
 *
 * The task lines are blanked to spaces rather than removed, so every offset in
 * the text stays where it was and the code-fence regions still line up.
 */
export function noteLevelTags(text: string): string[] {
  const lines = text.split('\n')
  let blanked = false
  for (let i = 0; i < lines.length; i++) {
    if (!TASK.test(lines[i])) continue
    lines[i] = ' '.repeat(lines[i].length)
    blanked = true
  }
  return blanked ? scanTags(lines.join('\n')) : scanTags(text)
}

/* -------------------------------------------------------------- due dates */

/**
 * Every due-date syntax the app understands, in one pattern.
 *
 * Reading stays deliberately permissive — a vault may have been written by
 * Obsidian's Tasks plugin (`📅`), Dataview (`[due:: ]`), or by hand — while
 * `withDue` only ever *writes* the emoji form. That asymmetry is the point: a
 * date someone else's tool wrote keeps working, and a date this app writes
 * looks like the one the docs describe.
 */
// The \uFE0F is optional because a 📅 pasted from some keyboards carries a
// variation selector, and without it the marker parses but never fully strips.
const DUE_SRC = String.raw`(?:📅\uFE0F?|@due\(|due:)\s*(\d{4}-\d{2}-\d{2})\)?|\[due::\s*(\d{4}-\d{2}-\d{2})\]`
const DUE = new RegExp(DUE_SRC)
/** The same, plus any whitespace in front, for cutting a marker back out. */
const DUE_CUT = new RegExp(String.raw`[ \t]*(?:${DUE_SRC})`, 'g')

export interface DueMarker {
  /** Character offsets of the marker within the string it was found in. */
  from: number
  to: number
  /** ms epoch, local midnight. */
  date: number
}

/** Locate the due marker in a line, offsets included — the editor needs both. */
export function findDue(s: string): DueMarker | undefined {
  const m = DUE.exec(s)
  if (!m) return undefined
  const date = parseYmd(m[1] ?? m[2])
  if (date === undefined) return undefined
  return { from: m.index, to: m.index + m[0].length, date }
}

/** Recognizes `📅 2026-09-01`, `@due(2026-09-01)`, `due:2026-09-01`, `[due:: 2026-09-01]`. */
export function parseDue(s: string): number | undefined {
  return findDue(s)?.date
}

/**
 * Rewrite a line to carry exactly one due date, or none.
 *
 * Every existing marker goes first — including one this app didn't write, and
 * including a second one someone left behind — so setting a date twice can't
 * accumulate. The new marker is appended at the end of the line rather than
 * inserted where the old one sat: end-of-line is where the parser, the chip and
 * every other tool expect it, and it keeps the sentence you wrote intact.
 */
export function withDue(line: string, date: number | undefined): string {
  const bare = line.replace(DUE_CUT, '').replace(/[ \t]+$/, '')
  if (date === undefined) return bare
  return `${bare} 📅 ${ymd(date)}`
}

/* ----------------------------------------------------------------- summary */

/**
 * Strip inline markup for display in UI chrome (task lists, palettes) where the
 * raw syntax would be noise. The source is never modified — this is only ever
 * used for what's shown, so nothing round-trips through it.
 */
export function stripInline(s: string): string {
  return wikiAsText(s)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|\*|_|`)/g, '')
    .replace(DUE_CUT, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * First meaningful line of body text, for the note list subtitle.
 *
 * `vars` is the note's own properties, when the caller has them: a row reading
 * "Prepared for $(client)" beside a page reading "Prepared for Acme Corp" is
 * the same note described two ways, and the list is the one that is wrong.
 */
export function excerptOf(
  text: string,
  bodyStart = 0,
  vars?: Record<string, FrontmatterValue>,
): string {
  const body = text.slice(bodyStart)
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (/^#{1,6}\s/.test(line)) continue
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) continue
    if (/^```/.test(line)) continue
    /*
     * A callout's `[!NOTE]` is a marker, not the note's first words: the app
     * draws it as an icon, and a list row that led with "[!NOTE] In one line"
     * would be reading out the punctuation. Taken off before the blockquote `>`
     * goes, so the pattern can still see which line it is on.
     */
    const clean = wikiAsText(line.replace(/^>\s*\[![A-Za-z]+\][+-]?\s*/, ''))
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_~`>]/g, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/, '')
      .trim()
    if (clean) return (vars ? resolveVars(clean, vars) : clean).slice(0, 180)
  }
  return ''
}

/** The H1 or first heading, used to offer a rename when the title drifts. */
export function firstHeading(text: string, bodyStart = 0): string | undefined {
  const m = /^#{1,6}\s+(.+)$/m.exec(text.slice(bodyStart, bodyStart + 4000))
  return m?.[1].trim()
}

/* ---------------------------------------------------------------- headings */

export interface Heading {
  /** 1–6, from how many `#` marks it was written with. */
  level: number
  /** The words, with inline markup taken off — what a list of them shows. */
  text: string
  /** Character offset of the first `#`. */
  from: number
  /** Zero-based line, which is what navigation moves by — the same as a task. */
  line: number
}

/**
 * A `#` at the start of a line and a space after it. Three things are not a
 * heading and each has cost somebody an afternoon somewhere:
 *
 * - `#work` — no space, so it is a tag, and tags on their own line at the top
 *   of a note are how half this vault is written.
 * - a `#` indented under a list item — CommonMark allows three spaces, this app
 *   has never drawn one as a heading, and matching at column 0 is what the rest
 *   of the file already does (see `firstHeading`).
 * - `# comment` inside the frontmatter block, which is YAML, not prose.
 */
const HEADING = /^(#{1,6})[ \t]+(.*)$/

/**
 * Every heading in a note, in the order they appear.
 *
 * The frontmatter is skipped and so are fenced code blocks, which is the whole
 * reason this takes the same `codeRegions` every other scanner here takes: a
 * `# Install` inside a shell sample is a comment somebody wrote, and an outline
 * that jumps you into the middle of a code block is worse than no outline.
 *
 * A heading with nothing after the marker is left out, on the rule the tasks
 * already follow: `- [ ]` with nothing after it is not a job, and `##` with
 * nothing after it is not a place you could ask to be taken to. The editor
 * still draws both — they are markup in the note, they are simply not things a
 * list can offer you.
 */
export function scanHeadings(text: string, regions = codeRegions(text)): Heading[] {
  const out: Heading[] = []
  /*
   * Read here rather than taken as a parameter. Every caller would otherwise
   * have to remember that YAML comments start with the same character markdown
   * headings do, and the parse costs nothing on a note with no frontmatter —
   * it returns on the first character.
   */
  const bodyStart = parseFrontmatter(text).bodyStart
  const lines = text.split('\n')
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const at = offset
    offset += line.length + 1
    if (at < bodyStart) continue
    const m = HEADING.exec(line)
    if (!m || inRegions(regions, at)) continue
    // `## Title ##` is one heading in CommonMark; the closing run is decoration.
    const body = m[2].replace(/[ \t]+#+[ \t]*$/, '')
    const clean = stripInline(body)
    if (!clean) continue
    out.push({ level: m[1].length, text: clean, from: at, line: i })
  }
  return out
}

/**
 * The heading a `[[Note#Anchor]]` is pointing at, if the note has one.
 *
 * Matched on the words as they read rather than as they are written, so
 * `[[Trip#Costs]]` finds `## **Costs**` — the anchor is what somebody typed
 * after the hash, and nobody types the asterisks. Case is ignored for the same
 * reason. The first match wins: two headings with the same words are a note
 * whose author did not mean to distinguish them.
 */
export function findHeading(text: string, anchor: string): Heading | undefined {
  const want = stripInline(anchor).toLowerCase()
  if (!want) return undefined
  return scanHeadings(text).find((h) => h.text.toLowerCase() === want)
}

/**
 * The date a note is filed under in the calendar. Priority:
 *   1. `date:` or `created:` in frontmatter
 *   2. a YYYY-MM-DD prefix or suffix in the filename (daily notes)
 *   3. the file's creation time
 */
/* ------------------------------------------------------------------ events */

/**
 * When a note says it happens.
 *
 * `start:` is what makes a note an event — nothing else has to be written, and
 * a note without it is an ordinary note. The three shapes it can take are
 * iCalendar's three, transliterated rather than invented, because that is what
 * the data arriving from a calendar actually is:
 *
 *   start: 2026-09-21              all day, no time to be wrong about
 *   start: 2026-09-21T09:30        a wall-clock time, wherever you are
 *   start: 2026-09-21T14:00        the same, read in the zone `tz:` names
 *   tz: America/New_York
 *
 * `start` and `end` are always written in the zone `tz` names, and in the
 * device's own zone when there isn't one — so the file reads as the time the
 * meeting was described to you in, "two o'clock in New York", and the zone is
 * there for the app to convert rather than for you to have done the sum first.
 *
 * `end` is **inclusive** for an all-day event, which is the one place this
 * deliberately parts with iCalendar: `DTEND` there is exclusive, so a one-day
 * event is written as ending the next morning. Copy that through and every
 * single-day event draws itself two days long.
 */
export interface NoteEvent {
  /** Instant the event starts, ms epoch. Local midnight when all-day. */
  start: number
  /** Instant it ends, ms epoch. The last day's midnight when all-day. */
  end: number
  allDay: boolean
  /** The IANA zone `start` and `end` were written in, when one was named. */
  tz?: string
  /**
   * A `tz:` this engine cannot use, kept as written.
   *
   * Dropping it was silent and therefore the worst shape of wrong: a mistyped
   * `Amercia/New_York` resolved to exactly the same instant as no zone at all,
   * with nothing anywhere to say the line had been ignored. Held on to so the
   * agenda and the properties form can show that it is not doing anything.
   */
  badZone?: string
  /**
   * The title the event was given when it was made, from its `title:`.
   *
   * Not a display name on its own: `eventTitle` trusts it only while the
   * filename is still exactly what this title would have been named, so a note
   * renamed since reads as its new name. It exists because a filename cannot
   * say which of its parts somebody typed.
   */
  title?: string
}

/**
 * A `title:` as the text it was written as.
 *
 * The property writer leaves `true` and `123` bare, which is right for the
 * checkbox and number fields it writes them for and means a meeting called
 * `123` reads back as a number. `String` gives those back exactly; the few it
 * cannot — `007`, `1.50` — fail the filename check in `eventTitle` and are read
 * by shape instead, which gets every one of them right, since none can look
 * like a stamp.
 */
function recordedTitle(v: FrontmatterValue | undefined): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return undefined
}

const EVENT_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/

/**
 * What a zone's clocks were offset by at a given instant, in milliseconds.
 *
 * `Intl` will format an instant in any zone but will not do the sum backwards,
 * so this asks it to format one and reads the answer as though it were UTC. The
 * difference between that and the instant is the offset.
 */
export function zoneOffsetAt(at: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
  // `hour12: false` still says 24 for midnight in some engines; 24:00 today is
  // 00:00 today as far as the arithmetic below is concerned.
  const h = get('hour') % 24
  return Date.UTC(get('year'), get('month') - 1, get('day'), h, get('minute'), get('second')) - at
}

/**
 * An instant written back out as a wall clock, in a zone or where you are.
 *
 * The other direction from `instantInZone`, and needed for the same reason: a
 * field holding `14:30` holds it *in the zone that was chosen*, so anything
 * that works in instants and then has to put a value back in that field has to
 * be told which clock to read it by. Serialising in the device's zone instead
 * is how a dialog ends up disagreeing with the note it is about to write.
 */
export function wallClockIn(at: number, tz?: string): string {
  const p = (n: number) => `${n}`.padStart(2, '0')
  // A zone this engine cannot read is one the whole app already falls back to
  // local time over; a formatter is the last place that should throw about it.
  if (tz && !isKnownZone(tz)) tz = undefined
  if (!tz) {
    const d = new Date(at)
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
  }
  const d = new Date(at + zoneOffsetAt(at, tz))
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

/**
 * The instant a wall-clock time names in a given zone.
 *
 * Twice a year a wall clock does not name one instant. An hour is *skipped* in
 * spring, so 02:30 never happens; an hour is *repeated* in autumn, so 01:30
 * happens twice. A rule is needed for both, and the rule here is the one
 * `Temporal` calls `compatible` and every calendar has settled on: a time that
 * was skipped moves forward by the gap, and a time that happened twice means
 * the first of them.
 *
 * Two candidates, built from the offsets a day either side — far enough to be
 * on opposite sides of any transition, close enough that no zone has two. When
 * they agree there was no transition and either will do. When only one of them
 * reads back as the wall time asked for, that is the answer. When *both* do,
 * the hour happened twice and the earlier wins. When *neither* does, the hour
 * did not happen at all, and the later of the two is that time plus the gap.
 *
 * The previous version guessed twice and hoped the second guess converged. It
 * did for the repeated hour and not for the skipped one: 02:30 in New York came
 * back as 01:30 — an hour *before* what was asked for, and an hour and a half
 * from what the same time with no zone on it resolves to.
 */
const A_DAY = 86_400_000

function instantInZone(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  sec: number,
  tz: string,
): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi, sec)
  const a = wall - zoneOffsetAt(wall - A_DAY, tz)
  const b = wall - zoneOffsetAt(wall + A_DAY, tz)
  if (a === b) return a
  const holds = (at: number) => at + zoneOffsetAt(at, tz) === wall
  const okA = holds(a)
  const okB = holds(b)
  if (okA && okB) return Math.min(a, b)
  if (okA) return a
  if (okB) return b
  return Math.max(a, b)
}

/** One `start:`/`end:` value. Undefined for anything that is not a date. */
function parseEventTime(
  raw: FrontmatterValue | undefined,
  tz: string | undefined,
): { at: number; allDay: boolean } | undefined {
  if (typeof raw !== 'string') return undefined
  const m = EVENT_TIME_RE.exec(raw.trim())
  if (!m) return undefined
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  /*
   * A date that does not exist is not a date. `Date` would take the 13th month
   * and hand back next January without complaining, and the 31st of September
   * lands on the 1st of October — so an event whose year was mistyped by one
   * digit would not fail, it would quietly happen on the wrong day. Building
   * it and checking the parts come back out is the whole test.
   */
  const probe = new Date(y, mo - 1, d)
  if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d)
    return undefined
  if (m[4] === undefined) {
    /*
     * A day has no time to put a zone on: "the 21st" is the 21st wherever the
     * calendar came from, and converting it would slide it onto the 20th for
     * anybody far enough west. So an all-day event ignores `tz` entirely.
     */
    return { at: probe.getTime(), allDay: true }
  }
  const [h, mi, sec] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)]
  if (h > 23 || mi > 59 || sec > 59) return undefined
  const at = tz
    ? instantInZone(y, mo, d, h, mi, sec, tz)
    : new Date(y, mo - 1, d, h, mi, sec).getTime()
  return { at, allDay: false }
}

/** True for a zone name this engine will accept; a typo is not a zone. */
export function isKnownZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() })
    return true
  } catch {
    return false
  }
}

/** The `tz:` as written, and whether anything can be done with it. */
function readZone(raw: FrontmatterValue | undefined): { tz?: string; badZone?: string } {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  const tz = raw.trim()
  return isKnownZone(tz) ? { tz } : { badZone: tz }
}

/** An hour, which is what an event with no end is assumed to take. */
const DEFAULT_DURATION = 60 * 60 * 1000

/**
 * The event a note describes, or undefined when it does not describe one.
 *
 * Lenient in the same way the rest of this file is lenient: a `start:` nobody
 * can parse makes an ordinary note rather than a broken event, and an `end:`
 * that is missing, unreadable or before its start is replaced rather than
 * refused. A note is a text file somebody may have typed by hand.
 */
export function eventFor(fm: Record<string, FrontmatterValue>): NoteEvent | undefined {
  const { tz, badZone } = readZone(fm.tz)
  const start = parseEventTime(fm.start, tz)
  if (!start) return undefined
  const title = recordedTitle(fm.title)
  const end = parseEventTime(fm.end, tz)
  /*
   * An end written in the other shape is not an end this can use: a day cannot
   * say when an appointment finished, and a time cannot close an event filed as
   * a whole day. Fall back rather than mix the two.
   */
  const usable = end && end.allDay === start.allDay && end.at >= start.at ? end.at : undefined
  return {
    start: start.at,
    end: usable ?? (start.allDay ? start.at : start.at + DEFAULT_DURATION),
    allDay: start.allDay,
    ...(start.allDay ? {} : tz ? { tz } : {}),
    // Reported whatever the shape: a zone nobody can read is worth saying on an
    // all-day event too, since it means a line of the file is doing nothing.
    ...(badZone ? { badZone } : {}),
    ...(title ? { title } : {}),
  }
}

export function calendarDateFor(
  path: string,
  fm: Record<string, unknown>,
  ctime: number,
): number {
  for (const key of ['date', 'created']) {
    const v = fm[key]
    if (typeof v === 'string') {
      const t = parseYmd(v.slice(0, 10))
      if (t !== undefined) return t
    }
  }
  const name = titleFromPath(path)
  const m = /(\d{4}-\d{2}-\d{2})/.exec(name)
  if (m) {
    const t = parseYmd(m[1])
    if (t !== undefined) return t
  }
  return startOfDay(ctime)
}

/** Resolve a wikilink target to a vault path, given a title -> path map. */
export function resolveTarget(
  target: string,
  byTitle: Map<string, string>,
  allPaths: Set<string>,
): string | undefined {
  const t = target.trim()
  if (!t) return undefined
  // Exact path (with or without extension) wins over title matching.
  const np = normPath(t)
  if (allPaths.has(np)) return np
  if (allPaths.has(`${np}.md`)) return `${np}.md`
  return byTitle.get(t.toLowerCase())
}
