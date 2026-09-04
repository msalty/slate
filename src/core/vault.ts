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
  deleteFileRow as dbDeleteFileRow,
  getFile,
  putFile as dbPutFile,
  putFiles as dbPutFiles,
  pushVersion,
  renameVersions,
} from './db'
import {
  calendarDateFor,
  codeRegions,
  excerptOf,
  isTaskLine,
  noteLevelTags,
  parseFrontmatter,
  resolveTarget,
  scanMdLinks,
  scanTags,
  scanTasks,
  scanWikiLinks,
  splitSizeFragment,
  stripInline,
  withDue,
} from './markdown'
import {
  loadDeviceRecords,
  localDeviceName,
  pendingDeviceRecord,
  writerFor,
} from './devices'
import {
  basename,
  dirname,
  extname,
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

/* ------------------------------------------------------------ other windows */

/**
 * Told which paths were just written, when anything is listening.
 *
 * A note popped out into a window of its own is edited by a *second copy of
 * this module*, in a second JS context, over the same IndexedDB. Each window's
 * `files` map is its own, so without a word between them the two drift: one
 * window's list, search index and — worse — its sync engine would go on
 * working from the copy it was holding when the other window started typing.
 *
 * `ui/popout.ts` installs a listener that broadcasts these paths to the other
 * windows, and `adoptFromStorage` below is the far end of it. Nothing is
 * installed until a note is actually popped out, so an ordinary session pays
 * one undefined check per write and nothing else.
 */
let onWrite: ((paths: string[]) => void) | undefined

export function onVaultWrite(fn: (paths: string[]) => void): void {
  onWrite = fn
}

/*
 * The three durable writes, wrapped so every mutation below announces itself
 * without having to remember to. They shadow the imports of the same name, so
 * the call sites read exactly as they did before.
 */

async function putFile(f: VaultFile): Promise<void> {
  await dbPutFile(f)
  onWrite?.([f.path])
}

async function putFiles(list: VaultFile[]): Promise<void> {
  await dbPutFiles(list)
  onWrite?.(list.map((f) => f.path))
}

async function deleteFileRow(path: string): Promise<void> {
  await dbDeleteFileRow(path)
  onWrite?.([path])
}

/**
 * Take IndexedDB's current rows for these paths as this window's copy of them.
 *
 * The other end of the hook above: another window has written, and this one is
 * told which paths so it can refresh exactly those rather than reloading the
 * whole vault on every keystroke someone types next door. Nothing is written
 * back and no version is recorded — the window that made the edit did both —
 * which is also what stops two windows from echoing each other forever.
 *
 * A note open in the editor here picks the change up through the same rebase
 * the sync engine's pulls go through: `revision` moves, and the editor folds
 * the new text into whatever is in the buffer.
 */
export async function adoptFromStorage(paths: readonly string[]): Promise<void> {
  let changed = false
  for (const path of paths) {
    const row = await getFile(path)
    const held = files.get(path)
    if (!row) {
      if (!held) continue
      files.delete(path)
      indexMap.delete(path)
      releaseUrl(path)
      changed = true
      continue
    }
    // Sync bookkeeping (dirty, base hash) is taken either way; only a change to
    // what is *in* the file is worth reindexing and redrawing for.
    const same =
      !!held &&
      held.hash === row.hash &&
      held.mtime === row.mtime &&
      !!held.deleted === !!row.deleted
    files.set(path, row)
    if (same) continue
    reindex(path)
    changed = true
  }
  if (changed) bump()
}

/** True for anything under backstage/ — hidden from every UI surface. */
export function isHidden(path: string): boolean {
  return path === BACKSTAGE || path.startsWith(`${BACKSTAGE}/`)
}

/**
 * The folder templates are read from. Defined here rather than in
 * templates.ts, which imports this module: the roll-ups below need to know a
 * template when they see one, and a path predicate is all that takes.
 */
export const TEMPLATES_FOLDER = 'Templates'

export function isTemplatePath(path: string): boolean {
  return path === TEMPLATES_FOLDER || path.startsWith(`${TEMPLATES_FOLDER}/`)
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

/**
 * The notes that are your own material — `notes` without the templates.
 *
 * A template is boilerplate for a note that does not exist yet, so counting it
 * as one makes the app answer questions about your work with data from a form:
 * a `- [ ]` waiting to be filled in becomes a task you owe somebody, a `#work`
 * describing future notes inflates the tag it is written in, and a Tag Folder
 * of everything tagged `#work` contains the template that says so.
 *
 * This is what every *roll-up* reads: tasks, tag counts, the calendar, Tag
 * Folder matches, backlinks, and the note list outside the Templates folder
 * itself. Things that look at one named thing keep using `notes` — searching
 * for `#meeting` and not finding the template that defines it would be worse
 * than finding it, browsing `Templates/` has to show them, wikilink
 * autocomplete may legitimately target one, and the orphan scan and rename
 * repointing MUST see them or an image only a template uses is reported
 * unused and a template's links break on a rename.
 *
 * The same array comes back when there are no templates, so a vault that never
 * made the folder pays nothing and every downstream memo keeps its identity.
 */
export const contentNotes = computed<NoteIndexEntry[]>(() => {
  const all = notes.value
  const out = all.filter((e) => !isTemplatePath(e.path))
  return out.length === all.length ? all : out
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
  for (const e of contentNotes.value) for (const t of e.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
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
  for (const e of contentNotes.value) {
    if (!e.hasTasks) continue
    const f = files.get(e.path)
    if (!f?.text) continue
    // What the note says about itself, which every task on it inherits.
    const inherited = noteLevelTags(f.text)
    for (const t of scanTasks(f.text)) {
      out.push({
        id: `${e.path}:${t.line}`,
        path: e.path,
        noteTitle: e.title,
        folder: e.folder,
        line: t.line,
        text: stripInline(t.text),
        done: t.done,
        due: t.due,
        tags: [...new Set([...t.tags, ...inherited])],
        ownTags: t.tags,
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
  for (const e of contentNotes.value) {
    const arr = m.get(e.calendarDate)
    if (arr) arr.push(e.path)
    else m.set(e.calendarDate, [e.path])
  }
  return m
})

/**
 * date (local midnight ms) -> how many *open* tasks are due that day.
 *
 * What the calendar draws its second signal from. Open only, whatever the
 * "show completed" switch says: the mark means work this day is still going to
 * ask of you, and a day whose jobs are all done has nothing to say.
 */
export const openTasksByDueDay = computed(() => {
  const m = new Map<number, number>()
  for (const t of tasks.value) {
    if (t.done || t.due === undefined) continue
    m.set(t.due, (m.get(t.due) ?? 0) + 1)
  }
  return m
})

/** Reverse link map: path -> paths that link to it. */
export const backlinkMap = computed(() => {
  const titles = titleIndex.value
  const paths = pathSet.value
  const m = new Map<string, string[]>()
  for (const e of contentNotes.value) {
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
  for (const e of contentNotes.value) {
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

/**
 * Attachments no note points at.
 *
 * A file nothing references is dead weight: it syncs to every device, it takes
 * space, and no screen will ever show it again — and it is invisible, because
 * the only way to notice is to check every note by hand. So the Files browser
 * marks them, and the vault stays something you could hand to someone else and
 * have it all make sense.
 *
 * References resolve the way `resolveEmbed` resolves them — exact path, then
 * relative to the linking note, then by bare filename — but against a prepared
 * index instead, because the shared-name fallback is a scan of the whole vault
 * and this runs over every link in every note.
 */
export const orphanFiles = computed<Set<string>>(() => {
  const unused = new Set<string>()
  const byName = new Map<string, string[]>()
  for (const f of attachments.value) {
    unused.add(f.path)
    const key = basename(f.path).toLowerCase()
    const same = byName.get(key)
    if (same) same.push(f.path)
    else byName.set(key, [f.path])
  }
  if (!unused.size) return unused

  const claim = (ref: string, from: string) => {
    let clean = ref.trim()
    if (!clean || /^[a-z]+:/i.test(clean)) return
    try {
      clean = decodeURI(clean)
    } catch {
      // A half-encoded link is still a link; match it as written.
    }
    ;[clean] = splitSizeFragment(clean)
    for (const c of [normPath(clean), joinPath(dirname(from), clean)]) {
      if (unused.delete(c)) return
      // Resolved, but to a note or to a file already accounted for. Either way
      // the filename fallback below must not fire and claim a different file.
      if (exists(c)) return
    }
    for (const p of byName.get(basename(clean).toLowerCase()) ?? []) unused.delete(p)
  }

  for (const e of notes.value) {
    if (!unused.size) break
    const text = files.get(e.path)?.text
    if (!text) continue
    const regions = codeRegions(text)
    // Embeds and plain links alike: `[[logo.png]]` and `[the spec](spec.pdf)`
    // are both a note using a file, whether or not it renders inline.
    for (const l of scanWikiLinks(text, regions)) claim(l.target, e.path)
    for (const l of scanMdLinks(text, regions)) claim(l.url, e.path)
  }
  return unused
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
  loadDeviceRecords(rows)
  reindexAll()
  ready.value = true
  bump()
}

/**
 * Install files that came from the remote. Used by the sync engine only —
 * these are not marked dirty because the remote already has them.
 */
export async function installFromRemote(list: VaultFile[]): Promise<void> {
  // Device files first: a note pulled in the same batch can then be credited to
  // whoever pushed it, rather than to "somewhere else".
  loadDeviceRecords(list)
  for (const f of list) {
    if (f.kind === 'note') {
      await pushVersion({
        path: f.path,
        at: f.mtime,
        text: f.text ?? '',
        hash: f.hash,
        reason: 'sync-pull',
        device: writerFor(f.path),
      })
    }
    files.set(f.path, f)
  }
  await putFiles(list)
  for (const f of list) reindex(f.path)
  bump()
}

/**
 * Write this device's entry in the write registry, if it has anything new to
 * say, and return the path it wrote. Called by the sync engine either side of a
 * run: once so anything left over goes up with this run, once so this run's
 * writes are durable — and the second call hands the path back so the engine
 * can push it immediately rather than leaving attribution a run behind.
 */
export async function persistDeviceRegistry(): Promise<string | undefined> {
  const rec = pendingDeviceRecord()
  if (!rec) return undefined
  const name = `devices/${rec.id}.json`
  await writeBackstage(name, rec)
  return joinPath(BACKSTAGE, name)
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
/**
 * The name a note gets when it has not been given one.
 *
 * Worth a constant rather than a literal in six places, because it is not
 * really a title: it is the absence of one, and a template asked to fill in
 * `{{title}}` needs to be able to tell the difference.
 */
export const UNTITLED = 'Untitled'

export async function createNote(
  folder = '',
  title: string = UNTITLED,
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
  await pushVersion({
    path,
    at: Date.now(),
    text: f.text ?? '',
    hash: f.hash,
    reason: 'edit',
    device: localDeviceName(),
  })
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
 * Rename an attachment, repointing every note that used it.
 *
 * A file's name is part of how a note reads — `![[receipt-2026-08.pdf]]` says
 * something `![[IMG_0421.pdf]]` does not — so renaming has to be as safe as
 * renaming a note is. Every reference is rewritten in the shape it was written
 * in: a bare filename stays a bare filename, a path relative to the note stays
 * relative, and a full vault path stays full. Anything else would work but
 * would quietly rewrite how someone had chosen to link.
 */
export async function renameAttachment(path: string, newName: string): Promise<string> {
  const f = files.get(path)
  if (!f || f.kind !== 'attachment') return path
  const dir = dirname(path)
  const ext = extname(path)
  let name = safeSegment(newName.trim())
  if (!name) return path
  // Typing a name without its extension is the normal case; keep the old one
  // rather than producing a file the OS no longer knows how to open.
  if (!extname(name) && ext) name = `${name}${ext}`

  let dest = joinPath(dir, name)
  let n = 2
  while (files.has(dest) && dest !== path) {
    const dot = name.lastIndexOf('.')
    dest = joinPath(dir, dot > 0 ? `${name.slice(0, dot)} ${n++}${name.slice(dot)}` : `${name} ${n++}`)
  }
  if (dest === path) return path

  // Rewrite while the old file is still in place, so references still resolve.
  await repointReferences(path, dest)
  await movePath(path, dest)
  return dest
}

/** Rewrite every reference to `from` so it points at `to`. */
async function repointReferences(from: string, to: string): Promise<void> {
  const touched: VaultFile[] = []

  for (const e of notes.value) {
    const f = files.get(e.path)
    if (!f?.text) continue
    const regions = codeRegions(f.text)
    interface Rewrite {
      from: number
      to: number
      insert: string
    }
    const edits: Rewrite[] = []

    /** The new reference, written the way the old one was. */
    const reshape = (ref: string): string | undefined => {
      let clean = ref.trim()
      if (!clean || /^[a-z]+:/i.test(clean)) return undefined
      let decoded = clean
      try {
        decoded = decodeURI(clean)
      } catch {
        /* a half-encoded link is matched as written */
      }
      const [bare] = splitSizeFragment(decoded)
      if (normPath(bare) === from) return to
      const noteDir = dirname(e.path)
      if (noteDir && joinPath(noteDir, bare) === from) {
        return to.startsWith(`${noteDir}/`) ? to.slice(noteDir.length + 1) : to
      }
      if (basename(bare).toLowerCase() === basename(from).toLowerCase() && resolveEmbed(bare, e.path) === from)
        return basename(to)
      return undefined
    }

    for (const l of scanWikiLinks(f.text, regions)) {
      const next = reshape(l.target)
      if (next === undefined) continue
      const inner = [next, l.anchor ? `#${l.anchor}` : '', l.alias !== undefined ? `|${l.alias}` : ''].join('')
      edits.push({ from: l.from, to: l.to, insert: `${l.embed ? '!' : ''}[[${inner}]]` })
    }
    for (const l of scanMdLinks(f.text, regions)) {
      const [, width] = splitSizeFragment(l.url)
      const next = reshape(l.url)
      if (next === undefined) continue
      // Spaces have to be encoded or the parens close the link early.
      const url = encodeURI(next) + (width ? `#w=${width}` : '')
      edits.push({ from: l.urlFrom, to: l.urlTo, insert: url })
    }
    if (!edits.length) continue

    // Right to left, so earlier offsets stay valid.
    let text = f.text
    for (const ed of edits.sort((a, b) => b.from - a.from)) {
      text = `${text.slice(0, ed.from)}${ed.insert}${text.slice(ed.to)}`
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
    await pushVersion({
      path,
      at: Date.now(),
      text: f.text ?? '',
      hash: f.hash,
      reason: 'delete',
      device: localDeviceName(),
    })
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  let dest = joinPath(TRASH, `${stamp}--${basename(path)}`)
  let n = 2
  while (files.has(dest)) dest = joinPath(TRASH, `${stamp}--${n++}--${basename(path)}`)
  await movePath(path, dest)
}

export async function restoreFromTrash(trashPath: string, to?: string): Promise<string> {
  const name = trashDisplayName(trashPath)
  let dest = to ?? name
  let n = 2
  /*
   * Only a file that is actually there counts as being in the way. Deleting
   * something leaves a tombstone at the path it came from — the row that tells
   * sync the remote copy has to go — and treating that as occupied meant a
   * note deleted and restored came back as "Note 2", every time, with nothing
   * called "Note" anywhere for it to have collided with.
   */
  while (files.has(dest) && !files.get(dest)!.deleted) {
    const dot = name.lastIndexOf('.')
    dest = dot > 0 ? `${name.slice(0, dot)} ${n++}${name.slice(dot)}` : `${name} ${n++}`
  }
  await movePath(trashPath, dest)
  return dest
}

/**
 * Soft-delete any vault file. Attachments go the same way notes do — into
 * `backstage/trash/`, recoverable, and only really gone once you say so.
 */
export async function deleteFile(path: string): Promise<void> {
  return deleteNote(path)
}

/** True for anything sitting in Deleted. */
export function isTrashed(path: string): boolean {
  return path.startsWith(`${TRASH}/`)
}

/**
 * What a trashed file was called. The timestamp that makes its trash path
 * unique is bookkeeping, not part of the name anyone gave it.
 */
export function trashDisplayName(path: string): string {
  return basename(path).replace(/^\d{4}-\d{2}-\d{2}T[\d-]+--(?:\d+--)?/, '')
}

/**
 * What a deleted thing is called on screen.
 *
 * A note goes by its title everywhere else in the app, so it goes by its title
 * here too — the `.md` is how the file is stored, not what the note is called,
 * and a list that shows one row as "Groceries" and the next as "Groceries.md"
 * is showing the same thing two ways. A deleted *file* keeps its extension,
 * which is its name and half of what says which file it was.
 */
export function trashTitle(path: string): string {
  return trashDisplayName(path).replace(/\.md$/i, '')
}

/**
 * Everything in Deleted, newest first.
 *
 * A computed rather than a plain function, and it reads `revision` like every
 * other derived signal here. As a bare function wrapped in a `computed()` by
 * its caller it had no dependencies at all, so the signal settled after its
 * first read and never recomputed: deleting something removed the file but
 * left the row on screen, which looked exactly like a delete that did nothing.
 */
export const trashFiles = computed<VaultFile[]>(() => {
  revision.value
  const out: VaultFile[] = []
  for (const f of files.values())
    if (!f.deleted && f.path.startsWith(`${TRASH}/`)) out.push(f)
  return out.sort((a, b) => b.mtime - a.mtime)
})

export function trashItems(): VaultFile[] {
  return trashFiles.value
}

/**
 * Permanently delete one file out of Deleted.
 *
 * A tombstone, not a straight drop from the local database: the remote still
 * has the file, and forgetting it here would only mean the next sync pulled it
 * back down. The tombstone is what tells sync to remove the remote copy too,
 * and it disappears once that has happened — the same route a move takes for
 * the path it leaves behind.
 */
export async function purge(path: string): Promise<void> {
  if (!files.has(path)) return
  await tombstone(path)
}

/** Permanently delete everything in Deleted. Returns how many went. */
export async function emptyTrash(): Promise<number> {
  const doomed = trashFiles.value.map((f) => f.path)
  for (const p of doomed) await tombstone(p)
  return doomed.length
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
    const text = f?.text ?? ''
    const body = text.toLowerCase()
    const title = e.title.toLowerCase()
    let score = 0
    let snipAt = -1
    let snipLen = 0
    let ok = true
    /** Computed at most once per note, and only when there is a snippet to cut. */
    let prose = -1
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
        if (snipAt < 0) {
          if (prose < 0) prose = proseStart(text)
          /*
           * Looked for again from where the note's own prose starts, because
           * the first hit is so often the `# Heading` the title was taken
           * from — and a snippet of the title is a snippet of the bold line
           * directly above it. Staying unset when the word appears nowhere
           * else is the point: the row falls back to its excerpt rather than
           * showing a snippet with nothing marked in it.
           */
          const pa = body.indexOf(t, prose)
          if (pa >= 0) {
            snipAt = pa
            // This term's length, not the first term's: the window is sized
            // for the word it is centred on.
            snipLen = t.length
          }
        }
      }
    }
    if (!ok) continue
    // Recency is a mild tiebreaker, never enough to outrank a title match.
    score += Math.max(0, 10 - (Date.now() - e.mtime) / (86_400_000 * 30))
    hits.push({ entry: e, score, snippet: snippetAt(text, snipAt, snipLen, Math.max(prose, 0)) })
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit)
}

/** Where a note's own prose starts: past frontmatter, and past its heading. */
function proseStart(text: string): number {
  const { bodyStart } = parseFrontmatter(text)
  // Only a heading that opens the note — a later one is prose you scrolled to.
  const m = /^[ \t]*#{1,6}[ \t]+[^\n]*\n?/.exec(text.slice(bodyStart))
  return bodyStart + (m ? m[0].length : 0)
}

/**
 * The bit of a note around the match, for the result row to show instead of
 * the opening line.
 *
 * Cleaned the way an excerpt is cleaned. The window is cut out of the raw
 * file, so without this it arrives carrying whatever markdown happened to be
 * around the word — `**`, backticks, a `#` from a heading, the brackets of a
 * wikilink — which is noise in a one-line preview and nothing the reader
 * typed. Empty when the match was in the title alone: there is no body
 * position to centre on, and the row falls back to its usual excerpt.
 *
 * `from` is the floor for the leading context. Without it the 40 characters
 * of run-up walk straight back out of the prose and into the frontmatter and
 * heading the match was deliberately found past.
 */
function snippetAt(text: string, at: number, len: number, from = 0): string {
  if (at < 0) return ''
  /*
   * A short run-up on purpose. The list pane is narrow — around forty
   * characters of preview before it ellipsises, shared with the date — so
   * every character spent ahead of the match is a character of risk that the
   * word you searched for is the one clipped off the end.
   */
  let start = Math.max(from, at - 20)
  // And never opening mid-word: "…e it is easier" reads as a typo.
  if (start > from) {
    const sp = text.indexOf(' ', start)
    if (sp >= 0 && sp < at) start = sp + 1
  }
  const end = Math.min(text.length, at + len + 80)
  const clean = stripInline(text.slice(start, end).replace(/^#{1,6}\s+/gm, ''))
  if (!clean) return ''
  return `${start > from ? '…' : ''}${clean}${end < text.length ? '…' : ''}`
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

/**
 * Give a task a due date, or take it away when `date` is undefined.
 *
 * The sibling of `toggleTask`, and for the same reason: the task list is a view
 * over other notes' source, so acting on a row here has to go back and edit the
 * line it came from. Nothing is written when the rewrite would be a no-op —
 * picking the date a task already has shouldn't cost a save, a sync and a
 * version-history snapshot.
 */
export async function setDue(path: string, line: number, date: number | undefined): Promise<void> {
  const f = files.get(path)
  if (!f?.text) return
  const lines = f.text.split('\n')
  const l = lines[line]
  if (l === undefined || !isTaskLine(l)) return
  const next = withDue(l, date)
  if (next === l) return
  lines[line] = next
  await saveNote(path, lines.join('\n'))
}

/** Notes whose calendar date is the given local day. */
export function notesOnDay(day: number): NoteIndexEntry[] {
  const paths = notesByDay.value.get(startOfDay(day)) ?? []
  return paths.map((p) => indexMap.get(p)!).filter(Boolean)
}
