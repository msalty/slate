/**
 * The vault: the single in-memory source of truth for the UI, backed by
 * IndexedDB, reconciled against a remote by the sync engine.
 *
 * Every mutation here follows the same order:
 *   1. update memory (UI is instant)
 *   2. persist to IndexedDB (survives a crash or a closed tab)
 *   3. mark dirty (the sync engine will push it when it next runs)
 *
 * Nothing waits on the network. That is the whole performance story: typing a
 * note is a memory write plus an IndexedDB put, and sync happens later.
 */

import { signal, computed } from '@preact/signals'
import {
  BACKSTAGE,
  TRASH,
  type NoteIndexEntry,
  type TaskItem,
  type VaultFile,
} from './types'
import {
  allFiles,
  deleteFileRow,
  getFile,
  putFile,
  putFiles,
  pushVersion,
  renameVersions,
} from './db'
import {
  calendarDateFor,
  excerptOf,
  parseFrontmatter,
  resolveTarget,
  scanMdLinks,
  scanTags,
  scanTasks,
  scanWikiLinks,
  splitSizeFragment,
  stripInline,
} from './markdown'
import {
  basename,
  dirname,
  hashBlob,
  hashText,

  joinPath,
  mimeForPath,
  normPath,
  safeSegment,
  startOfDay,
  titleFromPath,
} from './util'

/* ------------------------------------------------------------------- state */

/** path -> file. The authoritative in-memory copy. */
const files = new Map<string, VaultFile>()

/** Bumped on every structural change so computed signals recalculate. */
export const revision = signal(0)
export const ready = signal(false)

const indexMap = new Map<string, NoteIndexEntry>()

function bump() {
  revision.value = revision.value + 1
}

/** True for anything under backstage/ — hidden from every UI surface. */
export function isHidden(path: string): boolean {
  return path === BACKSTAGE || path.startsWith(`${BACKSTAGE}/`)
}

/* ------------------------------------------------------------------- index */

function buildEntry(f: VaultFile): NoteIndexEntry | undefined {
  if (f.kind !== 'note' || f.deleted) return undefined
  const text = f.text ?? ''
  const fm = parseFrontmatter(text)
  const tags = new Set(scanTags(text))
  const fmTags = fm.data.tags
  if (Array.isArray(fmTags)) for (const t of fmTags) tags.add(String(t).replace(/^#/, ''))
  else if (typeof fmTags === 'string' && fmTags) tags.add(fmTags.replace(/^#/, ''))

  const links: string[] = []
  const embeds: string[] = []
  for (const l of scanWikiLinks(text)) {
    if (l.embed) embeds.push(l.target)
    else links.push(l.target.toLowerCase())
  }
  for (const l of scanMdLinks(text)) {
    if (!l.embed) continue
    const [clean] = splitSizeFragment(l.url)
    if (!/^[a-z]+:/i.test(clean)) embeds.push(decodeURI(clean))
  }

  return {
    path: f.path,
    title: titleFromPath(f.path),
    folder: dirname(f.path),
    excerpt: excerptOf(text, fm.bodyStart),
    mtime: f.mtime,
    ctime: f.ctime,
    calendarDate: calendarDateFor(f.path, fm.data, f.ctime),
    tags: [...tags],
    links,
    embeds,
    pinned: fm.data.pinned === true,
    hasTasks: scanTasks(text).length > 0,
    size: f.size,
  }
}

function reindex(path: string) {
  const f = files.get(path)
  const e = f ? buildEntry(f) : undefined
  if (e) indexMap.set(path, e)
  else indexMap.delete(path)
}

function reindexAll() {
  indexMap.clear()
  for (const f of files.values()) {
    const e = buildEntry(f)
    if (e) indexMap.set(f.path, e)
  }
}

/* --------------------------------------------------------- derived signals */

/** Every visible note, newest first. Backstage is excluded. */
export const notes = computed<NoteIndexEntry[]>(() => {
  revision.value
  const out: NoteIndexEntry[] = []
  for (const e of indexMap.values()) if (!isHidden(e.path)) out.push(e)
  return out.sort((a, b) => b.mtime - a.mtime)
})

/** Non-note files the user can link to: images, PDFs, video, audio, etc. */
export const attachments = computed(() => {
  revision.value
  const out: VaultFile[] = []
  for (const f of files.values())
    if (f.kind === 'attachment' && !f.deleted && !isHidden(f.path)) out.push(f)
  return out.sort((a, b) => b.mtime - a.mtime)
})

export const allTags = computed<Array<{ tag: string; count: number }>>(() => {
  const counts = new Map<string, number>()
  for (const e of notes.value) for (const t of e.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => a.tag.localeCompare(b.tag))
})

/** title (lowercased) -> path, for wikilink resolution. */
export const titleIndex = computed(() => {
  const m = new Map<string, string>()
  for (const e of notes.value) {
    const k = e.title.toLowerCase()
    // First writer wins so link targets stay stable when titles collide.
    if (!m.has(k)) m.set(k, e.path)
  }
  return m
})

export const pathSet = computed(() => {
  revision.value
  const s = new Set<string>()
  for (const f of files.values()) if (!f.deleted) s.add(f.path)
  return s
})

export const tasks = computed<TaskItem[]>(() => {
  const out: TaskItem[] = []
  for (const e of notes.value) {
    if (!e.hasTasks) continue
    const f = files.get(e.path)
    if (!f?.text) continue
    for (const t of scanTasks(f.text)) {
      out.push({
        id: `${e.path}:${t.line}`,
        path: e.path,
        noteTitle: e.title,
        line: t.line,
        text: stripInline(t.text),
        done: t.done,
        due: t.due,
      })
    }
  }
  return out.sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1
    if (a.due && b.due) return a.due - b.due
    if (a.due) return -1
    if (b.due) return 1
    return a.noteTitle.localeCompare(b.noteTitle)
  })
})

/** date (local midnight ms) -> note paths filed under that day. */
export const notesByDay = computed(() => {
  const m = new Map<number, string[]>()
  for (const e of notes.value) {
    const arr = m.get(e.calendarDate)
    if (arr) arr.push(e.path)
    else m.set(e.calendarDate, [e.path])
  }
  return m
})

/** Reverse link map: path -> paths that link to it. */
export const backlinkMap = computed(() => {
  const titles = titleIndex.value
  const paths = pathSet.value
  const m = new Map<string, string[]>()
  for (const e of notes.value) {
    for (const target of e.links) {
      const resolved = resolveTarget(target, titles, paths)
      if (!resolved || resolved === e.path) continue
      const arr = m.get(resolved)
      if (arr) {
        if (!arr.includes(e.path)) arr.push(e.path)
      } else m.set(resolved, [e.path])
    }
  }
  return m
})

/** Wikilink targets that don't resolve to anything — offered as "create". */
export const unresolvedLinks = computed(() => {
  const titles = titleIndex.value
  const paths = pathSet.value
  const m = new Map<string, string[]>()
  for (const e of notes.value) {
    const f = files.get(e.path)
    if (!f?.text) continue
    for (const l of scanWikiLinks(f.text)) {
      if (l.embed) continue
      if (resolveTarget(l.target, titles, paths)) continue
      const arr = m.get(l.target)
      if (arr) {
        if (!arr.includes(e.path)) arr.push(e.path)
      } else m.set(l.target, [e.path])
    }
  }
  return m
})

/* ------------------------------------------------------------------ lookup */

export function getEntry(path: string): NoteIndexEntry | undefined {
  return indexMap.get(path)
}

export function getRaw(path: string): VaultFile | undefined {
  return files.get(path)
}

export function getText(path: string): string | undefined {
  return files.get(path)?.text
}

export function exists(path: string): boolean {
  const f = files.get(path)
  return !!f && !f.deleted
}

export function resolveLink(target: string): string | undefined {
  return resolveTarget(target, titleIndex.value, pathSet.value)
}

/** Resolve an embed reference relative to the note that contains it. */
export function resolveEmbed(ref: string, fromPath: string): string | undefined {
  const clean = decodeURI(ref.trim())
  if (!clean || /^[a-z]+:/i.test(clean)) return undefined
  const candidates = [
    normPath(clean),
    joinPath(dirname(fromPath), clean),
  ]
  for (const c of candidates) if (files.has(c) && !files.get(c)!.deleted) return c
  // Fall back to a basename match anywhere in the vault (Obsidian's shortest-path rule).
  const base = basename(clean).toLowerCase()
  for (const f of files.values())
    if (!f.deleted && basename(f.path).toLowerCase() === base) return f.path
  return undefined
}

/* ---------------------------------------------------------------- lifecycle */

export async function initVault(): Promise<void> {
  const rows = await allFiles()
  files.clear()
  for (const f of rows) files.set(f.path, f)
  reindexAll()
  ready.value = true
  bump()
}

/**
 * Install files that came from the remote. Used by the sync engine only —
 * these are not marked dirty because the remote already has them.
 */
export async function installFromRemote(list: VaultFile[]): Promise<void> {
  for (const f of list) {
    if (f.kind === 'note') {
      await pushVersion({ path: f.path, at: f.mtime, text: f.text ?? '', hash: f.hash, reason: 'sync-pull' })
    }
    files.set(f.path, f)
  }
  await putFiles(list)
  for (const f of list) reindex(f.path)
  bump()
}

/** Sync-engine hook: record that a file is now in agreement with the remote. */
export async function markSynced(
  path: string,
  patch: {
    baseHash: string
    baseText?: string
    remoteRev?: string
    remoteMtime?: number
  },
): Promise<void> {
  const f = files.get(path)
  if (!f) return
  // Only clear `dirty` when the content that was pushed is still the current
  // content. Otherwise the user typed during the upload and we'd drop the edit.
  const stillCurrent = f.hash === patch.baseHash
  const next: VaultFile = {
    ...f,
    dirty: stillCurrent ? false : f.dirty,
    sync: {
      baseHash: patch.baseHash,
      baseText: f.kind === 'note' ? patch.baseText : undefined,
      remoteRev: patch.remoteRev,
      remoteMtime: patch.remoteMtime,
      lastSyncedAt: Date.now(),
    },
  }
  files.set(path, next)
  await putFile(next)
  if (!stillCurrent) bump()
}

export function listAll(): VaultFile[] {
  return [...files.values()]
}

/* ----------------------------------------------------------------- writing */

async function writeFile(f: VaultFile): Promise<void> {
  files.set(f.path, f)
  await putFile(f)
}

/** Create a note. Returns its path. Guarantees a unique filename. */
export async function createNote(
  folder = '',
  title = 'Untitled',
  body = '',
): Promise<string> {
  const dir = normPath(folder)
  let name = safeSegment(title)
  let path = joinPath(dir, `${name}.md`)
  let n = 2
  while (files.has(path)) {
    name = `${safeSegment(title)} ${n++}`
    path = joinPath(dir, `${name}.md`)
  }
  const now = Date.now()
  const text = body
  const f: VaultFile = {
    path,
    kind: 'note',
    text,
    mime: 'text/markdown',
    size: text.length,
    hash: await hashText(text),
    mtime: now,
    ctime: now,
    dirty: true,
    sync: {},
  }
  await writeFile(f)
  reindex(path)
  bump()
  return path
}

/** Save note text. Called from the editor's debounced autosave. */
export async function saveNote(path: string, text: string): Promise<void> {
  const f = files.get(path)
  if (!f) return
  if (f.text === text) return
  const hash = await hashText(text)
  if (hash === f.hash) return
  await pushVersion({ path, at: Date.now(), text: f.text ?? '', hash: f.hash, reason: 'edit' })
  const next: VaultFile = {
    ...f,
    text,
    hash,
    size: text.length,
    mtime: Date.now(),
    dirty: true,
    deleted: false,
  }
  await writeFile(next)
  reindex(path)
  bump()
}

/**
 * Rename a note and rewrite every [[wikilink]] that pointed at the old title.
 * Link rewriting is what makes renaming safe rather than destructive.
 */
export async function renameNote(path: string, newTitle: string): Promise<string> {
  const f = files.get(path)
  if (!f || f.kind !== 'note') return path
  const oldTitle = titleFromPath(path)
  const clean = safeSegment(newTitle)
  if (!clean || clean === oldTitle) return path
  let next = joinPath(dirname(path), `${clean}.md`)
  let n = 2
  while (files.has(next) && next !== path) next = joinPath(dirname(path), `${clean} ${n++}.md`)

  await movePath(path, next)
  await rewriteLinksTo(oldTitle, clean)
  return next
}

/** Move a file to a new path, preserving history and sync bookkeeping. */
export async function movePath(from: string, to: string): Promise<void> {
  const f = files.get(from)
  if (!f || from === to) return
  // A move is a delete + create as far as any remote is concerned, so the old
  // path gets a tombstone and the new one starts fresh and dirty.
  const now = Date.now()
  const moved: VaultFile = { ...f, path: to, mtime: now, dirty: true, sync: {} }
  files.set(to, moved)
  await putFile(moved)
  await renameVersions(from, to)
  await tombstone(from)
  reindex(to)
  bump()
}

async function rewriteLinksTo(oldTitle: string, newTitle: string): Promise<void> {
  const lower = oldTitle.toLowerCase()
  const touched: VaultFile[] = []
  for (const f of files.values()) {
    if (f.kind !== 'note' || f.deleted || !f.text) continue
    const links = scanWikiLinks(f.text)
    const hits = links.filter((l) => l.target.toLowerCase() === lower)
    if (!hits.length) continue
    let text = f.text
    // Apply right-to-left so earlier offsets stay valid.
    for (const l of hits.reverse()) {
      const inner = [newTitle, l.anchor ? `#${l.anchor}` : '', l.alias !== undefined ? `|${l.alias}` : '']
        .join('')
      text = `${text.slice(0, l.from)}${l.embed ? '!' : ''}[[${inner}]]${text.slice(l.to)}`
    }
    const next: VaultFile = {
      ...f,
      text,
      hash: await hashText(text),
      size: text.length,
      mtime: Date.now(),
      dirty: true,
    }
    files.set(f.path, next)
    touched.push(next)
  }
  if (touched.length) {
    await putFiles(touched)
    for (const f of touched) reindex(f.path)
    bump()
  }
}

/**
 * Soft-delete. The file is moved to backstage/trash rather than removed, so a
 * delete is always recoverable and never races a concurrent edit on another
 * device into data loss.
 */
export async function deleteNote(path: string): Promise<void> {
  const f = files.get(path)
  if (!f) return
  if (f.kind === 'note') {
    await pushVersion({ path, at: Date.now(), text: f.text ?? '', hash: f.hash, reason: 'delete' })
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  let dest = joinPath(TRASH, `${stamp}--${basename(path)}`)
  let n = 2
  while (files.has(dest)) dest = joinPath(TRASH, `${stamp}--${n++}--${basename(path)}`)
  await movePath(path, dest)
}

export async function restoreFromTrash(trashPath: string, to?: string): Promise<string> {
  const name = basename(trashPath).replace(/^\d{4}-\d{2}-\d{2}T[\d-]+--(?:\d+--)?/, '')
  let dest = to ?? name
  let n = 2
  while (files.has(dest)) {
    const dot = name.lastIndexOf('.')
    dest = dot > 0 ? `${name.slice(0, dot)} ${n++}${name.slice(dot)}` : `${name} ${n++}`
  }
  await movePath(trashPath, dest)
  return dest
}

export function trashItems(): VaultFile[] {
  const out: VaultFile[] = []
  for (const f of files.values())
    if (!f.deleted && f.path.startsWith(`${TRASH}/`)) out.push(f)
  return out.sort((a, b) => b.mtime - a.mtime)
}

/**
 * Mark a path as deleted. The row stays until the sync engine confirms the
 * remote has dropped it too, which is what stops a delete from bouncing back.
 */
export async function tombstone(path: string): Promise<void> {
  const f = files.get(path)
  if (!f) return
  const next: VaultFile = {
    ...f,
    text: undefined,
    blob: undefined,
    size: 0,
    deleted: true,
    deletedAt: Date.now(),
    mtime: Date.now(),
    dirty: true,
  }
  files.set(path, next)
  await putFile(next)
  indexMap.delete(path)
  releaseUrl(path)
  bump()
}

/** Sync-engine hook: the tombstone has been honoured remotely, drop the row. */
export async function forget(path: string): Promise<void> {
  files.delete(path)
  indexMap.delete(path)
  await deleteFileRow(path)
  releaseUrl(path)
  bump()
}

/* ------------------------------------------------------------- attachments */

export async function addAttachment(
  blob: Blob,
  path: string,
): Promise<string> {
  const now = Date.now()
  let dest = normPath(path)
  let n = 2
  while (files.has(dest)) {
    const dot = dest.lastIndexOf('.')
    const base = dot > 0 ? dest.slice(0, dot) : dest
    const ext = dot > 0 ? dest.slice(dot) : ''
    dest = `${base}-${n++}${ext}`
  }
  const f: VaultFile = {
    path: dest,
    kind: 'attachment',
    blob,
    mime: blob.type || mimeForPath(dest),
    size: blob.size,
    hash: await hashBlob(blob),
    mtime: now,
    ctime: now,
    dirty: true,
    sync: {},
  }
  await writeFile(f)
  bump()
  return dest
}

/** Object URLs for attachments, created on demand and reused. */
const urlCache = new Map<string, string>()

export function attachmentUrl(path: string): string | undefined {
  const hit = urlCache.get(path)
  if (hit) return hit
  const f = files.get(path)
  if (!f?.blob) return undefined
  const url = URL.createObjectURL(f.blob)
  urlCache.set(path, url)
  return url
}

function releaseUrl(path: string) {
  const u = urlCache.get(path)
  if (u) {
    URL.revokeObjectURL(u)
    urlCache.delete(path)
  }
}

export function releaseAllUrls() {
  for (const u of urlCache.values()) URL.revokeObjectURL(u)
  urlCache.clear()
}

/* --------------------------------------------------------------- backstage */

/** Read a JSON file from backstage/. Returns undefined if absent or corrupt. */
export async function readBackstage<T>(name: string): Promise<T | undefined> {
  const path = joinPath(BACKSTAGE, name)
  const f = files.get(path) ?? (await getFile(path))
  if (!f?.text) return undefined
  try {
    return JSON.parse(f.text) as T
  } catch {
    return undefined
  }
}

/** Write a JSON file into backstage/. Synced like any other file, hidden in UI. */
export async function writeBackstage(name: string, value: unknown): Promise<void> {
  const path = joinPath(BACKSTAGE, name)
  const text = JSON.stringify(value, null, 2)
  const existing = files.get(path)
  if (existing?.text === text) return
  const now = Date.now()
  const f: VaultFile = {
    path,
    kind: 'note',
    text,
    mime: 'application/json',
    size: text.length,
    hash: await hashText(text),
    mtime: now,
    ctime: existing?.ctime ?? now,
    dirty: true,
    sync: existing?.sync ?? {},
  }
  await writeFile(f)
}

/* ------------------------------------------------------------------ search */

export interface SearchHit {
  entry: NoteIndexEntry
  score: number
  /** A snippet with the match, for the result row. */
  snippet: string
}

/**
 * Substring search over titles and bodies. Deliberately not a fuzzy index: at
 * a few thousand notes a linear scan is well under a frame, and exact
 * substring matching is far more predictable to use than fuzzy ranking.
 */
export function search(query: string, limit = 200): SearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const terms = q.split(/\s+/).filter(Boolean)
  const hits: SearchHit[] = []
  for (const e of notes.value) {
    const f = files.get(e.path)
    const body = (f?.text ?? '').toLowerCase()
    const title = e.title.toLowerCase()
    let score = 0
    let firstAt = -1
    let ok = true
    for (const t of terms) {
      const inTitle = title.includes(t)
      const at = body.indexOf(t)
      if (!inTitle && at < 0) {
        ok = false
        break
      }
      if (inTitle) score += title === t ? 100 : title.startsWith(t) ? 40 : 20
      if (at >= 0) {
        score += 5
        if (firstAt < 0) firstAt = at
      }
    }
    if (!ok) continue
    // Recency is a mild tiebreaker, never enough to outrank a title match.
    score += Math.max(0, 10 - (Date.now() - e.mtime) / (86_400_000 * 30))
    hits.push({ entry: e, score, snippet: snippetAt(f?.text ?? '', firstAt, terms[0].length) })
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit)
}

function snippetAt(text: string, at: number, len: number): string {
  if (at < 0) return ''
  const start = Math.max(0, at - 40)
  const end = Math.min(text.length, at + len + 80)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`
}

/* ------------------------------------------------------------------- tasks */

/** Toggle a checkbox in a note's source and save. */
export async function toggleTask(path: string, line: number): Promise<void> {
  const f = files.get(path)
  if (!f?.text) return
  const lines = f.text.split('\n')
  const l = lines[line]
  if (l === undefined) return
  const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\].*)$/.exec(l)
  if (!m) return
  lines[line] = `${m[1]}${m[2] === ' ' ? 'x' : ' '}${m[3]}`
  await saveNote(path, lines.join('\n'))
}

/** Notes whose calendar date is the given local day. */
export function notesOnDay(day: number): NoteIndexEntry[] {
  const paths = notesByDay.value.get(startOfDay(day)) ?? []
  return paths.map((p) => indexMap.get(p)!).filter(Boolean)
}
