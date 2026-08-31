/**
 * WebDAV adapter.
 *
 * Works against Nextcloud/ownCloud, Synology WebDAV Server, Apache mod_dav,
 * `rclone serve webdav`, and anything else that speaks the protocol. Nothing
 * leaves the browser except to the server the user names.
 *
 * Two things about WebDAV in a browser are worth knowing, because they are the
 * only realistic ways this fails to connect:
 *   1. CORS. The server must allow the origin the PWA is served from, allow the
 *      PROPFIND/PUT/DELETE/MKCOL methods, allow the Authorization/If-Match/Depth
 *      headers, and expose the ETag header. README has the config snippets.
 *   2. Depth: infinity. Apache disables it by default, so listing walks the
 *      tree with Depth: 1 instead, which every server supports.
 */

import { NotFound, PreconditionFailed, type RemoteAdapter, type RemoteEntry } from '../core/types'
import { normPath } from '../core/util'

export interface WebdavConfig {
  url: string
  username: string
  password: string
  root: string
}

function encodePath(p: string): string {
  return p
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/')
}

export class WebdavAdapter implements RemoteAdapter {
  readonly id = 'webdav'
  readonly label = 'WebDAV'
  private base: string
  private auth: string
  private connected = false

  constructor(private cfg: WebdavConfig) {
    const trimmed = cfg.url.replace(/\/+$/, '')
    const root = encodePath(normPath(cfg.root))
    this.base = root ? `${trimmed}/${root}` : trimmed
    this.auth =
      cfg.username || cfg.password
        ? `Basic ${btoa(unescape(encodeURIComponent(`${cfg.username}:${cfg.password}`)))}`
        : ''
  }

  describe(): string {
    try {
      const u = new URL(this.base)
      return `${u.host}${u.pathname}`
    } catch {
      return this.cfg.url
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra }
    if (this.auth) h.Authorization = this.auth
    return h
  }

  private urlFor(path: string): string {
    const p = encodePath(path)
    return p ? `${this.base}/${p}` : this.base
  }

  private async request(
    method: string,
    path: string,
    init: RequestInit & { headers?: Record<string, string> } = {},
  ): Promise<Response> {
    let res: Response
    try {
      res = await fetch(this.urlFor(path), {
        ...init,
        method,
        headers: this.headers(init.headers),
        // Basic auth is supplied explicitly; never attach ambient cookies.
        credentials: 'omit',
        cache: 'no-store',
      })
    } catch (e) {
      // A network-level failure here is almost always CORS or an offline device.
      throw new Error(
        `Could not reach ${this.describe()}. If the server is up, this is usually a CORS problem — see the WebDAV section of the README. (${(e as Error).message})`,
      )
    }
    if (res.status === 401 || res.status === 403)
      throw new Error('WebDAV rejected the username or password.')
    if (res.status === 404) throw new NotFound(`${path} not found on the server`)
    if (res.status === 412) throw new PreconditionFailed()
    if (res.status === 507) throw new Error('The WebDAV server is out of space.')
    if (!res.ok && res.status !== 207)
      throw new Error(`WebDAV ${method} ${path || '/'} failed: ${res.status} ${res.statusText}`)
    return res
  }

  async connect(): Promise<void> {
    if (!this.cfg.url) throw new Error('No WebDAV URL configured.')
    // A Depth:0 PROPFIND on the root is the cheapest possible reachability check.
    const res = await this.request('PROPFIND', '', {
      headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
      body: PROPFIND_BODY,
    })
    if (res.status !== 207)
      throw new Error(
        `The server answered ${res.status} to a PROPFIND. Is this a WebDAV endpoint?`,
      )
    this.connected = true
  }

  async list(): Promise<RemoteEntry[]> {
    const out: RemoteEntry[] = []
    const seen = new Set<string>()
    // Breadth-first with Depth:1, a level at a time, bounded concurrency.
    let frontier: string[] = ['']
    let depth = 0
    while (frontier.length && depth < 24) {
      const dirs: string[] = []
      for (let i = 0; i < frontier.length; i += 6) {
        const batch = frontier.slice(i, i + 6)
        const results = await Promise.all(batch.map((d) => this.listOne(d)))
        for (const entries of results) {
          for (const e of entries) {
            if (seen.has(e.path)) continue
            seen.add(e.path)
            if (e.isDir) dirs.push(e.path)
            out.push(e)
          }
        }
      }
      frontier = dirs
      depth++
    }
    return out
  }

  private async listOne(dir: string): Promise<RemoteEntry[]> {
    let res: Response
    try {
      res = await this.request('PROPFIND', dir, {
        headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
        body: PROPFIND_BODY,
      })
    } catch (e) {
      if (e instanceof NotFound) return []
      throw e
    }
    const xml = await res.text()
    return this.parseMultistatus(xml, dir)
  }

  private parseMultistatus(xml: string, dir: string): RemoteEntry[] {
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    if (doc.querySelector('parsererror'))
      throw new Error('The WebDAV server returned a response this client could not parse.')

    const basePath = new URL(this.base, location.href).pathname.replace(/\/+$/, '')
    const out: RemoteEntry[] = []

    for (const resp of Array.from(doc.getElementsByTagNameNS('DAV:', 'response'))) {
      const hrefEl = resp.getElementsByTagNameNS('DAV:', 'href')[0]
      if (!hrefEl?.textContent) continue
      let href = hrefEl.textContent.trim()
      try {
        href = new URL(href, this.base).pathname
      } catch {
        /* already a path */
      }
      let rel = decodeURIComponent(href)
      if (rel.startsWith(basePath)) rel = rel.slice(basePath.length)
      rel = normPath(rel)
      if (!rel || rel === normPath(dir)) continue // the collection itself

      // Only take direct children; some servers echo deeper entries.
      const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
      if (normPath(parent) !== normPath(dir)) continue

      const ok = Array.from(resp.getElementsByTagNameNS('DAV:', 'propstat')).find((ps) =>
        (ps.getElementsByTagNameNS('DAV:', 'status')[0]?.textContent ?? '').includes('200'),
      )
      const prop = ok?.getElementsByTagNameNS('DAV:', 'prop')[0]
      const isDir =
        !!prop?.getElementsByTagNameNS('DAV:', 'collection').length || href.endsWith('/')
      const etag = prop?.getElementsByTagNameNS('DAV:', 'getetag')[0]?.textContent ?? undefined
      const lastMod = prop?.getElementsByTagNameNS('DAV:', 'getlastmodified')[0]?.textContent
      const len = prop?.getElementsByTagNameNS('DAV:', 'getcontentlength')[0]?.textContent

      out.push({
        path: rel,
        isDir,
        rev: etag ? etag.replace(/^W\//, '').replace(/"/g, '') : undefined,
        mtime: lastMod ? Date.parse(lastMod) || undefined : undefined,
        size: len ? Number(len) : undefined,
      })
    }
    return out
  }

  async getText(entry: RemoteEntry): Promise<{ text: string; rev?: string; mtime?: number }> {
    const res = await this.request('GET', entry.path)
    return {
      text: await res.text(),
      rev: cleanEtag(res.headers.get('ETag')) ?? entry.rev,
      mtime: parseDate(res.headers.get('Last-Modified')) ?? entry.mtime,
    }
  }

  async getBlob(entry: RemoteEntry): Promise<{ blob: Blob; rev?: string; mtime?: number }> {
    const res = await this.request('GET', entry.path)
    return {
      blob: await res.blob(),
      rev: cleanEtag(res.headers.get('ETag')) ?? entry.rev,
      mtime: parseDate(res.headers.get('Last-Modified')) ?? entry.mtime,
    }
  }

  async put(
    path: string,
    body: Blob | string,
    mime: string,
    ifMatchRev: string | undefined,
  ): Promise<{ rev?: string; mtime?: number }> {
    await this.ensureDir(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

    const headers: Record<string, string> = { 'Content-Type': mime }
    // If-Match makes the write conditional: the server refuses with 412 if
    // someone else changed the file since we last looked. This is the guarantee
    // that we never blindly overwrite another device's edit.
    if (ifMatchRev) headers['If-Match'] = `"${ifMatchRev}"`
    else headers['If-None-Match'] = '*' // create-only

    let res: Response
    try {
      res = await this.request('PUT', path, { headers, body })
    } catch (e) {
      if (e instanceof PreconditionFailed) throw e
      // Some servers answer If-None-Match:* with 405 rather than 412.
      if (!ifMatchRev && /failed: 40[59]/.test((e as Error).message)) throw new PreconditionFailed()
      throw e
    }

    let rev = cleanEtag(res.headers.get('ETag'))
    let mtime = parseDate(res.headers.get('Last-Modified'))
    // Not every server returns an ETag on PUT; ask for it so the next write can
    // still be conditional rather than silently unguarded.
    if (!rev) {
      const [head] = await this.listOne(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
        .then((all) => all.filter((e) => e.path === normPath(path)))
        .catch(() => [])
      rev = head?.rev
      mtime = mtime ?? head?.mtime
    }
    return { rev, mtime }
  }

  async remove(entry: RemoteEntry): Promise<void> {
    try {
      await this.request('DELETE', entry.path)
    } catch (e) {
      if (e instanceof NotFound) return // already gone; that is success
      throw e
    }
  }

  private ensured = new Set<string>()

  async ensureDir(path: string): Promise<void> {
    const p = normPath(path)
    if (!p || this.ensured.has(p)) return
    const parts = p.split('/')
    let cur = ''
    for (const seg of parts) {
      cur = cur ? `${cur}/${seg}` : seg
      if (this.ensured.has(cur)) continue
      try {
        const res = await fetch(this.urlFor(cur), {
          method: 'MKCOL',
          headers: this.headers(),
          credentials: 'omit',
        })
        // 405 = already exists, which is exactly what we want.
        if (!res.ok && res.status !== 405 && res.status !== 301)
          throw new Error(`Could not create folder "${cur}" (${res.status}).`)
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('Could not create')) throw e
        // Network errors here are surfaced by the subsequent PUT.
      }
      this.ensured.add(cur)
    }
  }
}

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:getetag/>
    <d:getlastmodified/>
    <d:getcontentlength/>
    <d:resourcetype/>
  </d:prop>
</d:propfind>`

function cleanEtag(v: string | null): string | undefined {
  if (!v) return undefined
  return v.replace(/^W\//, '').replace(/"/g, '') || undefined
}

function parseDate(v: string | null): number | undefined {
  if (!v) return undefined
  const t = Date.parse(v)
  return Number.isNaN(t) ? undefined : t
}
