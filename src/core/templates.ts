/**
 * Folder templates.
 *
 * A note created in a folder can start from boilerplate: a daily note with its
 * date and a heading, a meeting note with an attendees list, a person note with
 * the fields you always fill in.
 *
 * **A template is an ordinary note in an ordinary folder.** `Templates/` is a
 * real directory in the vault holding real `.md` files, so a template is
 * written, edited, searched, linked and synced exactly like everything else —
 * there is no template format, no template editor, and nothing to export. Open
 * one and change it and the next note picks the change up.
 *
 * **And the whole feature is opt-in.** `Templates/` is never created for
 * anybody: no boot step makes it, no first note makes it, and a vault without
 * one behaves in every respect as though this file did not exist — no folder in
 * the sidebar, no item in any menu, nothing to dismiss. It appears when someone
 * makes the folder, which Settings offers to do and never does on its own.
 */

import { computed, signal } from '@preact/signals'
import type { NoteIndexEntry } from './types'
import {
  getRaw,
  isTemplatePath,
  notes,
  readBackstage,
  TEMPLATES_FOLDER,
  UNTITLED,
  writeBackstage,
} from './vault'
import { dirname, normPath, startOfDay } from './util'

/*
 * The folder and the path test live in vault.ts, because the roll-ups there
 * have to recognise a template and this module already imports that one.
 * Re-exported so everything about templates is still reachable from here.
 */
export { TEMPLATES_FOLDER, isTemplatePath } from './vault'

/**
 * The templates on offer: every note in `Templates/`, nested ones included.
 *
 * Empty when the folder does not exist, which is what every piece of UI keys
 * off — an empty list is the "this vault does not use templates" signal, and
 * there is no separate setting saying so.
 */
export const templateNotes = computed<NoteIndexEntry[]>(() =>
  notes.value
    .filter((n) => isTemplatePath(n.path))
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true })),
)

export const hasTemplates = computed(() => templateNotes.value.length > 0)

/* ------------------------------------------------------- the assignments */

/**
 * Folder path -> template note path. The vault root is the empty string.
 *
 * In `backstage/` like the other two folder files, so an assignment follows you
 * to every device.
 */
const assignments = signal<Record<string, string>>({})

export async function loadTemplates(): Promise<void> {
  const raw = await readBackstage<Record<string, string>>('templates.json')
  if (!raw || typeof raw !== 'object') return
  const clean: Record<string, string> = {}
  for (const [folder, path] of Object.entries(raw)) {
    if (typeof path === 'string' && path) clean[normPath(folder)] = normPath(path)
  }
  assignments.value = clean
}

async function persist(): Promise<void> {
  await writeBackstage('templates.json', assignments.value)
}

/** The template assigned to a folder, as stored — it may no longer exist. */
export function assignedTemplate(folder: string): string | undefined {
  return assignments.value[normPath(folder)]
}

/**
 * The assigned template as an actual note, or undefined if there isn't one any
 * more.
 *
 * The two are worth telling apart. An assignment is a path, and a path goes
 * stale the moment somebody renames or deletes the template it pointed at —
 * at which point the folder still *has* an assignment and simply stops
 * applying anything. Menus name what this returns, so a template that has gone
 * says so instead of leaving a folder quietly doing nothing.
 */
export function resolvedTemplate(folder: string): NoteIndexEntry | undefined {
  const path = assignedTemplate(folder)
  if (!path) return undefined
  return templateNotes.value.find((n) => n.path === path)
}

/** Assign a template to a folder, or pass undefined to clear it. */
export async function setFolderTemplate(
  folder: string,
  templatePath: string | undefined,
): Promise<void> {
  const key = normPath(folder)
  const next = { ...assignments.value }
  if (templatePath) next[key] = normPath(templatePath)
  else delete next[key]
  assignments.value = next
  await persist()
}

/**
 * Follow a folder that has been renamed or moved.
 *
 * The assignments are keyed by folder path, so without this, renaming `Work` to
 * `Work 2026` would quietly strand every template under it — the folder would
 * still be there, still look the same, and simply stop applying its template.
 * Called from `renameFolder`, beside the same fixup it does for the folders it
 * records itself.
 */
export async function repointTemplateFolders(from: string, to: string): Promise<void> {
  const src = normPath(from)
  const dest = normPath(to)
  let touched = false
  const next: Record<string, string> = {}
  for (const [folder, path] of Object.entries(assignments.value)) {
    const moved = folder === src || folder.startsWith(`${src}/`)
    if (moved) touched = true
    next[moved ? `${dest}${folder.slice(src.length)}` : folder] = path
  }
  if (!touched) return
  assignments.value = next
  await persist()
}

/** Forget a folder's assignment, for when the folder itself is deleted. */
export async function clearTemplateFolders(path: string): Promise<void> {
  const src = normPath(path)
  const next: Record<string, string> = {}
  let touched = false
  for (const [folder, template] of Object.entries(assignments.value)) {
    if (folder === src || folder.startsWith(`${src}/`)) touched = true
    else next[folder] = template
  }
  if (!touched) return
  assignments.value = next
  await persist()
}

/* -------------------------------------------------------------- expansion */

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']

/**
 * The date formats a token may ask for, longest first.
 *
 * Longest first is not a style choice: `MMMM` has to be consumed before `MMM`,
 * or "September" is built out of "Sep" plus a stray "M".
 */
const FORMATS: Array<[string, (d: Date) => string]> = [
  ['YYYY', (d) => String(d.getFullYear())],
  ['YY', (d) => String(d.getFullYear()).slice(-2)],
  ['MMMM', (d) => MONTHS[d.getMonth()]],
  ['MMM', (d) => MONTHS[d.getMonth()].slice(0, 3)],
  ['MM', (d) => String(d.getMonth() + 1).padStart(2, '0')],
  ['M', (d) => String(d.getMonth() + 1)],
  ['DDDD', (d) => DAYS[d.getDay()]],
  ['DDD', (d) => DAYS[d.getDay()].slice(0, 3)],
  ['DD', (d) => String(d.getDate()).padStart(2, '0')],
  ['D', (d) => String(d.getDate())],
  ['HH', (d) => String(d.getHours()).padStart(2, '0')],
  ['H', (d) => String(d.getHours())],
  ['mm', (d) => String(d.getMinutes()).padStart(2, '0')],
  ['ss', (d) => String(d.getSeconds()).padStart(2, '0')],
]

/** Apply a `YYYY-MM-DD`-style pattern. Anything unrecognised is kept as typed. */
export function formatDate(when: number, pattern: string): string {
  const d = new Date(when)
  let out = ''
  let i = 0
  outer: while (i < pattern.length) {
    for (const [token, render] of FORMATS) {
      if (pattern.startsWith(token, i)) {
        out += render(d)
        i += token.length
        continue outer
      }
    }
    out += pattern[i++]
  }
  return out
}

export interface TemplateContext {
  /** What the note is called — `{{title}}`. */
  title: string
  /**
   * The moment the note is *for*, which is not always now: a daily note
   * written on Saturday about Thursday is Thursday's note, and its `{{date}}`
   * has to say so.
   */
  when: number
}

export interface TemplateBody {
  text: string
  /** Where the caret belongs: the `{{cursor}}`, or the end of the template. */
  caret: number
}

const TOKEN = /\{\{([a-z]+)(?::([^}]*))?\}\}/gi

/**
 * Fill in a template's tokens.
 *
 * The set is deliberately small and closed — `title`, `date`, `time`, `year`,
 * `month`, `day`, `weekday`, `cursor` — because the line between "a few fields
 * filled in" and "a template language with conditionals in it" is one that gets
 * crossed a token at a time. `date` and `time` take a pattern
 * (`{{date:DDDD, D MMMM YYYY}}`) which covers the rest of what the fixed
 * tokens would otherwise have to enumerate.
 *
 * A token nobody recognises is left exactly as it was written. A typo should
 * look like a typo in the note, not disappear into it.
 */
export function expandTemplate(text: string, ctx: TemplateContext): TemplateBody {
  let caret: number | undefined
  let out = ''
  let last = 0
  TOKEN.lastIndex = 0
  let m: RegExpExecArray | null

  /*
   * Built by hand rather than with `String.replace`, because of the caret.
   * A replace callback is handed the offset of the match in the *input*, and
   * every field filled in before it has already changed the length — a
   * `{{title}}` standing in for "Ab" moves everything after it seven
   * characters left. The caret has to index the text the note will actually
   * hold, so it is taken from the output as it is assembled.
   */
  while ((m = TOKEN.exec(text))) {
    out += text.slice(last, m.index)
    last = m.index + m[0].length
    const name = m[1].toLowerCase()
    const arg = m[2]
    if (name === 'cursor') {
      // Only the first one counts; any others stay as text, because two carets
      // is not a thing an editor can offer.
      if (caret === undefined) caret = out.length
      else out += m[0]
      continue
    }
    out += fill(name, arg, ctx) ?? m[0]
  }
  out += text.slice(last)
  return { text: out, caret: caret ?? out.length }
}

/** One field, or undefined for a name that is not a field at all. */
function fill(name: string, arg: string | undefined, ctx: TemplateContext): string | undefined {
  switch (name) {
    case 'title':
      return ctx.title
    case 'date':
      return formatDate(ctx.when, arg || 'YYYY-MM-DD')
    case 'time':
      return formatDate(ctx.when, arg || 'HH:mm')
    case 'year':
      return formatDate(ctx.when, 'YYYY')
    case 'month':
      return formatDate(ctx.when, arg || 'MM')
    case 'day':
      return formatDate(ctx.when, arg || 'DD')
    case 'weekday':
      return formatDate(ctx.when, arg || 'DDDD')
    default:
      return undefined
  }
}

/* --------------------------------------------------------------- applying */

/**
 * The body a new note in this folder should start with, or undefined for none.
 *
 * The match is on the folder itself and no other: a template on `Work` does not
 * reach `Work/Projects`. Inheritance would be a second rule to hold in your
 * head for the sake of a case nobody has asked for yet, and — more to the point
 * — a template on the vault root would then silently apply to every note in the
 * vault, which is exactly the way an optional feature stops feeling optional.
 */
export function templateBodyFor(
  folder: string,
  title: string,
  when = Date.now(),
): TemplateBody | undefined {
  // A template is a note like any other, so making one would otherwise be the
  // one place a template applies to itself.
  if (isTemplatePath(folder)) return undefined
  const path = assignedTemplate(folder)
  if (!path) return undefined
  const file = getRaw(path)
  if (!file || file.deleted || !file.text?.trim()) return undefined
  /*
   * A note that has not been named yet has no title to give, and "Untitled" is
   * the absence of one rather than one of its own. Writing that word into a
   * heading would be worse than leaving the heading empty, so `{{title}}` comes
   * out as nothing and a `{{cursor}}` beside it lands in the gap.
   *
   * That is what lets one `# {{title}}{{cursor}}` be right everywhere: a daily
   * note or one made from a `[[link]]` is named already and gets its heading,
   * and one made with *New note here* gets an empty heading to type into.
   */
  return expandTemplate(file.text, { title: title === UNTITLED ? '' : title, when })
}

/** The same, for a note being filed under a particular day. */
export function templateBodyForDay(
  folder: string,
  title: string,
  day: number,
): TemplateBody | undefined {
  return templateBodyFor(folder, title, startOfDay(day))
}

/** Folders that could sensibly carry a template — everything but Templates/. */
export function templatableFolder(path: string): boolean {
  return !isTemplatePath(path)
}

/** Where a template note lives, for showing it in a picker. */
export function templateLabel(path: string): string {
  const dir = dirname(path)
  return dir === TEMPLATES_FOLDER ? '' : dir.slice(TEMPLATES_FOLDER.length + 1)
}
