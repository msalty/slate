/**
 * Core data model.
 *
 * The vault is a flat set of files addressed by POSIX-style relative path
 * ("Work/Meeting Notes.md", "backstage/config.json"). Everything the app knows
 * lives in files inside the vault — there is no hidden application database that
 * a user could lose by moving their folder. IndexedDB is a *cache and journal*
 * of that file set, never the sole home of anything.
 */

export type FileKind = 'note' | 'attachment'

/** Sync bookkeeping for one file. This is what makes conflict detection safe. */
export interface SyncMeta {
  /**
   * Hash of the content as it stood at the last successful sync with the remote.
   * This is the "base" in three-way merge. Undefined means the file has never
   * been synced (locally created, or remote never seen).
   */
  baseHash?: string
  /**
   * The note text as it stood at the last successful sync. Three-way merge is
   * impossible without the common ancestor, and reconstructing it from version
   * history is not guaranteed, so it is stored outright. Notes are small; this
   * roughly doubles their local footprint and is what buys clean merges.
   * Not kept for attachments.
   */
  baseText?: string
  /** Remote version identifier at last sync: an ETag (WebDAV) or headRevisionId (Drive). */
  remoteRev?: string
  /** Remote-reported mtime in ms at last sync, for adapters without a usable rev. */
  remoteMtime?: number
  /** ms epoch of the last successful push/pull for this file. */
  lastSyncedAt?: number
}

export interface VaultFile {
  /** Primary key. Relative POSIX path within the vault, no leading slash. */
  path: string
  kind: FileKind
  /** Text content for notes. Always present for kind === 'note'. */
  text?: string
  /** Binary content for attachments. Always present for kind === 'attachment'. */
  blob?: Blob
  mime: string
  size: number
  /** Content hash of the current local bytes. Cheap change detection. */
  hash: string
  /** ms epoch when this file was last written locally. */
  mtime: number
  /** ms epoch when this file was first created locally (or first seen). */
  ctime: number
  /** True when local content differs from what the remote last confirmed. */
  dirty: boolean
  /**
   * Tombstone. Deleted files are never dropped from the index until the
   * deletion has been confirmed on the remote — otherwise a delete on one
   * device can silently resurrect on another, or worse, a resurrection can
   * overwrite newer content.
   */
  deleted?: boolean
  deletedAt?: number
  sync: SyncMeta
}

/** Lightweight projection used by the note list, search, calendar and graph. */
export interface NoteIndexEntry {
  path: string
  /** Note name without directory or ".md". This is the wikilink target. */
  title: string
  /** Directory portion, "" for vault root. */
  folder: string
  /** First non-empty, non-heading line, trimmed — the list subtitle. */
  excerpt: string
  mtime: number
  ctime: number
  /** The date this note is filed under in the calendar (ms epoch, local midnight). */
  calendarDate: number
  tags: string[]
  /** Lowercased titles this note links to via [[wikilinks]]. */
  links: string[]
  /** Relative paths of attachments embedded in this note. */
  embeds: string[]
  pinned: boolean
  hasTasks: boolean
  size: number
}

export interface TaskItem {
  /** Stable-ish id: path + line number. */
  id: string
  path: string
  noteTitle: string
  line: number
  text: string
  done: boolean
  /** ms epoch local midnight, parsed from a 📅 / @due(...) marker, if any. */
  due?: number
}

export type SyncPhase = 'idle' | 'listing' | 'pulling' | 'pushing' | 'error' | 'offline'

export interface SyncStatus {
  phase: SyncPhase
  /** Human-readable detail for the status line. */
  detail?: string
  lastSyncAt?: number
  lastError?: string
  pendingCount: number
  conflictCount: number
  /** 0..1 during a run, undefined when idle. */
  progress?: number
}

export interface RemoteEntry {
  path: string
  /** Version identifier — ETag for WebDAV, headRevisionId for Drive. */
  rev?: string
  mtime?: number
  size?: number
  isDir: boolean
  /** Adapter-private handle (e.g. Drive file id). */
  handle?: string
}

/**
 * The contract every backend must satisfy. Deliberately tiny: list, get, put,
 * delete, mkdir. Anything more exotic belongs in the sync engine, not here, so
 * a new backend is a couple hundred lines rather than a rewrite.
 */
export interface RemoteAdapter {
  readonly id: string
  readonly label: string
  /** Human-readable description of where data is going, shown in settings. */
  describe(): string
  /** Throws if not usable (bad credentials, unreachable, CORS). */
  connect(): Promise<void>
  isConnected(): boolean
  /** Recursive listing of every file under the vault root. */
  list(): Promise<RemoteEntry[]>
  getText(entry: RemoteEntry): Promise<{ text: string; rev?: string; mtime?: number }>
  getBlob(entry: RemoteEntry): Promise<{ blob: Blob; rev?: string; mtime?: number }>
  /**
   * Write a file. `ifMatchRev` is the rev the caller believes the remote holds;
   * adapters MUST refuse the write (throw PreconditionFailed) if the remote has
   * moved on. Pass undefined to mean "create only if absent" where supported.
   */
  put(
    path: string,
    body: Blob | string,
    mime: string,
    ifMatchRev: string | undefined,
    knownHandle?: string,
  ): Promise<{ rev?: string; mtime?: number; handle?: string }>
  remove(entry: RemoteEntry): Promise<void>
  /** Ensure a directory exists (no-op for flat stores). */
  ensureDir(path: string): Promise<void>
}

export class PreconditionFailed extends Error {
  constructor(message = 'Remote changed since last sync') {
    super(message)
    this.name = 'PreconditionFailed'
  }
}

export class NotFound extends Error {
  constructor(message = 'Not found') {
    super(message)
    this.name = 'NotFound'
  }
}

export interface AppSettings {
  /** Which adapter is active. 'none' = purely local. */
  backend: 'none' | 'webdav' | 'gdrive'
  webdav: {
    url: string
    username: string
    /** Stored in IndexedDB on-device only; never leaves the browser except to the server. */
    password: string
    /** Subfolder on the server that is the vault root. */
    root: string
  }
  gdrive: {
    clientId: string
    /** Drive folder id of the vault root; created on first connect. */
    folderId: string
    folderName: string
  }
  autoSync: boolean
  /** Seconds between automatic syncs when autoSync is on. */
  syncIntervalSec: number
  showRightRail: boolean
  showSidebar: boolean
  theme: 'system' | 'light' | 'dark'
  editorMode: 'live' | 'source'
  /** Longest edge in px for pasted images. 0 disables resizing. */
  imageMaxEdge: number
  imageQuality: number
  imageFormat: 'image/webp' | 'image/jpeg' | 'original'
  /** Folder inside the vault where pasted attachments land. */
  attachmentFolder: string
  fontSize: number
  /** Sort order for the note list. */
  sortBy: 'mtime' | 'ctime' | 'title'
  deviceId: string
  deviceName: string
}

export const BACKSTAGE = 'backstage'
export const TRASH = `${BACKSTAGE}/trash`
