/**
 * The deadline a transfer is given.
 *
 * A flat one is the bug this replaces: a file big enough to need longer than
 * the deadline never syncs at all, because every run aborts it at the same
 * point and the next starts again from zero.
 */

import { describe, expect, it } from 'vitest'
import { MAX_TRANSFER_TIMEOUT_MS, REQUEST_TIMEOUT_MS, TRANSFER_TIMEOUT_MS, bodySize, transferTimeout } from './net'

const MB = 1024 * 1024

describe('transferTimeout', () => {
  it('falls back to the floor when the size is unknown', () => {
    expect(transferTimeout(undefined)).toBe(TRANSFER_TIMEOUT_MS)
    expect(transferTimeout(0)).toBe(TRANSFER_TIMEOUT_MS)
    expect(transferTimeout(Number.NaN)).toBe(TRANSFER_TIMEOUT_MS)
  })

  it('is never shorter than the floor, and never shorter for a bigger file', () => {
    let last = 0
    for (const size of [1, 64 * 1024, MB, 50 * MB, 200 * MB, 2000 * MB]) {
      const t = transferTimeout(size)
      expect(t).toBeGreaterThanOrEqual(TRANSFER_TIMEOUT_MS)
      expect(t).toBeGreaterThanOrEqual(last)
      last = t
    }
  })

  it('gives a large attachment longer than a slow uplink needs', () => {
    // 200 MB over 2 Mbit/s is some 800 seconds of transfer. The old flat 300 s
    // deadline aborted it every time; anything shorter than this still would.
    expect(transferTimeout(200 * MB)).toBeGreaterThan(900_000)
  })

  it('still ends, however large the file', () => {
    expect(transferTimeout(500 * 1024 * MB)).toBe(MAX_TRANSFER_TIMEOUT_MS)
  })

  it('leaves ordinary requests on the short deadline', () => {
    // Notes are small enough that the size term is noise next to the floor.
    expect(transferTimeout(4096)).toBeLessThan(TRANSFER_TIMEOUT_MS + 1000)
    expect(REQUEST_TIMEOUT_MS).toBeLessThan(TRANSFER_TIMEOUT_MS)
  })
})

describe('bodySize', () => {
  it('measures the shapes a request body actually comes in', () => {
    expect(bodySize(new Blob([new Uint8Array(1234)]))).toBe(1234)
    expect(bodySize(new Uint8Array(64))).toBe(64)
    expect(bodySize(new ArrayBuffer(8))).toBe(8)
    // Bytes, not characters: a note full of emoji is three times its length.
    expect(bodySize('héllo')).toBe(6)
  })

  it('says so when it cannot tell', () => {
    expect(bodySize(undefined)).toBeUndefined()
    expect(bodySize(new ReadableStream())).toBeUndefined()
  })
})
