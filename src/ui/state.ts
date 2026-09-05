/** UI-only state: what's selected, what's filtered, which panels are open. */

import { computed, signal } from '@preact/signals'
import {
  contentNotes,
  getEntry,
  notes,
  notesByDay,
  search,
  trashFiles,
  trashTitle,
  attachments,
  unresolvedLinks,
  type SearchHit,
} from '../core/vault'
import { dailyNotePath } from '../core/daily'
import { notesForSmartFolder, showsTasks, smartFolderById } from '../core/folders'
import { settings } from '../core/settings'
import type { AppSettings, NoteIndexEntry, TaskItem } from '../core/types'
import { matchesAll, searchTerms, startOfDay } from '../core/util'
import { layoutMode } from './layout'

export type Scope =
  | { kind: 'all' }
  | { kind: 'folder'; path: string }
  | { kind: 'smart'; id: string }
  | { kind: 'tag'; tag: string }
  | { kind: 'day'; date: number }
  | { kind: 'tasks' }
  | { kind: 'files' }
  | { kind: 'unlinked' }
  | { kind: 'trash' }

export const scope = signal<Scope>({ kind: 'all' })
export const query = signal('')

/**
 * Change what the note list is showing.
 *
 * Every navigation goes through here rather than assigning `scope` directly,
 * because a search belongs to the list it was typed into. Carrying "budget"
 * from Notes into Files would hand you an empty Files list with no visible
 * reason for it — the query would be sitting in a box you have already
 * stopped looking at. So changing scope clears it, and the search box is
 * always about the list underneath it.
 */
export function setScope(s: Scope) {
  query.value = ''
  scope.value = s
}
export const activePath = signal<string | undefined>(undefined)
export const selectedDay = signal<number>(startOfDay(Date.now()))
export const calendarMonth = signal<number>(startOfDay(Date.now()))

/** Open state of the phone's Format sheet (rich mode). */
export const formatSheetOpen = signal(false)

/**
 * Focus mode: the note takes the whole window, and everything else stands down.
 *
 * A desktop idea only — a phone's editor is already the whole screen — so the
 * shell only ever reads it outside compact, and the button that sets it is not
 * rendered there. It is deliberately *not* a saved preference: focus mode is
 * something you enter for a stretch of writing, and an app that reopened three
 * days later with its sidebar still missing would look broken rather than
 * focused.
 */
export const editorMaximized = signal(false)

/**
 * Whether the open note is being read rather than written in.
 *
 * A note opens as a page — the whole pane given to the text, no caret in it and
 * so no keyboard covering half of it before you have read a word. Tapping the
 * note is what asks for an editing surface; the editor pane owns the switch and
 * decides which way a note opens. See editor/reading.ts for the mechanism.
 */
export const readingMode = signal(true)

/* ------------------------------------------------------------ editor mode */

export const EDITOR_MODES = [
  { id: 'rich', label: 'Rich text', detail: 'Formatting bar, no markdown symbols' },
  { id: 'live', label: 'Live preview', detail: 'Syntax shown on the line you are editing' },
  { id: 'source', label: 'Markdown source', detail: 'The file exactly as it is written' },
] as const

export type EditorModeId = (typeof EDITOR_MODES)[number]['id']

export function editorModeLabel(id: EditorModeId): string {
  return EDITOR_MODES.find((m) => m.id === id)?.label ?? id
}

/** The mode ⌘⇧M moves to next. Cycling beats three separate shortcuts. */
export function nextEditorMode(id: EditorModeId): EditorModeId {
  const i = EDITOR_MODES.findIndex((m) => m.id === id)
  return EDITOR_MODES[(i + 1) % EDITOR_MODES.length].id
}

/**
 * The Files browser, narrowed to files no note references. Off by default —
 * it is a way to work through the orphans, not a permanent view of the vault.
 */
export const orphansOnly = signal(false)

export const paletteOpen = signal(false)
export const settingsOpen = signal(false)
export const historyOpen = signal(false)
export const lightboxPath = signal<string | undefined>(undefined)
export interface Toast {
  text: string
  kind: 'info' | 'error'
  /** One thing the toast offers to do. It dismisses itself either way. */
  action?: { label: string; run: () => void }
}

export const toast = signal<Toast | undefined>(undefined)

/* ------------------------------------------------------------ mobile shell */

export type MobileTab = 'notes' | 'tasks' | 'calendar' | 'more'

export const mobileTab = signal<MobileTab>('notes')
/** On compact, the editor is pushed over the tab as a full-screen view. */
export const mobileEditorOpen = signal(false)

/**
 * The note that asked to be opened for writing rather than reading.
 *
 * Module-level and consumed once, by the editor as it opens that note: it is a
 * message about a single opening, not a state anything else should be able to
 * read back later.
 */
let openForWriting: string | undefined
let openCaret: number | undefined
let takenCaret: number | undefined

/**
 * Open a note from anywhere. On a phone this also pushes the editor over the
 * current tab, so tapping a note in Tasks or the calendar goes straight to the
 * note rather than silently changing something off-screen.
 *
 * `editing` is for a note that was just created to be typed into: it opens with
 * the caret in it, because there is nothing in it to read yet.
 */
export function openNote(path: string, opts?: { editing?: boolean; caret?: number }) {
  openForWriting = opts?.editing ? path : undefined
  openCaret = opts?.editing ? opts.caret : undefined
  activePath.value = path
  if (layoutMode.value === 'compact') mobileEditorOpen.value = true
}

/** True once, for a note that was opened to be written in rather than read. */
function takeEditRequest(path: string): boolean {
  const asked = openForWriting === path
  takenCaret = asked ? openCaret : undefined
  openForWriting = undefined
  openCaret = undefined
  return asked
}

/**
 * Where the caret goes in a note that was just opened for writing.
 *
 * Consumed with the request above and only meaningful straight after it: a
 * template can say where writing should start with `{{cursor}}`, and without
 * one the caret goes to the end of what the template put there rather than to
 * position 0, where the first thing typed would land inside the heading.
 */
export function takeOpenCaret(): number | undefined {
  const caret = takenCaret
  takenCaret = undefined
  return caret
}

/**
 * Which way a note opens: as a page to read, or with the caret already in it.
 *
 * Emptiness is the honest test for "brand new". There is nothing in it to read,
 * so opening it as a page would be a blank screen asking to be tapped. The
 * request covers the rest of the same case: notes the shell seeds with a
 * template — a daily note, a note created inside a Tag Folder — which are as
 * new as an empty one even though the file is not empty.
 *
 * A note in Deleted always opens as a page. There is nothing to be
 * done to it until it is restored.
 */
export function opensForWriting(path: string, text: string, trashed: boolean): boolean {
  // Consumed either way: a request left lying around would answer for whichever
  // note happened to be opened next.
  const asked = takeEditRequest(path)
  return !trashed && (asked || text.trim() === '')
}

/**
 * Open a day's daily note, creating it if that day doesn't have one yet.
 *
 * The toast only appears on creation, and names the file: the note lands in
 * `Daily/`, which is rarely the folder you were looking at when you asked for
 * it, and a note that appears in a folder you cannot see is a note you think
 * you have lost.
 */
export async function openDailyNote(day: number) {
  const { path, created, caret } = await dailyNotePath(day)
  // A day that had no note has one now — its own date, or whatever template
  // `Daily/` carries. It was created to be written in, so it opens for that.
  openNote(path, { editing: created, caret })
  if (created) notify(`Created ${path}`)
}

/**
 * What a click on a calendar day is asking for.
 *
 * `filter` — narrow the list to that day, the calendar as an index of what is
 * already written. `clear` — the same click on the day already showing, which
 * takes the filter back off. `open` — that day's daily note, in the mode where
 * the calendar is a journal. `offer` — the same, on a day that hasn't got one:
 * the note is not created until the question has been answered, because a click
 * on an empty day is a guess about intent and a file written on a guess is a
 * file somebody has to go and delete.
 *
 * Split out from the click handler, and pure, so the whole rule reads in one
 * place and can be checked without a calendar to click on.
 */
export type DayIntent = 'filter' | 'clear' | 'open' | 'offer'

export function calendarDayIntent(
  mode: AppSettings['calendarDayOpens'],
  day: { hasDaily: boolean; isSelected: boolean },
): DayIntent {
  if (mode === 'daily') return day.hasDaily ? 'open' : 'offer'
  return day.isSelected ? 'clear' : 'filter'
}

export function closeMobileEditor() {
  mobileEditorOpen.value = false
  // Leaving the note leaves formatting too; otherwise the sheet is waiting,
  // still open, the next time a note is opened.
  formatSheetOpen.value = false
}

/* ------------------------------------------------------------------ toasts */

let toastTimer: ReturnType<typeof setTimeout> | undefined
export function notify(
  text: string,
  kind: 'info' | 'error' = 'info',
  action?: { label: string; run: () => void },
) {
  toast.value = { text, kind, action }
  if (toastTimer) clearTimeout(toastTimer)
  // A toast with something to press has to outlast a glance at it; one that
  // only reports has said everything it has to say by the time you look.
  const ms = action ? 8000 : kind === 'error' ? 7000 : 3200
  toastTimer = setTimeout(() => (toast.value = undefined), ms)
}

export function dismissToast() {
  if (toastTimer) clearTimeout(toastTimer)
  toast.value = undefined
}

/* ------------------------------------------------------------------ search */

/**
 * What the search box searches.
 *
 * The rule is that search filters *the kind of thing the list is showing*, not
 * some fixed corpus. So Files searches files and Deleted searches deleted
 * things, and typing in either no longer swaps the list out from under you for
 * note results — which is what it used to do, while the header went on naming
 * the scope you thought you were in.
 *
 * Everything that shows notes — All Notes, a folder, a Tag Folder, a tag, a
 * day — searches notes, vault-wide. That is the convention every notes app
 * follows, and it means a search is never quietly limited to a folder you
 * happened to have open. A Tag Folder that gathers tasks lands on 'tasks' by
 * the same rule: what is in front of you is tasks.
 */
export type SearchKind = 'notes' | 'tasks' | 'files' | 'trash' | 'unlinked'

export const searchKind = computed<SearchKind>(() => {
  const s = scope.value
  switch (s.kind) {
    case 'files':
      return 'files'
    case 'trash':
      return 'trash'
    case 'unlinked':
      return 'unlinked'
    case 'tasks':
      return 'tasks'
    case 'smart':
      return showsTasks(smartFolderById(s.id)) ? 'tasks' : 'notes'
    default:
      return 'notes'
  }
})

/** What the search box and the header call what they are searching. */
export function searchLabel(k: SearchKind): string {
  switch (k) {
    case 'tasks':
      return 'Tasks'
    case 'files':
      return 'Files'
    case 'trash':
      return 'Deleted'
    case 'unlinked':
      return 'Unlinked'
    case 'notes':
      return 'Notes'
  }
}

/**
 * The terms a list has to match, empty when nothing is being searched.
 *
 * Exported because the rows mark them: a result row shows the words you typed
 * where they appear, in the title and in the snippet.
 */
export const queryTerms = computed(() => searchTerms(query.value))

const terms = queryTerms

/** True while the search box has something in it. */
export const searching = computed(() => terms.value.length > 0)

/**
 * The ranked note hits for the current query, scored once.
 *
 * Both the list and the snippets come off this, so `search()` runs a single
 * time per query rather than once for each — the scan is linear over every
 * note body, which is cheap enough to do on a keystroke and not cheap enough
 * to do twice.
 */
const noteHits = computed<SearchHit[]>(() =>
  searchKind.value === 'notes' && searching.value ? search(query.value) : [],
)

/**
 * Path -> the bit of the note the query matched.
 *
 * `search()` has always built these and the list has always thrown them away,
 * so a search showed you the opening line of each note and left you to guess
 * which word in it you were looking for. A title-only match has no body
 * position to centre on and is absent here, and the row keeps its excerpt.
 */
export const searchSnippets = computed(() => {
  const m = new Map<string, string>()
  for (const h of noteHits.value) if (h.snippet) m.set(h.entry.path, h.snippet)
  return m
})

export function scopeLabel(s: Scope): string {
  switch (s.kind) {
    case 'all':
      return 'All Notes'
    case 'folder':
      return s.path.split('/').pop() || 'All Notes'
    case 'smart':
      return smartFolderById(s.id)?.name ?? 'Tag Folder'
    case 'tag':
      return `#${s.tag}`
    case 'day':
      return new Date(s.date).toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      })
    case 'tasks':
      return 'Tasks'
    case 'files':
      return 'Files'
    case 'unlinked':
      return 'Unlinked mentions'
    case 'trash':
      return 'Deleted'
  }
}

/** The notes shown in the middle column, after scope and search are applied. */
export const visibleNotes = computed<NoteIndexEntry[]>(() => {
  // A scope showing files, tasks or deleted things has its own list below and
  // no notes to contribute, searching or not.
  if (searchKind.value !== 'notes') return []
  if (searching.value) return noteHits.value.map((h) => h.entry)

  const s = scope.value
  const sort = settings.value.sortBy
  let list: NoteIndexEntry[]

  switch (s.kind) {
    case 'folder':
      list = notes.value.filter((n) => n.folder === s.path || n.folder.startsWith(`${s.path}/`))
      break
    case 'smart':
      // Goes through the folder rather than its raw rule so inheritance from
      // parent folders and the group-folder union are both applied.
      list = smartFolderById(s.id) ? notesForSmartFolder(s.id) : []
      break
    case 'tag':
      list = contentNotes.value.filter((n) =>
        n.tags.some((t) => t === s.tag || t.startsWith(`${s.tag}/`)),
      )
      break
    case 'day': {
      const paths = new Set(notesByDay.value.get(startOfDay(s.date)) ?? [])
      list = contentNotes.value.filter((n) => paths.has(n.path))
      break
    }
    case 'tasks':
      /*
       * Tasks are not notes. The row counts tasks, so it lists tasks: the
       * middle column renders them from the task index directly, the same
       * rows the rail and the phone tab use. Nothing for the note list here.
       */
      return []
    case 'trash':
      return []
    case 'files':
      return []
    case 'unlinked':
      return []
    default:
      /*
       * All Notes, and every other roll-up above it. The `folder` case above
       * is deliberately not one of these: browsing `Templates/` has to show
       * what is in it, which is the whole way a template gets edited.
       */
      list = contentNotes.value
  }

  const cmp =
    sort === 'title'
      ? (a: NoteIndexEntry, b: NoteIndexEntry) => a.title.localeCompare(b.title)
      : sort === 'ctime'
        ? (a: NoteIndexEntry, b: NoteIndexEntry) => b.ctime - a.ctime
        : (a: NoteIndexEntry, b: NoteIndexEntry) => b.mtime - a.mtime

  // Pinned notes float to the top, exactly like Apple Notes.
  return [...list].sort((a, b) => (a.pinned === b.pinned ? cmp(a, b) : a.pinned ? -1 : 1))
})

/*
 * The three lists that are not notes, each filtered by the search box when the
 * search box is theirs. Matching is on what the row actually shows — a name, a
 * path, a preview — because that is what somebody typing into a list of files
 * is aiming at; the ranked full-text scorer in core/vault.ts is for note
 * bodies and stays there.
 */

export const trashList = computed(() =>
  trashFiles.value.filter(
    (f) => matchesAll(`${trashTitle(f.path)} ${f.text ?? ''}`, terms.value),
  ),
)

export const fileList = computed(() =>
  attachments.value.filter((f) => matchesAll(f.path, terms.value)),
)

export const unlinkedList = computed(() =>
  [...unresolvedLinks.value.entries()].filter(([target, sources]) =>
    matchesAll(`${target} ${sources.map((p) => getEntry(p)?.title ?? p).join(' ')}`, terms.value),
  ),
)

/** Tasks for the Tasks row, filtered the same way. */
export function matchingTasks(list: TaskItem[]): TaskItem[] {
  if (!terms.value.length) return list
  return list.filter((t) =>
    matchesAll(`${t.text} ${getEntry(t.path)?.title ?? t.noteTitle}`, terms.value),
  )
}

/** Date-bucketed sections for the note list, mirroring Apple Notes' grouping. */
export interface Section {
  title: string
  items: NoteIndexEntry[]
}

export const sections = computed<Section[]>(() => {
  const list = visibleNotes.value
  const sortBy = settings.value.sortBy
  if (query.value.trim()) return [{ title: `${list.length} found`, items: list }]

  /*
   * Pinned notes are their own section in every sort order, sorted among
   * themselves the same way everything else is. Sorting by title used to skip
   * the split entirely, which quietly un-pinned the whole list.
   */
  const pinned = list.filter((n) => n.pinned)
  const rest = list.filter((n) => !n.pinned)

  if (sortBy === 'title') {
    const out: Section[] = []
    if (pinned.length) out.push({ title: 'Pinned', items: pinned })
    if (rest.length) out.push({ title: pinned.length ? 'Notes' : '', items: rest })
    return out
  }

  const now = startOfDay(Date.now())
  const day = 86_400_000
  const buckets: Section[] = [
    { title: 'Today', items: [] },
    { title: 'Yesterday', items: [] },
    { title: 'Previous 7 Days', items: [] },
    { title: 'Previous 30 Days', items: [] },
  ]
  const older = new Map<string, NoteIndexEntry[]>()

  for (const n of rest) {
    const t = startOfDay(sortBy === 'ctime' ? n.ctime : n.mtime)
    const age = (now - t) / day
    if (age <= 0) buckets[0].items.push(n)
    else if (age < 2) buckets[1].items.push(n)
    else if (age < 8) buckets[2].items.push(n)
    else if (age < 31) buckets[3].items.push(n)
    else {
      const label = new Date(t).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
      const arr = older.get(label)
      if (arr) arr.push(n)
      else older.set(label, [n])
    }
  }

  const out: Section[] = []
  if (pinned.length) out.push({ title: 'Pinned', items: pinned })
  for (const b of buckets) if (b.items.length) out.push(b)
  for (const [title, items] of older) out.push({ title, items })
  return out
})
