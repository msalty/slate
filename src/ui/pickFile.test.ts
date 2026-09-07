/**
 * What the Insert > "File in Slate" picker finds, and in what order.
 *
 * The ordering is the whole reason this is not a plain `filter`: a list of
 * files sorted only by date makes you scroll past everything newer than the
 * one you named, and a match on a folder name is nearly never what somebody
 * typing a filename meant.
 */

import { describe, expect, it } from 'vitest'
import { rankFiles } from './pickFile'

const f = (path: string, mtime: number) => ({ path, mtime })

/** Newest first, the order `attachments` hands the picker. */
const vault = [
  f('attachments/2024/receipt-march.pdf', 500),
  f('charts/quarterly.png', 400),
  f('attachments/chart-of-accounts.png', 300),
  f('charts/old/chart-draft.png', 200),
  f('attachments/logo.svg', 100),
]

describe('rankFiles', () => {
  it('leaves the list alone when nothing has been typed', () => {
    expect(rankFiles(vault, '')).toEqual(vault)
    expect(rankFiles(vault, '   ')).toEqual(vault)
  })

  it('keeps only files every term matches', () => {
    expect(rankFiles(vault, 'png').map((x) => x.path)).toEqual([
      'charts/quarterly.png',
      'attachments/chart-of-accounts.png',
      'charts/old/chart-draft.png',
    ])
    expect(rankFiles(vault, 'old chart').map((x) => x.path)).toEqual(['charts/old/chart-draft.png'])
    expect(rankFiles(vault, 'nothing-like-this')).toEqual([])
  })

  it('ignores case and word order', () => {
    expect(rankFiles(vault, 'MARCH receipt').map((x) => x.path)).toEqual([
      'attachments/2024/receipt-march.pdf',
    ])
  })

  it('puts names that start with what you typed first, folders last', () => {
    // "chart-…" starts with it; "quarterly.png" only matches through its
    // folder, so it goes below both files actually named chart-something.
    expect(rankFiles(vault, 'chart').map((x) => x.path)).toEqual([
      'attachments/chart-of-accounts.png',
      'charts/old/chart-draft.png',
      'charts/quarterly.png',
    ])
  })

  it('keeps newest first within a rank', () => {
    const same = [f('a/report-b.pdf', 200), f('a/report-a.pdf', 100)]
    expect(rankFiles(same, 'report').map((x) => x.path)).toEqual(['a/report-b.pdf', 'a/report-a.pdf'])
  })
})
