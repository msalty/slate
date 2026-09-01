/** UI-only state: what's selected, what's filtered, which panels are open. */

import { computed, signal } from '@preact/signals'
import {
  notes,
  notesByDay,
  search,
  trashItems,
  attachments,
  unresolvedLinks,
} from '../core/vault'
import { notesForSmartFolder, smartFolderById } from '../core/folders'
import { settings } from '../core/settings'
import type { NoteIndexEntry } from '../core/types'
import { startOfDay } from '../core/util'
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
export const activePath = signal<string | undefined>(undefined)
export const selectedDay = signal<number>(startOfDay(Date.now()))
export const calendarMonth = signal<number>(startOfDay(Date.now()))

/** Open state of the phone's Format sheet (rich mode). */
export const formatSheetOpen = signal(false)

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

export const paletteOpen = signal(false)
export const settingsOpen = signal(false)
export const historyOpen = signal(false)
export const lightboxPath = signal<string | undefined>(undefined)
export const toast = signal<{ text: string; kind: 'info' | 'error' } | undefined>(undefined)

/* ------------------------------------------------------------ mobile shell */

export type MobileTab = 'notes' | 'tasks' | 'calendar' | 'more'

export const mobileTab = signal<MobileTab>('notes')
/** On compact, the editor is pushed over the tab as a full-screen view. */
export const mobileEditorOpen = signal(false)

/**
 * Open a note from anywhere. On a phone this also pushes the editor over the
 * current tab, so tapping a note in Tasks or the calendar goes straight to
 * writing rather than silently changing something off-screen.
 */
export function openNote(path: string) {
  activePath.value = path
  if (layoutMode.value === 'compact') mobileEditorOpen.value = true
}

export function closeMobileEditor() {
  mobileEditorOpen.value = false
}

/* ------------------------------------------------------------------ toasts */

let toastTimer: ReturnType<typeof setTimeout> | undefined
export function notify(text: string, kind: 'info' | 'error' = 'info') {
  toast.value = { text, kind }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = undefined), kind === 'error' ? 7000 : 3200)
}

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
      return 'Recently Deleted'
  }
}

/** The notes shown in the middle column, after scope and search are applied. */
export const visibleNotes = computed<NoteIndexEntry[]>(() => {
  const q = query.value.trim()
  if (q) return search(q).map((h) => h.entry)

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
      list = notes.value.filter((n) => n.tags.some((t) => t === s.tag || t.startsWith(`${s.tag}/`)))
      break
    case 'day': {
      const paths = new Set(notesByDay.value.get(startOfDay(s.date)) ?? [])
      list = notes.value.filter((n) => paths.has(n.path))
      break
    }
    case 'tasks':
      list = notes.value.filter((n) => n.hasTasks)
      break
    case 'trash':
      return []
    case 'files':
      return []
    case 'unlinked':
      return []
    default:
      list = notes.value
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

export const trashList = computed(() => trashItems())
export const fileList = computed(() => attachments.value)
export const unlinkedList = computed(() => [...unresolvedLinks.value.entries()])

/** Date-bucketed sections for the note list, mirroring Apple Notes' grouping. */
export interface Section {
  title: string
  items: NoteIndexEntry[]
}

export const sections = computed<Section[]>(() => {
  const list = visibleNotes.value
  const sortBy = settings.value.sortBy
  if (query.value.trim()) return [{ title: `${list.length} found`, items: list }]
  if (sortBy === 'title') return [{ title: '', items: list }]

  const pinned = list.filter((n) => n.pinned)
  const rest = list.filter((n) => !n.pinned)
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
