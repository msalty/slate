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
 * legitimately take to travel over a slow uplink.
 */

export const REQUEST_TIMEOUT_MS = 60_000
export const TRANSFER_TIMEOUT_MS = 300_000

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
