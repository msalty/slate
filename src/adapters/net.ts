/**
 * The one thing both adapters need from the network layer: a request that is
 * guaranteed to end.
 *
 * A `fetch` with no timeout does not fail when a server stops answering — it
 * waits, sometimes for minutes, sometimes until the tab is closed. The sync
 * engine keeps a single in-flight promise so that concurrent calls coalesce, so
 * one hung request does not stall one sync: every later sync joins the stuck
 * one and the app quietly stops syncing until it is reloaded. A deadline turns
 * that into an ordinary error the next run retries.
 *
 * Two of them, because the numbers are answering different questions: how long
 * a server may think about a small request, and how long a large attachment may
 * legitimately take to travel over a slow uplink. The second is not a number at
 * all but a function of size — see `transferTimeout`.
 */

export const REQUEST_TIMEOUT_MS = 60_000
export const TRANSFER_TIMEOUT_MS = 300_000

/**
 * The slowest uplink a transfer is given the benefit of the doubt about.
 *
 * Deliberately pessimistic — half a megabit, which is a bad mobile connection
 * rather than a broken one. A deadline that assumes a fast link turns "slow"
 * into "impossible", and the failure is not a slow sync but no sync: the run
 * aborts at the deadline, the next one restarts the same upload from zero, and
 * the file never lands however long the app is left running.
 */
const SLOWEST_BYTES_PER_SEC = 64 * 1024

/**
 * A ceiling, so this stays a deadline.
 *
 * The point of a deadline is that a request which has stopped making progress
 * eventually fails and gets retried; without a cap a big enough file would push
 * that past any useful horizon.
 */
export const MAX_TRANSFER_TIMEOUT_MS = 6 * 60 * 60 * 1000

/**
 * How long a transfer of `bytes` may take.
 *
 * A flat deadline is fine for a request whose cost is round trips and wrong for
 * one whose cost is bytes: 200 MB over a 2 Mbit/s uplink needs some 800 seconds
 * and would abort, forever, against a flat 300. So the floor covers the
 * round-trip case and the rest scales with size. Unknown size falls back to the
 * floor, which is what a listing-shaped request wants anyway.
 */
export function transferTimeout(bytes: number | undefined): number {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return TRANSFER_TIMEOUT_MS
  const forBytes = Math.ceil((bytes / SLOWEST_BYTES_PER_SEC) * 1000)
  return Math.min(MAX_TRANSFER_TIMEOUT_MS, TRANSFER_TIMEOUT_MS + forBytes)
}

/** Bytes on the wire for a request body, where that is knowable up front. */
export function bodySize(body: unknown): number | undefined {
  if (typeof body === 'string') return new Blob([body]).size
  if (typeof Blob !== 'undefined' && body instanceof Blob) return body.size
  if (body instanceof ArrayBuffer) return body.byteLength
  if (ArrayBuffer.isView(body)) return body.byteLength
  return undefined
}

/**
 * An abort signal that fires after `ms`, where the browser has them.
 *
 * `AbortSignal.timeout` is the whole implementation on anything current. The
 * fallback keeps older engines working rather than throwing at them, and a
 * browser with neither simply gets today's behaviour.
 */
export function timeoutSignal(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal === 'undefined') return undefined
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms)
  if (typeof AbortController === 'undefined') return undefined
  const c = new AbortController()
  setTimeout(() => c.abort(new DOMException('Timed out', 'TimeoutError')), ms)
  return c.signal
}

/** Did this rejection come from one of the deadlines above? */
export function isTimeout(e: unknown): boolean {
  const name = (e as { name?: string } | undefined)?.name
  return name === 'TimeoutError' || name === 'AbortError'
}
