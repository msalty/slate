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

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
const SCOPE = 'https://www.googleapis.com/auth/drive.file'
const GIS_SRC = 'https://accounts.google.com/gsi/client'

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

  private async ensureToken(interactive = false): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiry - 60_000) return this.token
    if (!this.cfg.clientId) throw new Error('No Google OAuth client ID configured.')
    await loadGis()

    return new Promise<string>((resolve, reject) => {
      if (!this.client) {
        this.client = window.google!.accounts.oauth2.initTokenClient({
          client_id: this.cfg.clientId,
          scope: SCOPE,
          callback: () => {},
          error_callback: (e) =>
            reject(new Error(`Google sign-in failed: ${e.message ?? e.type ?? 'unknown'}`)),
        })
      }
      this.client.callback = (r) => {
        if (r.error || !r.access_token) {
          reject(new Error(`Google sign-in failed: ${r.error ?? 'no token returned'}`))
          return
        }
        this.token = r.access_token
        this.tokenExpiry = Date.now() + (r.expires_in ?? 3600) * 1000
        resolve(this.token)
      }
      // '' asks for a silent refresh; 'consent' forces the account chooser.
      this.client.requestAccessToken({ prompt: interactive ? 'consent' : '' })
    })
  }

  private async api(
    url: string,
    init: RequestInit & { headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const token = await this.ensureToken()
    const run = (t: string) =>
      fetch(url, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${t}` },
      })

    let res: Response
    try {
      res = await run(token)
    } catch (e) {
      throw new Error(`Could not reach Google Drive: ${(e as Error).message}`)
    }
    if (res.status === 401) {
      // Token expired mid-flight; refresh once and retry.
      this.token = ''
      this.tokenExpiry = 0
      res = await run(await this.ensureToken())
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

    while (frontier.length && depth < 24) {
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
    return this.api(`${API}/files/${id}?alt=media`)
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

  async remove(entry: RemoteEntry): Promise<void> {
    const id = entry.handle ?? this.idByPath.get(entry.path)
    if (!id) return
    try {
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

  private async ensureDirId(path: string): Promise<string> {
    const p = normPath(path)
    if (!p) return this.rootId
    const hit = this.idByPath.get(p)
    if (hit) return hit
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
    this.connected = false
  }
}
