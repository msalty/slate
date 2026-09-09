/**
 * Google Drive adapter.
 *
 * Uses the `drive.file` scope, which is the narrow one: the app can only ever
 * see files it created itself. It cannot read the rest of the user's Drive, and
 * revoking access is a single click in the Google account settings.
 *
 * The vault is mirrored as a real folder tree in Drive, so the notes look like
 * ordinary .md files in an ordinary folder and remain usable if this app
 * disappears tomorrow.
 *
 * One protocol caveat, handled explicitly below: Drive v3 dropped ETag
 * preconditions, so a conditional write is not available. Instead every update
 * re-reads the file's headRevisionId immediately before writing and refuses if
 * it moved. That leaves a race window of a few hundred milliseconds; Drive's own
 * built-in revision history is the backstop if it is ever lost.
 */

import { NotFound, PreconditionFailed, type RemoteAdapter, type RemoteEntry } from '../core/types'
import { basename, normPath } from '../core/util'
import { REQUEST_TIMEOUT_MS, TRANSFER_TIMEOUT_MS, isTimeout, timeoutSignal } from './net'

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
const SCOPE = 'https://www.googleapis.com/auth/drive.file'
const GIS_SRC = 'https://accounts.google.com/gsi/client'

/** See the identical constant in the WebDAV adapter: a listing fails rather than truncates. */
const MAX_DEPTH = 24

/** A silent token refresh that never calls back would otherwise hang forever. */
const TOKEN_TIMEOUT_MS = 60_000

interface TokenClient {
  requestAccessToken(overrides?: { prompt?: string }): void
  callback: (r: { access_token?: string; expires_in?: number; error?: string }) => void
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(cfg: {
            client_id: string
            scope: string
            callback: (r: { access_token?: string; expires_in?: number; error?: string }) => void
            error_callback?: (e: { type?: string; message?: string }) => void
          }): TokenClient
          revoke(token: string, done?: () => void): void
        }
      }
    }
  }
}

let gisPromise: Promise<void> | undefined

function loadGis(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve()
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = GIS_SRC
      s.async = true
      s.onload = () => resolve()
      s.onerror = () =>
        reject(new Error('Could not load Google sign-in. Check your connection or blocker.'))
      document.head.appendChild(s)
    })
  }
  return gisPromise
}

interface DriveFile {
  id: string
  name: string
  mimeType: string
  parents?: string[]
  modifiedTime?: string
  headRevisionId?: string
  size?: string
  trashed?: boolean
}

export interface GdriveConfig {
  clientId: string
  folderId: string
  folderName: string
  /** Called when the adapter creates or discovers the root folder id. */
  onFolderId?: (id: string) => void
}

export class GdriveAdapter implements RemoteAdapter {
  readonly id = 'gdrive'
  readonly label = 'Google Drive'

  private token = ''
  private tokenExpiry = 0
  private client?: TokenClient
  /** The one token request in flight, shared by everyone who asks meanwhile. */
  private tokenWait?: Promise<string>
  /** How the reused token client reports a failure to the current request. */
  private failToken?: (e: Error) => void
  private rootId = ''
  /** vault path -> Drive file id, for both files and folders. */
  private idByPath = new Map<string, string>()
  private connected = false

  constructor(private cfg: GdriveConfig) {
    this.rootId = cfg.folderId
  }

  describe(): string {
    return `Google Drive · ${this.cfg.folderName || 'Slate'}`
  }

  isConnected(): boolean {
    return this.connected && Date.now() < this.tokenExpiry
  }

  /* --------------------------------------------------------------- oauth */

  /**
   * The token, fetching one if the current one is missing or nearly expired.
   *
   * At most one request is ever in flight. The Google token client has exactly
   * one `callback` slot, so a second concurrent request overwrites the first's
   * — and since five sync workers hit a 401 at roughly the same moment, that is
   * the ordinary case, not a rare one. The overwritten promise is never settled
   * by anything, so its caller waits forever and takes the whole sync run with
   * it. One shared promise means they all get the same answer.
   */
  private async ensureToken(interactive = false): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiry - 60_000) return this.token
    if (!this.cfg.clientId) throw new Error('No Google OAuth client ID configured.')
    const inFlight = this.tokenWait
    if (inFlight) return inFlight

    const wait = this.requestToken(interactive)
    this.tokenWait = wait
    const release = () => {
      if (this.tokenWait === wait) this.tokenWait = undefined
    }
    wait.then(release, release)
    return wait
  }

  private async requestToken(interactive: boolean): Promise<string> {
    await loadGis()

    return new Promise<string>((resolve, reject) => {
      // Nothing here is guaranteed to call back — a blocked third-party frame
      // simply goes quiet — so the promise carries its own deadline.
      const timer = setTimeout(
        () =>
          reject(
            new Error('Google sign-in did not respond. Check for a blocker, then try again.'),
          ),
        TOKEN_TIMEOUT_MS,
      )
      const settle = <T>(fn: (v: T) => void) => (v: T) => {
        clearTimeout(timer)
        fn(v)
      }
      const fail = settle(reject)
      const done = settle(resolve)
      // The client is built once and reused, so its error callback must reach
      // whichever request is current rather than the one that happened to
      // create it.
      this.failToken = fail

      if (!this.client) {
        this.client = window.google!.accounts.oauth2.initTokenClient({
          client_id: this.cfg.clientId,
          scope: SCOPE,
          callback: () => {},
          error_callback: (e) =>
            this.failToken?.(
              new Error(`Google sign-in failed: ${e.message ?? e.type ?? 'unknown'}`),
            ),
        })
      }
      this.client.callback = (r) => {
        if (r.error || !r.access_token) {
          fail(new Error(`Google sign-in failed: ${r.error ?? 'no token returned'}`))
          return
        }
        this.token = r.access_token
        this.tokenExpiry = Date.now() + (r.expires_in ?? 3600) * 1000
        done(this.token)
      }
      // '' asks for a silent refresh; 'consent' forces the account chooser.
      this.client.requestAccessToken({ prompt: interactive ? 'consent' : '' })
    })
  }

  private async api(
    url: string,
    init: RequestInit & { headers?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<Response> {
    const token = await this.ensureToken()
    // Every request carries a deadline: an answer that never comes would
    // otherwise leave the sync engine's single in-flight run alive forever, and
    // every later sync joins that run rather than starting a new one.
    const { timeoutMs = init.body ? TRANSFER_TIMEOUT_MS : REQUEST_TIMEOUT_MS, ...rest } = init
    const run = (t: string) =>
      fetch(url, {
        ...rest,
        headers: { ...init.headers, Authorization: `Bearer ${t}` },
        signal: timeoutSignal(timeoutMs),
      })

    let res: Response
    try {
      res = await run(token)
    } catch (e) {
      if (isTimeout(e))
        throw new Error(
          `Google Drive did not answer within ${Math.round(timeoutMs / 1000)}s. The next sync will try again.`,
        )
      throw new Error(`Could not reach Google Drive: ${(e as Error).message}`)
    }
    if (res.status === 401) {
      // Token expired mid-flight; refresh once and retry.
      this.token = ''
      this.tokenExpiry = 0
      try {
        res = await run(await this.ensureToken())
      } catch (e) {
        if (isTimeout(e))
          throw new Error('Google Drive did not answer after the token was refreshed.')
        throw e
      }
    }
    if (res.status === 404) throw new NotFound('File not found in Drive')
    if (res.status === 403) {
      const body = await res.text().catch(() => '')
      if (/rateLimitExceeded|userRateLimitExceeded/.test(body))
        throw new Error('Google Drive rate limit hit — the next sync will retry.')
      throw new Error(`Google Drive refused the request: ${body.slice(0, 200)}`)
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Google Drive error ${res.status}: ${body.slice(0, 200)}`)
    }
    return res
  }

  async connect(): Promise<void> {
    await this.ensureToken(!this.rootId)
    if (!this.rootId) this.rootId = await this.findOrCreateRoot()
    else {
      // Verify the stored folder still exists and we still have access to it.
      try {
        await this.api(`${API}/files/${this.rootId}?fields=id,trashed`)
      } catch {
        this.rootId = await this.findOrCreateRoot()
      }
    }
    this.cfg.onFolderId?.(this.rootId)
    this.connected = true
  }

  private async findOrCreateRoot(): Promise<string> {
    const name = this.cfg.folderName || 'Slate'
    const q = encodeURIComponent(
      `name = '${name.replace(/'/g, "\\'")}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
    )
    const res = await this.api(`${API}/files?q=${q}&fields=files(id,name)&pageSize=10`)
    const data = (await res.json()) as { files: DriveFile[] }
    if (data.files?.length) return data.files[0].id
    return this.createFolder(name, undefined)
  }

  private async createFolder(name: string, parent: string | undefined): Promise<string> {
    const res = await this.api(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        mimeType: FOLDER_MIME,
        parents: parent ? [parent] : undefined,
      }),
    })
    return ((await res.json()) as DriveFile).id
  }

  /* ---------------------------------------------------------------- list */

  async list(): Promise<RemoteEntry[]> {
    this.idByPath.clear()
    this.idByPath.set('', this.rootId)
    const out: RemoteEntry[] = []
    let frontier: Array<{ id: string; path: string }> = [{ id: this.rootId, path: '' }]
    let depth = 0

    while (frontier.length && depth < MAX_DEPTH) {
      const next: Array<{ id: string; path: string }> = []
      // Drive quotas are per-second, so a small fan-out keeps us under them.
      for (let i = 0; i < frontier.length; i += 4) {
        const batch = frontier.slice(i, i + 4)
        const results = await Promise.all(batch.map((d) => this.listChildren(d.id)))
        results.forEach((children, j) => {
          const parentPath = batch[j].path
          for (const c of children) {
            const path = parentPath ? `${parentPath}/${c.name}` : c.name
            const isDir = c.mimeType === FOLDER_MIME
            this.idByPath.set(path, c.id)
            out.push({
              path,
              isDir,
              handle: c.id,
              rev: c.headRevisionId,
              mtime: c.modifiedTime ? Date.parse(c.modifiedTime) : undefined,
              size: c.size ? Number(c.size) : undefined,
            })
            if (isDir) next.push({ id: c.id, path })
          }
        })
      }
      frontier = next
      depth++
    }
    // A listing is read as the whole truth about the remote, so a partial one
    // would present every unvisited file as deleted elsewhere. Fail instead.
    if (frontier.length)
      throw new Error(
        `The vault in Drive is nested more than ${MAX_DEPTH} folders deep, so this listing would have been incomplete. Nothing was changed.`,
      )
    return out
  }

  private async listChildren(parentId: string): Promise<DriveFile[]> {
    const files: DriveFile[] = []
    let pageToken: string | undefined
    do {
      const q = encodeURIComponent(`'${parentId}' in parents and trashed = false`)
      const fields = encodeURIComponent(
        'nextPageToken, files(id,name,mimeType,modifiedTime,headRevisionId,size)',
      )
      const url =
        `${API}/files?q=${q}&fields=${fields}&pageSize=1000&orderBy=name` +
        (pageToken ? `&pageToken=${pageToken}` : '')
      const res = await this.api(url)
      const data = (await res.json()) as { files: DriveFile[]; nextPageToken?: string }
      files.push(...(data.files ?? []))
      pageToken = data.nextPageToken
    } while (pageToken)
    return files
  }

  /* ----------------------------------------------------------------- get */

  private async fetchMedia(entry: RemoteEntry): Promise<Response> {
    const id = entry.handle ?? this.idByPath.get(entry.path)
    if (!id) throw new NotFound(`No Drive id for ${entry.path}`)
    // A download has no request body but can still be an attachment of many
    // megabytes, so it gets the transfer deadline rather than the short one.
    return this.api(`${API}/files/${id}?alt=media`, { timeoutMs: TRANSFER_TIMEOUT_MS })
  }

  async getText(entry: RemoteEntry): Promise<{ text: string; rev?: string; mtime?: number }> {
    const res = await this.fetchMedia(entry)
    return { text: await res.text(), rev: entry.rev, mtime: entry.mtime }
  }

  async getBlob(entry: RemoteEntry): Promise<{ blob: Blob; rev?: string; mtime?: number }> {
    const res = await this.fetchMedia(entry)
    return { blob: await res.blob(), rev: entry.rev, mtime: entry.mtime }
  }

  /* ----------------------------------------------------------------- put */

  async put(
    path: string,
    body: Blob | string,
    mime: string,
    ifMatchRev: string | undefined,
    knownHandle?: string,
  ): Promise<{ rev?: string; mtime?: number; handle?: string }> {
    const p = normPath(path)
    const id = knownHandle ?? this.idByPath.get(p)
    const blob = typeof body === 'string' ? new Blob([body], { type: mime }) : body

    if (id) {
      // Drive v3 has no If-Match, so verify the revision by hand first. If the
      // remote has moved on since we last synced, refuse and let the sync
      // engine run its three-way merge instead of clobbering.
      if (ifMatchRev) {
        const cur = await this.api(`${API}/files/${id}?fields=headRevisionId`)
        const meta = (await cur.json()) as DriveFile
        if (meta.headRevisionId && meta.headRevisionId !== ifMatchRev)
          throw new PreconditionFailed()
      }
      const res = await this.api(
        `${UPLOAD}/files/${id}?uploadType=media&fields=id,headRevisionId,modifiedTime`,
        { method: 'PATCH', headers: { 'Content-Type': mime }, body: blob },
      )
      const meta = (await res.json()) as DriveFile
      return {
        rev: meta.headRevisionId,
        mtime: meta.modifiedTime ? Date.parse(meta.modifiedTime) : Date.now(),
        handle: meta.id,
      }
    }

    // Create. If the caller expected an existing file, the file vanished
    // remotely — that is a precondition failure, not a silent re-create.
    if (ifMatchRev) throw new PreconditionFailed('File no longer exists in Drive')

    const parentPath = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
    const parentId = await this.ensureDirId(parentPath)
    const metadata = { name: basename(p), parents: [parentId] }

    const boundary = `slate${Math.random().toString(36).slice(2)}`
    const form = new Blob(
      [
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
        JSON.stringify(metadata),
        `\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
        blob,
        `\r\n--${boundary}--\r\n`,
      ],
      { type: `multipart/related; boundary=${boundary}` },
    )
    const res = await this.api(
      `${UPLOAD}/files?uploadType=multipart&fields=id,headRevisionId,modifiedTime`,
      { method: 'POST', headers: { 'Content-Type': form.type }, body: form },
    )
    const meta = (await res.json()) as DriveFile
    this.idByPath.set(p, meta.id)
    return {
      rev: meta.headRevisionId,
      mtime: meta.modifiedTime ? Date.parse(meta.modifiedTime) : Date.now(),
      handle: meta.id,
    }
  }

  async remove(entry: RemoteEntry, ifMatchRev?: string): Promise<void> {
    const id = entry.handle ?? this.idByPath.get(entry.path)
    if (!id) return
    const rev = ifMatchRev ?? entry.rev
    try {
      // Drive has no conditional delete, so the revision is checked as late as
      // possible instead. Between the listing this run is working from and now,
      // another device may have written to the file; trashing it then would
      // discard content this device has never seen. Refusing hands the decision
      // back to the sync engine, which resurrects it.
      if (rev) {
        const cur = await this.api(`${API}/files/${id}?fields=headRevisionId`)
        const meta = (await cur.json()) as DriveFile
        if (meta.headRevisionId && meta.headRevisionId !== rev) throw new PreconditionFailed()
      }
      // Trash rather than delete: a mistaken sync deletion stays recoverable
      // from Drive's own trash for 30 days.
      await this.api(`${API}/files/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true }),
      })
    } catch (e) {
      if (e instanceof NotFound) return
      throw e
    }
    this.idByPath.delete(entry.path)
  }

  async ensureDir(path: string): Promise<void> {
    await this.ensureDirId(normPath(path))
  }

  /**
   * Folders being created concurrently, at most once each.
   *
   * Uploads run five at a time and Drive is happy to hold two folders with the
   * same name in the same parent, so two workers both wanting a folder that
   * does not exist yet would each make one — and half the notes would land in
   * the wrong twin. The second caller waits on the first's answer instead.
   */
  private dirWaits = new Map<string, Promise<string>>()

  private async ensureDirId(path: string): Promise<string> {
    const p = normPath(path)
    if (!p) return this.rootId
    const hit = this.idByPath.get(p)
    if (hit) return hit
    const inFlight = this.dirWaits.get(p)
    if (inFlight) return inFlight
    const wait = this.resolveDirId(p)
    this.dirWaits.set(p, wait)
    try {
      return await wait
    } finally {
      this.dirWaits.delete(p)
    }
  }

  private async resolveDirId(p: string): Promise<string> {
    const parent = await this.ensureDirId(p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
    // Look before creating so a folder made on another device is reused.
    const q = encodeURIComponent(
      `name = '${basename(p).replace(/'/g, "\\'")}' and '${parent}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
    )
    const res = await this.api(`${API}/files?q=${q}&fields=files(id)&pageSize=1`)
    const data = (await res.json()) as { files: DriveFile[] }
    const id = data.files?.[0]?.id ?? (await this.createFolder(basename(p), parent))
    this.idByPath.set(p, id)
    return id
  }

  /** Drop the OAuth grant entirely. */
  async disconnect(): Promise<void> {
    if (this.token && window.google?.accounts?.oauth2) {
      window.google.accounts.oauth2.revoke(this.token)
    }
    this.token = ''
    this.tokenExpiry = 0
    this.tokenWait = undefined
    this.connected = false
  }
}
