/**
 * Markdown introspection: frontmatter, wikilinks, embeds, tags, tasks.
 *
 * These are deliberately regex-level rather than a full parse. The index is
 * rebuilt on every save, so this runs often and must stay cheap; and being
 * lenient here is safer than being strict — a link the parser misses is a
 * broken feature, but a note it refuses is lost work.
 */

import { normPath, parseYmd, startOfDay, titleFromPath, ymd } from './util'

export interface Frontmatter {
  data: Record<string, string | string[] | boolean | number>
  /** Character offset in the source where the body begins. */
  bodyStart: number
  raw: string
}

/** Parse a leading `---` YAML-ish block. Supports scalars and `[a, b]` / `- a` lists. */
export function parseFrontmatter(text: string): Frontmatter {
  if (!text.startsWith('---')) return { data: {}, bodyStart: 0, raw: '' }
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!m) return { data: {}, bodyStart: 0, raw: '' }
  const data: Record<string, string | string[] | boolean | number> = {}
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
      data[lastKey] = rawVal
        .slice(1, -1)
        .split(',')
        .map((s) => unquote(s.trim()))
        .filter(Boolean)
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

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
    return s.slice(1, -1)
  return s
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

/* ----------------------------------------------------------------- regions */

/**
 * Byte ranges that must be ignored by link/tag/task scanning: fenced code
 * blocks and inline code. Without this, a `#hashtag` in a code sample becomes a
 * tag and a `[[foo]]` in a snippet becomes a phantom link.
 */
export function codeRegions(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const fence = /^(\s*)(```|~~~)[^\n]*$/gm
  let m: RegExpExecArray | null
  let openAt: number | null = null
  let openMark = ''
  while ((m = fence.exec(text))) {
    if (openAt === null) {
      openAt = m.index
      openMark = m[2]
    } else if (m[2][0] === openMark[0]) {
      out.push([openAt, m.index + m[0].length])
      openAt = null
    }
  }
  if (openAt !== null) out.push([openAt, text.length])

  const inline = /`+[^`\n]*`+/g
  while ((m = inline.exec(text))) {
    const s = m.index
    if (!out.some(([a, b]) => s >= a && s < b)) out.push([s, s + m[0].length])
  }
  return out
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

const WIKI = /(!?)\[\[([^\]\n|#]+)(?:#([^\]\n|]+))?(?:\|([^\]\n]*))?\]\]/g

export function scanWikiLinks(text: string, regions = codeRegions(text)): WikiLink[] {
  const out: WikiLink[] = []
  WIKI.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = WIKI.exec(text))) {
    if (inRegions(regions, m.index)) continue
    out.push({
      from: m.index,
      to: m.index + m[0].length,
      target: m[2].trim(),
      anchor: m[3]?.trim(),
      alias: m[4]?.trim(),
      embed: m[1] === '!',
    })
  }
  return out
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

export function scanTasks(text: string): RawTask[] {
  const out: RawTask[] = []
  const regions = codeRegions(text)
  let offset = 0
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = TASK.exec(line)
    if (m && !inRegions(regions, offset)) {
      const markerAt = offset + line.indexOf('[', m[1].length)
      out.push({
        line: i,
        markerAt,
        done: m[2].toLowerCase() === 'x',
        text: m[3].trim(),
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
  return s
    .replace(/!?\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_, t, a) => a || t)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|\*|_|`)/g, '')
    .replace(DUE_CUT, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** First meaningful line of body text, for the note list subtitle. */
export function excerptOf(text: string, bodyStart = 0): string {
  const body = text.slice(bodyStart)
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (/^#{1,6}\s/.test(line)) continue
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) continue
    if (/^```/.test(line)) continue
    const clean = line
      .replace(/!?\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_, t, a) => a || t)
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_~`>]/g, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/, '')
      .trim()
    if (clean) return clean.slice(0, 180)
  }
  return ''
}

/** The H1 or first heading, used to offer a rename when the title drifts. */
export function firstHeading(text: string, bodyStart = 0): string | undefined {
  const m = /^#{1,6}\s+(.+)$/m.exec(text.slice(bodyStart, bodyStart + 4000))
  return m?.[1].trim()
}

/**
 * The date a note is filed under in the calendar. Priority:
 *   1. `date:` or `created:` in frontmatter
 *   2. a YYYY-MM-DD prefix or suffix in the filename (daily notes)
 *   3. the file's creation time
 */
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
