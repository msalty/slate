/**
 * Frontmatter as a list of properties, for editing it as a form.
 *
 * `core/markdown.ts` reads frontmatter into a plain object, which is exactly
 * what the index wants and exactly what a form cannot use: an object has no
 * order, no memory of how a value was written, and no room for the lines —
 * comments, blanks, a shape somebody chose on purpose — that a round trip
 * through it would quietly throw away.
 *
 * So this reads the same block into ordered entries that keep their source
 * lines, and every edit here rewrites *only* the entry it touches. A property
 * nobody typed in comes back out of the file byte for byte, which is the whole
 * promise the rest of the app makes about a note: what you did not change is
 * still there.
 *
 * Like the rest of the markdown handling this is regex-level rather than a YAML
 * parser. A note is a text file somebody may have written by hand, and being
 * lenient — keeping a line we do not understand rather than dropping it — is
 * the only safe way to hold one.
 */

import { ymd } from './util'

/**
 * How a value is written, and so how the form offers to edit it. Inferred from
 * the value itself rather than stored anywhere: there is no schema in a
 * markdown file, and a type that lived only in the app would be a promise the
 * file could not keep.
 */
export type PropertyKind = 'text' | 'list' | 'number' | 'checkbox' | 'date'

export interface Property {
  key: string
  /** What the form shows: the scalar as written, or a list joined with ", ". */
  value: string
  /** The items, for a list. Null for every other kind. */
  items: string[] | null
  kind: PropertyKind
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/
const KEY_RE = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/
const ITEM_RE = /^\s*-\s+(.*)$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const NUMBER_RE = /^-?\d+(\.\d+)?$/

/** One `key:` and everything written under it. */
interface Entry {
  key: string
  value: string
  items: string[] | null
  /** Items written one per line, rather than inline as `[a, b]`. */
  block: boolean
  /** The source lines this entry owns, kept verbatim until it is edited. */
  lines: string[]
}

interface Block {
  exists: boolean
  /** Lines above the first key — comments, blanks — kept as they are. */
  lead: string[]
  entries: Entry[]
  /** Everything after the closing fence. */
  body: string
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
    return s.slice(1, -1)
  return s
}

/**
 * Values that would not survive being written bare: YAML would read them as
 * something else, or lose the spaces around them. Numbers keep their minus
 * sign — `-5` is quoted only when the `-` starts something that isn't a number.
 */
const NEEDS_QUOTE = /^$|^\s|\s$|^[>|*&!%@`'"[\]{},#?:]|^-(?!\d)|:\s|\s#/

function scalar(v: string): string {
  return NEEDS_QUOTE.test(v) ? JSON.stringify(v) : v
}

function splitInline(inner: string): string[] {
  return inner
    .split(',')
    .map((s) => unquote(s.trim()))
    .filter((s) => s !== '')
}

/** Split what somebody typed into a list field: "a, b" → ["a", "b"]. */
export function splitList(v: string): string[] {
  return v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

function parseBlock(text: string): Block {
  const m = text.startsWith('---') ? FM_RE.exec(text) : null
  if (!m) return { exists: false, lead: [], entries: [], body: text }

  const lead: string[] = []
  const entries: Entry[] = []
  for (const line of m[1].split(/\r?\n/)) {
    const kv = KEY_RE.exec(line)
    if (kv) {
      const raw = kv[2].trim()
      const inline = /^\[(.*)\]$/.exec(raw)
      entries.push({
        key: kv[1],
        value: inline ? '' : unquote(raw),
        items: inline ? splitInline(inline[1]) : null,
        block: false,
        lines: [line],
      })
      continue
    }
    const last = entries[entries.length - 1]
    const item = ITEM_RE.exec(line)
    // A `- item` line belongs to the key above it, but only while that key is
    // still waiting for a value: one under `title: Notes` is prose, not a list.
    if (item && last && last.value === '' && (last.items === null || last.block)) {
      last.items = [...(last.items ?? []), unquote(item[1].trim())]
      last.block = true
      last.lines.push(line)
      continue
    }
    if (last) last.lines.push(line)
    else lead.push(line)
  }
  return { exists: true, lead, entries, body: text.slice(m[0].length) }
}

/** The lines an entry is written as, after something about it has changed. */
function linesFor(e: Entry): string[] {
  /*
   * Anything the entry owned that wasn't its key line or one of its items — a
   * comment somebody left under it — is kept and follows the rewritten lines.
   * Losing it would be the one thing this module exists to avoid.
   */
  const extras = e.lines.slice(1).filter((l) => !ITEM_RE.test(l))
  const written = e.items
    ? e.block
      ? [`${e.key}:`, ...e.items.map((i) => `  - ${scalar(i)}`)]
      : [`${e.key}: [${e.items.map(scalar).join(', ')}]`]
    : [e.value === '' ? `${e.key}:` : `${e.key}: ${scalar(e.value)}`]
  return [...written, ...extras]
}

function serialize(b: Block): string {
  const lines = [...b.lead, ...b.entries.flatMap((e) => e.lines)]
  /*
   * A block with nothing left in it is not written at all. Frontmatter is
   * optional, and a note whose last property was just deleted should read as a
   * note that never had any — an empty `---` pair at the top is neither.
   */
  if (lines.length === 0) return b.body.replace(/^\r?\n+/, '')
  // A block that is being created needs the blank line under it that every
  // hand-written one has; one that already existed brought its own body along.
  return `---\n${lines.join('\n')}\n---\n${b.exists ? b.body : `\n${b.body}`}`
}

function kindOf(value: string, items: string[] | null): PropertyKind {
  if (items) return 'list'
  if (value === 'true' || value === 'false') return 'checkbox'
  if (DATE_RE.test(value)) return 'date'
  if (value !== '' && NUMBER_RE.test(value)) return 'number'
  return 'text'
}

/** Every property in the note's frontmatter, in the order the file has them. */
export function readProperties(text: string): Property[] {
  return parseBlock(text).entries.map((e) => ({
    key: e.key,
    value: e.items ? e.items.join(', ') : e.value,
    items: e.items,
    kind: kindOf(e.value, e.items),
  }))
}

export function hasProperty(text: string, key: string): boolean {
  return parseBlock(text).entries.some((e) => e.key === key)
}

function applyValue(e: Entry, value: string | string[]) {
  if (Array.isArray(value)) {
    e.items = value
    e.value = ''
  } else {
    e.items = null
    e.block = false
    e.value = value
  }
  e.lines = linesFor(e)
}

/** Set a property's value, adding the property — and the block — if need be. */
export function setPropertyValue(text: string, key: string, value: string | string[]): string {
  const b = parseBlock(text)
  const e = b.entries.find((x) => x.key === key)
  if (!e) return addProperty(text, key, value)
  applyValue(e, value)
  return serialize(b)
}

/** Append a property. An existing key is set rather than written twice. */
export function addProperty(text: string, key: string, value: string | string[] = ''): string {
  const b = parseBlock(text)
  if (b.entries.some((e) => e.key === key)) return setPropertyValue(text, key, value)
  const e: Entry = {
    key,
    value: Array.isArray(value) ? '' : value,
    items: Array.isArray(value) ? value : null,
    block: false,
    lines: [],
  }
  e.lines = linesFor(e)
  b.entries.push(e)
  return serialize(b)
}

/**
 * Rename a property, keeping its place and its value.
 *
 * A name already in use is refused rather than merged: two keys with the same
 * name is a file where one value has quietly replaced another, and the form has
 * somewhere to say so.
 */
export function renameProperty(text: string, from: string, to: string): string {
  if (from === to) return text
  const b = parseBlock(text)
  const e = b.entries.find((x) => x.key === from)
  if (!e || b.entries.some((x) => x.key === to)) return text
  e.key = to
  e.lines = linesFor(e)
  return serialize(b)
}

export function removeProperty(text: string, key: string): string {
  const b = parseBlock(text)
  const i = b.entries.findIndex((e) => e.key === key)
  if (i < 0) return text
  b.entries.splice(i, 1)
  return serialize(b)
}

/**
 * The same value, written the way another kind writes it.
 *
 * Changing a property's type is changing what is in the file — there is nowhere
 * else for a type to live — so every conversion has to land on something the
 * file can hold and the form can read back as the kind that was asked for.
 */
export function coerceValue(p: Property, kind: PropertyKind): string | string[] {
  const v = p.value.trim()
  switch (kind) {
    case 'list':
      return p.items ?? splitList(p.value)
    case 'checkbox':
      return /^(true|yes|on|1)$/i.test(v) ? 'true' : 'false'
    case 'number':
      return NUMBER_RE.test(v) ? v : '0'
    case 'date':
      return DATE_RE.test(v) ? v : ymd(Date.now())
    default:
      return p.items ? p.items.join(', ') : p.value
  }
}

/**
 * A key the frontmatter parser can read back: no spaces, no punctuation it
 * would stop at. Typed keys go through this rather than being rejected, so
 * "Due date" becomes `Due-date` instead of a name the file cannot hold.
 */
export function sanitizeKey(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9_.-]/g, '')
}

/** `base`, or `base-2`, `base-3`… — whichever the note has not used. */
export function uniqueKey(taken: string[], base = 'property'): string {
  if (!taken.includes(base)) return base
  for (let n = 2; ; n++) {
    const k = `${base}-${n}`
    if (!taken.includes(k)) return k
  }
}
