/**
 * Hashing a file that is too big to hold.
 *
 * `hashBlob` is on the path where a pasted video kills the tab, so what these
 * pin is not speed but two promises the sync engine leans on: a file's hash is
 * the same on every device that has the same bytes, and a file small enough to
 * have been hashed by an earlier version of the app still hashes to what it
 * always did.
 */

import { describe, expect, it } from 'vitest'
import { HASH_CHUNK_BYTES, hashBlob, hashText } from './util'

/** Pseudo-random but reproducible, so a failure can be looked at twice. */
function bytes(n: number, seed = 1): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n)
  let x = seed >>> 0
  for (let i = 0; i < n; i++) {
    x = (x * 1664525 + 1013904223) >>> 0
    out[i] = x >>> 24
  }
  return out
}

/** What the single-shot path computed before chunking existed. */
async function wholeBlobHash(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(digest).slice(0, 16)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

describe('hashBlob under one chunk', () => {
  it('is exactly the hash it always was', async () => {
    for (const size of [0, 1, 1024, 1024 * 1024]) {
      const blob = new Blob([bytes(size)])
      expect(await hashBlob(blob)).toBe(await wholeBlobHash(blob))
    }
  })

  it('agrees with hashText on the same bytes', async () => {
    const text = 'a note, as it would be stored'
    expect(await hashBlob(new Blob([text]))).toBe(await hashText(text))
  })
})

describe('hashBlob above one chunk', () => {
  const big = HASH_CHUNK_BYTES + 4096

  it('is stable for the same bytes and different for different ones', async () => {
    const a = new Blob([bytes(big, 1)])
    const again = new Blob([bytes(big, 1)])
    const b = new Blob([bytes(big, 2)])

    const ha = await hashBlob(a)
    expect(ha).toBe(await hashBlob(again))
    expect(ha).not.toBe(await hashBlob(b))
    expect(ha).toHaveLength(32)
  })

  it('does not depend on how the blob was assembled', async () => {
    // Same bytes, one blob built in pieces and one in a single buffer. A hash
    // that read the parts rather than the content would differ here, and two
    // devices would disagree about a file they both hold.
    const all = bytes(big, 7)
    const inParts = new Blob([all.slice(0, 100), all.slice(100, 5_000_000), all.slice(5_000_000)])
    expect(await hashBlob(inParts)).toBe(await hashBlob(new Blob([all])))
  })

  it('changes when a byte in a later chunk changes', async () => {
    const a = bytes(big, 3)
    const b = a.slice()
    b[big - 1] ^= 0xff
    expect(await hashBlob(new Blob([a]))).not.toBe(await hashBlob(new Blob([b])))
  })
})
