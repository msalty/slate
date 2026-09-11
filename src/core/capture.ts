/**
 * Quick capture: a line of text into a file, without opening the editor.
 *
 * Everything else that makes content in Slate creates a note and hands you the
 * editor — right for writing a note, wrong for the thing you do twenty times a
 * day, which is putting one line somewhere before you forget it. The cost of
 * that used to be five taps and a file called `Untitled.md` left behind by
 * every capture you thought better of.
 *
 * Two rules shape what is here. **Nothing is written until you commit**: this
 * module is only ever called from the Add button, so a sheet that is opened
 * and dismissed costs the vault nothing. And **the destination is a setting,
 * not a question**: a task goes where `quickAddTaskTarget` says, and the sheet
 * names the file rather than asking for one.
 *
 * The text transforms are pure and separately testable, because that is where
 * the behaviour actually is — the writing half is two lines of `saveNote`.
 */

import { contentNotes, createNote, getRaw, saveNote, UNTITLED } from './vault'
import { DAILY_FOLDER, dailyNoteFor, dailyNoteName, dailyNotePath } from './daily'
import { settings } from './settings'
import { codeRegions, inRegions, isLocked, parseFrontmatter, withDue } from './markdown'
import { templateBodyFor } from './templates'
import { joinPath, startOfDay } from './util'

/** The note a capture falls back to when it isn't going to a daily note. */
export const INBOX_TITLE = 'Inbox'

/* ------------------------------------------------------------------- text */

const HEADING = /^(#{1,6})\s+(.*)$/
/** `- `, `* `, `+ `, `1. `, `1) `, each optionally carrying a checkbox. */
const MARKER = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/

/** A heading line's own words, for comparing one heading to another. */
function headingLabel(s: string): string {
  return (HEADING.exec(s.trim())?.[2] ?? s).trim().toLowerCase()
}

/**
 * The text of a captured line, with any marker it arrived wearing removed.
 *
 * Text pasted out of another list turns up as `- [ ] Call the vet`, and
 * prefixing that again would give `- [ ] - [ ] Call the vet`.
 */
export function stripMarker(line: string): string {
  return line.replace(MARKER, '').replace(/^#{1,6}\s+/, '').trim()
}

/** A line that a new list item can sit directly beneath, with no blank between. */
function joinsDirectly(line: string): boolean {
  return line.trim() === '' || HEADING.test(line) || MARKER.test(line)
}

/** Trailing blank lines, so appending twice doesn't open a widening gap. */
function withoutTrailingBlanks(lines: string[]): string[] {
  const out = [...lines]
  while (out.length && out[out.length - 1].trim() === '') out.pop()
  return out
}

/**
 * Where a line belongs inside `heading`'s section, or undefined when the note
 * hasn't got that heading.
 *
 * The end of the section rather than the top of it: captures arrive in the
 * order they were thought of, and a list that grows upwards reads backwards.
 * A heading of any level matches — a vault that writes `# Tasks` should not be
 * given a second `## Tasks` underneath it — and one inside a fenced code block
 * matches nothing, since it is an example of a heading rather than one.
 */
function sectionEnd(text: string, lines: string[], heading: string): number | undefined {
  const want = headingLabel(heading)
  if (!want) return undefined
  const regions = codeRegions(text)
  const bodyStart = parseFrontmatter(text).bodyStart
  let offset = 0
  let found = -1
  let level = 0

  for (let i = 0; i < lines.length; i++) {
    const at = offset
    offset += lines[i].length + 1
    if (at < bodyStart) continue
    const m = HEADING.exec(lines[i])
    if (!m || inRegions(regions, at)) continue
    if (found < 0) {
      if (m[2].trim().toLowerCase() === want) {
        found = i
        level = m[1].length
      }
    } else if (m[1].length <= level) {
      // The next section of the same rank or higher has started; the one we
      // are filling ended above it.
      return lastContentLine(lines, found + 1, i)
    }
  }
  return found < 0 ? undefined : lastContentLine(lines, found + 1, lines.length)
}

/** The index just past the last non-blank line in `[from, to)`. */
function lastContentLine(lines: string[], from: number, to: number): number {
  let end = from
  for (let i = from; i < to; i++) if (lines[i].trim() !== '') end = i + 1
  return end
}

/**
 * Put `add` into `text`, under `heading` when the note has one and at the end
 * of the file otherwise — writing the heading as it goes, so the second
 * capture of the day joins the first instead of starting another list.
 *
 * An empty `heading` means the end of the file, always. Frontmatter is never
 * touched: the search starts at the body, and the end of the file is past it
 * by definition.
 */
export function insertLines(text: string, heading: string, add: string[]): string {
  if (!add.length) return text
  const lines = text.split('\n')
  const at = sectionEnd(text, lines, heading)

  if (at !== undefined) {
    const out = [...lines]
    const prev = out[at - 1] ?? ''
    out.splice(at, 0, ...(joinsDirectly(prev) ? [] : ['']), ...add)
    return out.join('\n')
  }

  const out = withoutTrailingBlanks(lines)
  const head = heading.trim()
  if (head) {
    if (out.length && out[out.length - 1].trim() !== '') out.push('')
    out.push(head)
  } else if (out.length && !joinsDirectly(out[out.length - 1])) {
    out.push('')
  }
  out.push(...add)
  // A file that ends without a newline is a file every diff complains about.
  return `${out.join('\n')}\n`
}

/**
 * One captured line per task.
 *
 * Splitting on newlines is what makes pasting a list work: three lines out of
 * a message become three tasks rather than one task with two orphan lines
 * under it. `withDue` is only called when a date was actually chosen — it
 * strips existing markers before writing the new one, so calling it with
 * `undefined` would quietly delete a date the user had typed themselves.
 */
export function taskLines(text: string, due?: number): string[] {
  return text
    .split('\n')
    .map((l) => stripMarker(l))
    .filter(Boolean)
    .map((l) => (due === undefined ? `- [ ] ${l}` : withDue(`- [ ] ${l}`, due)))
}

/**
 * The title a captured note takes, from its first line.
 *
 * This is the whole reason capture doesn't leave `Untitled.md` behind.
 * `createNote` cleans it into a file name, exactly as it does for a note
 * renamed after its heading.
 */
export function captureTitle(text: string): string {
  const first = text.split('\n').find((l) => l.trim()) ?? ''
  return stripMarker(first).slice(0, 120) || UNTITLED
}

/** Everything after the title line, which the body keeps as it was typed. */
function captureBody(text: string): string {
  const lines = text.split('\n')
  const i = lines.findIndex((l) => l.trim())
  return i < 0 ? '' : withoutTrailingBlanks(lines.slice(i + 1)).join('\n').replace(/^\n+/, '')
}

/* ------------------------------------------------------------ destination */

/** Where a captured task will be written, named before it is. */
export function taskDestination(day = startOfDay(Date.now())): string {
  if (settings.value.quickAddTaskTarget === 'inbox') {
    return inboxEntry()?.path ?? `${INBOX_TITLE}.md`
  }
  return dailyNoteFor(day)?.path ?? joinPath(DAILY_FOLDER, `${dailyNoteName(day)}.md`)
}

/** The `Inbox` note, wherever in the vault it happens to live. */
function inboxEntry() {
  const hits = contentNotes.value.filter((n) => n.title === INBOX_TITLE)
  return hits.find((n) => n.folder === '') ?? hits[0]
}

/** The Inbox note's path, making it on the first capture that needs one. */
async function inboxPath(): Promise<string> {
  const existing = inboxEntry()
  if (existing) return existing.path
  return createNote('', INBOX_TITLE, `# ${INBOX_TITLE}\n\n`)
}

/* ---------------------------------------------------------------- writing */

export type CaptureResult =
  | { ok: true; path: string; count: number }
  | { ok: false; reason: 'empty' | 'locked' }

/**
 * Write captured tasks into the configured note.
 *
 * `day` is the note it is filed in and `due` is the date on the task, because
 * they are not the same question: adding from the Tomorrow group files today's
 * capture with tomorrow's date on it, while the calendar's day panel is
 * literally that day's page and files there.
 *
 * A locked note refuses, the same way ticking a checkbox on one does — a
 * capture that vanished into a read-only file would be worse than one that
 * says it didn't land.
 */
export async function captureTasks(input: {
  text: string
  due?: number
  day?: number
}): Promise<CaptureResult> {
  const lines = taskLines(input.text, input.due)
  if (!lines.length) return { ok: false, reason: 'empty' }

  const day = startOfDay(input.day ?? Date.now())
  const path =
    settings.value.quickAddTaskTarget === 'inbox'
      ? await inboxPath()
      : (await dailyNotePath(day)).path

  const text = getRaw(path)?.text ?? ''
  if (isLocked(parseFrontmatter(text).data)) return { ok: false, reason: 'locked' }

  await saveNote(path, insertLines(text, settings.value.quickAddTaskHeading, lines))
  return { ok: true, path, count: lines.length }
}

/**
 * Write a captured note, titled from its first line.
 *
 * A folder carrying a template gets the template, with whatever else was typed
 * appended under it: the template is the shape of a note in that folder, and a
 * capture is still a note in that folder.
 */
export async function captureNote(input: { text: string; folder?: string }): Promise<CaptureResult> {
  const title = captureTitle(input.text)
  if (!input.text.trim()) return { ok: false, reason: 'empty' }

  const folder = input.folder ?? settings.value.quickAddNoteFolder
  const rest = captureBody(input.text)
  const t = templateBodyFor(folder, title)
  const body = t ? `${t.text}${rest ? `\n${rest}\n` : ''}` : `# ${title}\n\n${rest ? `${rest}\n` : ''}`

  const path = await createNote(folder, title, body)
  return { ok: true, path, count: 1 }
}

/* ----------------------------------------------------------------- launch */

/**
 * What a URL is asking the app to do on the way in.
 *
 * Three doors arrive here: the launcher shortcuts (`?add=task`), the Android
 * share sheet (`?title=…&text=…&url=…`, declared as a GET share target so no
 * service worker has to be in the loop), and an iOS Shortcut pointed at either
 * shape. Pure, because the interesting part is what a phone's share sheet
 * actually sends — which varies, and is worth having tests about.
 */
export type LaunchIntent =
  | { kind: 'capture'; mode: 'task' | 'note'; text: string }
  | { kind: 'daily' }

export function parseLaunchIntent(search: string): LaunchIntent | undefined {
  const q = new URLSearchParams(search)
  const add = q.get('add')
  if (q.get('open') === 'today') return { kind: 'daily' }

  const title = q.get('title')?.trim() ?? ''
  const text = q.get('text')?.trim() ?? ''
  const url = q.get('url')?.trim() ?? ''
  const shared = [title, text, url === '' || text.includes(url) ? '' : url]
    .filter(Boolean)
    .join('\n')

  if (add !== 'task' && add !== 'note') return shared ? { kind: 'capture', mode: 'note', text: shared } : undefined
  /*
   * A share names its own mode only when the URL says so. Everything else
   * shared into the app is prose or a link, which is a note; the sheet's
   * toggle is one tap away for the times it isn't.
   */
  return { kind: 'capture', mode: add, text: shared }
}

/** The parameters a launch consumes, cleared so a reload cannot capture twice. */
export const LAUNCH_PARAMS = ['add', 'open', 'title', 'text', 'url'] as const

export function clearedSearch(search: string): string {
  const q = new URLSearchParams(search)
  for (const k of LAUNCH_PARAMS) q.delete(k)
  const rest = q.toString()
  return rest ? `?${rest}` : ''
}
