/**
 * An in-memory adapter that behaves like a real conditional-write backend.
 *
 * It exists so the sync engine's guarantees can be tested without a server:
 * it enforces If-Match, bumps a revision on every write, and can be mutated
 * directly to stand in for "a second device changed this while you were away".
 */

import { PreconditionFailed, type RemoteAdapter, type RemoteEntry } from '../core/types'
import { normPath } from '../core/util'

interface Row {
  body: Blob
  rev: string
  mtime: number
}

export class MemoryServer {
  readonly files = new Map<string, Row>()
  private counter = 0

  private nextRev(): string {
    return `r${++this.counter}`
  }

  /** Write as if from another device, bypassing preconditions. */
  writeText(path: string, text: string, at = Date.now()): string {
    const rev = this.nextRev()
    this.files.set(normPath(path), {
      body: new Blob([text], { type: 'text/markdown' }),
      rev,
      mtime: at,
    })
    return rev
  }

  async readText(path: string): Promise<string | undefined> {
    const row = this.files.get(normPath(path))
    return row ? row.body.text() : undefined
  }

  remove(path: string): void {
    this.files.delete(normPath(path))
  }

  put(path: string, body: Blob, ifMatchRev: string | undefined): { rev: string; mtime: number } {
    const p = normPath(path)
    const existing = this.files.get(p)
    if (ifMatchRev !== undefined && existing?.rev !== ifMatchRev) throw new PreconditionFailed()
    if (ifMatchRev === undefined && existing) throw new PreconditionFailed('exists')
    const rev = this.nextRev()
    const mtime = Date.now()
    this.files.set(p, { body, rev, mtime })
    return { rev, mtime }
  }
}

export class MemoryAdapter implements RemoteAdapter {
  readonly id = 'memory'
  readonly label = 'In-memory'
  private connected = false

  constructor(private server: MemoryServer) {}

  describe() {
    return 'in-memory test server'
  }
  isConnected() {
    return this.connected
  }
  async connect() {
    this.connected = true
  }

  async list(): Promise<RemoteEntry[]> {
    return [...this.server.files.entries()].map(([path, row]) => ({
      path,
      isDir: false,
      rev: row.rev,
      mtime: row.mtime,
      size: row.body.size,
    }))
  }

  async getText(entry: RemoteEntry) {
    const row = this.server.files.get(entry.path)
    if (!row) throw new Error(`missing ${entry.path}`)
    return { text: await row.body.text(), rev: row.rev, mtime: row.mtime }
  }

  async getBlob(entry: RemoteEntry) {
    const row = this.server.files.get(entry.path)
    if (!row) throw new Error(`missing ${entry.path}`)
    return { blob: row.body, rev: row.rev, mtime: row.mtime }
  }

  async put(path: string, body: Blob | string, mime: string, ifMatchRev: string | undefined) {
    const blob = typeof body === 'string' ? new Blob([body], { type: mime }) : body
    return this.server.put(path, blob, ifMatchRev)
  }

  async remove(entry: RemoteEntry) {
    this.server.remove(entry.path)
  }

  async ensureDir() {
    /* flat store */
  }
}
