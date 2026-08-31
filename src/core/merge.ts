/**
 * Line-based three-way merge (diff3).
 *
 * When the same note has been edited on two devices since their last common
 * ancestor, this is what decides whether the two edits can be combined. If they
 * touched different parts of the note, they merge cleanly and neither side
 * loses anything. If they touched the same lines, the merge reports a conflict
 * and the sync engine keeps *both* versions as separate files rather than
 * picking a winner.
 *
 * Implementation follows Khanna/Kunal/Pierce: align each side to the base with
 * an LCS, take regions where all three agree as stable, and classify the
 * unstable regions between them.
 */

export interface MergeResult {
  merged: string
  conflict: boolean
  /** Number of unstable regions that could not be resolved. */
  conflicts: number
}

/** Longest common subsequence, returned as aligned (indexA, indexB) pairs. */
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length
  const m = b.length
  if (n === 0 || m === 0) return []

  // Trim common prefix/suffix first — for two edits of the same document this
  // collapses almost the entire input and keeps the DP table small.
  let pre = 0
  while (pre < n && pre < m && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++

  const aa = a.slice(pre, n - suf)
  const bb = b.slice(pre, m - suf)
  const pairs: Array<[number, number]> = []
  for (let i = 0; i < pre; i++) pairs.push([i, i])

  const p = aa.length
  const q = bb.length
  if (p && q) {
    // Guard against pathological inputs: a full DP table on two huge, totally
    // different files would allocate gigabytes. Above the cap, treat the middle
    // as wholly changed — the merge then conflicts, which is the safe outcome.
    if (p * q <= 12_000_000) {
      const dp = new Uint32Array((p + 1) * (q + 1))
      const w = q + 1
      for (let i = p - 1; i >= 0; i--) {
        for (let j = q - 1; j >= 0; j--) {
          dp[i * w + j] =
            aa[i] === bb[j]
              ? dp[(i + 1) * w + j + 1] + 1
              : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
        }
      }
      let i = 0
      let j = 0
      while (i < p && j < q) {
        if (aa[i] === bb[j]) {
          pairs.push([pre + i, pre + j])
          i++
          j++
        } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++
        else j++
      }
    }
  }

  for (let i = 0; i < suf; i++) pairs.push([n - suf + i, m - suf + i])
  return pairs
}

interface Chunk {
  baseStart: number
  baseEnd: number
  aStart: number
  aEnd: number
  bStart: number
  bEnd: number
  stable: boolean
}

function diff3Chunks(base: string[], a: string[], b: string[]): Chunk[] {
  const ma = new Map(lcsPairs(base, a))
  const mb = new Map(lcsPairs(base, b))

  const chunks: Chunk[] = []
  let bi = 0
  let ai = 0
  let bbi = 0

  while (bi < base.length) {
    const pa = ma.get(bi)
    const pb = mb.get(bi)
    if (pa !== undefined && pb !== undefined && pa === ai && pb === bbi) {
      // Start of a stable run: base, A and B all agree from here.
      const start = bi
      let len = 0
      while (
        ma.get(bi) === ai + len &&
        mb.get(bi) === bbi + len &&
        bi < base.length
      ) {
        bi++
        len++
      }
      chunks.push({
        baseStart: start,
        baseEnd: bi,
        aStart: ai,
        aEnd: ai + len,
        bStart: bbi,
        bEnd: bbi + len,
        stable: true,
      })
      ai += len
      bbi += len
    } else {
      // Unstable: scan forward to the next point where all three re-align.
      const baseStart = bi
      const aStart = ai
      const bStart = bbi
      let k = bi
      let foundA = -1
      let foundB = -1
      while (k < base.length) {
        const qa = ma.get(k)
        const qb = mb.get(k)
        if (qa !== undefined && qb !== undefined && qa >= aStart && qb >= bStart) {
          foundA = qa
          foundB = qb
          break
        }
        k++
      }
      if (k >= base.length) {
        chunks.push({
          baseStart,
          baseEnd: base.length,
          aStart,
          aEnd: a.length,
          bStart,
          bEnd: b.length,
          stable: false,
        })
        bi = base.length
        ai = a.length
        bbi = b.length
      } else {
        chunks.push({
          baseStart,
          baseEnd: k,
          aStart,
          aEnd: foundA,
          bStart,
          bEnd: foundB,
          stable: false,
        })
        bi = k
        ai = foundA
        bbi = foundB
      }
    }
  }

  // Anything left over past the end of base is a trailing unstable region.
  if (ai < a.length || bbi < b.length) {
    chunks.push({
      baseStart: base.length,
      baseEnd: base.length,
      aStart: ai,
      aEnd: a.length,
      bStart: bbi,
      bEnd: b.length,
      stable: false,
    })
  }
  return chunks
}

function eq(x: string[], y: string[]): boolean {
  if (x.length !== y.length) return false
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false
  return true
}

/**
 * Merge `mine` and `theirs` given their common ancestor `base`.
 *
 * `labelMine` / `labelTheirs` name the sides in conflict markers, which are
 * only emitted when `markers` is true. The sync engine calls this with markers
 * off: it wants to know *whether* there is a conflict so it can preserve both
 * files intact, not to paste markers into the user's note.
 */
export function merge3(
  base: string,
  mine: string,
  theirs: string,
  opts: { markers?: boolean; labelMine?: string; labelTheirs?: string } = {},
): MergeResult {
  if (mine === theirs) return { merged: mine, conflict: false, conflicts: 0 }
  if (base === mine) return { merged: theirs, conflict: false, conflicts: 0 }
  if (base === theirs) return { merged: mine, conflict: false, conflicts: 0 }

  const nl = mine.includes('\r\n') || theirs.includes('\r\n') ? '\r\n' : '\n'
  const split = (s: string) => s.split(/\r?\n/)
  const B = split(base)
  const A = split(mine)
  const T = split(theirs)

  const out: string[] = []
  let conflicts = 0

  for (const c of diff3Chunks(B, A, T)) {
    if (c.stable) {
      out.push(...A.slice(c.aStart, c.aEnd))
      continue
    }
    const ba = B.slice(c.baseStart, c.baseEnd)
    const aa = A.slice(c.aStart, c.aEnd)
    const tt = T.slice(c.bStart, c.bEnd)

    if (eq(aa, tt)) out.push(...aa) // same edit on both sides
    else if (eq(aa, ba)) out.push(...tt) // only theirs changed
    else if (eq(tt, ba)) out.push(...aa) // only mine changed
    else if (ba.length === 0 && aa.length > 0 && tt.length > 0) {
      // Both sides inserted text at the same point and neither removed
      // anything. This is by far the most common divergence in a notes app —
      // jotting something on a phone and on a laptop between syncs — and
      // treating it as a conflict would be needlessly destructive when both
      // pieces of text can simply coexist.
      //
      // The order is decided lexicographically rather than by which side is
      // "local", so every device computing this merge independently arrives at
      // byte-identical output and the vault still converges.
      const mineText = aa.join('\n')
      const theirsText = tt.join('\n')
      const [first, second] = mineText <= theirsText ? [aa, tt] : [tt, aa]
      out.push(...first, ...second)
    } else {
      conflicts++
      if (opts.markers) {
        out.push(`<<<<<<< ${opts.labelMine ?? 'local'}`)
        out.push(...aa)
        out.push('=======')
        out.push(...tt)
        out.push(`>>>>>>> ${opts.labelTheirs ?? 'remote'}`)
      } else {
        // Without markers the caller only cares about the flag; keep our side
        // so the string is still valid content if it is ever used.
        out.push(...aa)
      }
    }
  }

  return { merged: out.join(nl), conflict: conflicts > 0, conflicts }
}
