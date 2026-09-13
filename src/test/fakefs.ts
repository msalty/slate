/**
 * An in-memory stand-in for the File System Access API.
 *
 * Enough of it to run the folder adapter and the folder engine for real: a tree
 * of directories and files, handles that behave like handles, and a writable
 * stream that only commits on `close`. It exists so the Connected Folder
 * feature can be tested the way the sync engine is tested — round trips over a
 * shared store, asserting that no content is lost — rather than by mocking the
 * adapter and asserting that it was called.
 *
 * Two details are load-bearing rather than decorative:
 *
 *  - **`lastModified` advances on every write.** The adapter's revision is the
 *    modified time and the size joined, and a store that stamped everything
 *    with the same instant would make every write look like no write at all.
 *  - **`write` buffers and `close` commits.** The adapter aborts a failed write
 *    specifically so a half-written file never replaces a whole one, and a
 *    stub that wrote through would quietly pass that test without it holding.
 *
 * `bypass` writes are the equivalent of the sync tests' `MemoryServer.writeText`:
 * they stand in for another program — Obsidian, git, an editor — changing a
 * file while Slate is not looking.
 */

/** A clock that never repeats, so two writes are never the same revision. */
let clock = 1_700_000_000_000

export function tick(ms = 1000): number {
  clock += ms
  return clock
}

interface FakeFile {
  bytes: Uint8Array
  type: string
  lastModified: number
}

type Node = FakeFile | FakeDir
type FakeDir = Map<string, Node>

function isDir(n: Node): n is FakeDir {
  return n instanceof Map
}

export class FakeFileHandle {
  readonly kind = 'file' as const
  constructor(
    readonly name: string,
    private parent: FakeDir,
  ) {}

  private row(): FakeFile {
    const n = this.parent.get(this.name)
    if (!n || isDir(n)) {
      const e = new Error(`${this.name} is gone`)
      e.name = 'NotFoundError'
      throw e
    }
    return n
  }

  async getFile(): Promise<File> {
    const r = this.row()
    // A real `File` so `.text()`, `.slice()` and `.size` behave exactly as they
    // do in a browser — the adapter uses all three.
    return new File([r.bytes as unknown as BlobPart], this.name, {
      type: r.type,
      lastModified: r.lastModified,
    })
  }

  async createWritable(): Promise<FileSystemWritableFileStream> {
    const parent = this.parent
    const name = this.name
    const chunks: Blob[] = []
    let done = false
    const stream = {
      async write(data: Blob | string | BufferSource) {
        if (done) throw new Error('stream is closed')
        chunks.push(data instanceof Blob ? data : new Blob([data as BlobPart]))
      },
      async close() {
        if (done) return
        done = true
        const blob = new Blob(chunks)
        parent.set(name, {
          bytes: new Uint8Array(await blob.arrayBuffer()),
          type: chunks[0] instanceof Blob ? chunks[0].type : '',
          lastModified: tick(),
        })
      },
      async abort() {
        done = true
      },
      async seek() {},
      async truncate() {},
    }
    return stream as unknown as FileSystemWritableFileStream
  }

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return (other as unknown as FakeFileHandle) === this
  }
}

export class FakeDirectoryHandle {
  readonly kind = 'directory' as const

  constructor(
    readonly name: string,
    readonly dir: FakeDir = new Map(),
  ) {}

  async *entries(): AsyncGenerator<[string, FakeFileHandle | FakeDirectoryHandle]> {
    // A copy, because a sweep that walks the live map while something writes
    // into it is a crash rather than a race the code could handle.
    for (const [name, node] of [...this.dir]) {
      yield [name, isDir(node) ? new FakeDirectoryHandle(name, node) : new FakeFileHandle(name, this.dir)]
    }
  }

  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFileHandle> {
    const n = this.dir.get(name)
    if (n && isDir(n)) throw notFound(name)
    if (!n) {
      if (!opts?.create) throw notFound(name)
      this.dir.set(name, { bytes: new Uint8Array(), type: '', lastModified: tick() })
    }
    return new FakeFileHandle(name, this.dir)
  }

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDirectoryHandle> {
    const n = this.dir.get(name)
    if (n && !isDir(n)) throw notFound(name)
    if (!n) {
      if (!opts?.create) throw notFound(name)
      this.dir.set(name, new Map())
    }
    return new FakeDirectoryHandle(name, this.dir.get(name) as FakeDir)
  }

  async removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void> {
    const n = this.dir.get(name)
    if (!n) throw notFound(name)
    if (isDir(n) && n.size && !opts?.recursive) throw new Error('directory is not empty')
    this.dir.delete(name)
  }

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return (other as unknown as FakeDirectoryHandle).dir === this.dir
  }

  /* ---- the test's own side of the store: another program, editing ------- */

  private at(path: string, create: boolean): { dir: FakeDir; name: string } | undefined {
    const segs = path.split('/').filter(Boolean)
    const name = segs.pop()!
    let d = this.dir
    for (const s of segs) {
      let n = d.get(s)
      if (!n) {
        if (!create) return undefined
        n = new Map()
        d.set(s, n)
      }
      if (!isDir(n)) return undefined
      d = n
    }
    return { dir: d, name }
  }

  /** Write as if from Obsidian, git or a text editor. */
  writeText(path: string, text: string, type = 'text/markdown'): void {
    const loc = this.at(path, true)!
    loc.dir.set(loc.name, {
      bytes: new TextEncoder().encode(text),
      type,
      lastModified: tick(),
    })
  }

  writeBytes(path: string, bytes: Uint8Array, type = 'application/octet-stream'): void {
    const loc = this.at(path, true)!
    loc.dir.set(loc.name, { bytes, type, lastModified: tick() })
  }

  readText(path: string): string | undefined {
    const loc = this.at(path, false)
    const n = loc && loc.dir.get(loc.name)
    return !n || isDir(n) ? undefined : new TextDecoder().decode(n.bytes)
  }

  has(path: string): boolean {
    const loc = this.at(path, false)
    return !!loc && loc.dir.has(loc.name)
  }

  /** Delete as if from another program. */
  unlink(path: string): void {
    const loc = this.at(path, false)
    loc?.dir.delete(loc.name)
  }

  mkdir(path: string): void {
    const loc = this.at(path, true)!
    if (!loc.dir.has(loc.name)) loc.dir.set(loc.name, new Map())
  }

  /** Every file path in the tree, for assertions. */
  paths(): string[] {
    const out: string[] = []
    const walk = (d: FakeDir, prefix: string) => {
      for (const [name, node] of d) {
        const p = prefix ? `${prefix}/${name}` : name
        if (isDir(node)) walk(node, p)
        else out.push(p)
      }
    }
    walk(this.dir, '')
    return out.sort()
  }
}

function notFound(name: string): Error {
  const e = new Error(`${name} not found`)
  e.name = 'NotFoundError'
  return e
}

/** A root directory handle typed as the real thing, for handing to the adapter. */
export function fakeRoot(name = 'Vault'): FakeDirectoryHandle & FileSystemDirectoryHandle {
  return new FakeDirectoryHandle(name) as unknown as FakeDirectoryHandle & FileSystemDirectoryHandle
}
