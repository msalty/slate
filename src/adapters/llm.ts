/**
 * The network half of talking to a model. Everything that decides *what* to
 * send and *what a failure means* is in `core/llm.ts`; this file is the fetch.
 *
 * Two deadlines rather than one, for the same reason `net.ts` has two: they are
 * answering different questions. Listing models is a small request to a server
 * that is either there or is not, and a minute is generous. Generating from a
 * picture is real work — a 7B vision model on a laptop CPU can take a couple of
 * minutes on one screenshot, and a deadline shorter than that turns "slow" into
 * "broken" for exactly the setup this feature is meant to serve.
 */

import {
  authHeaders,
  completionUrl,
  explainFailure,
  isOpaqueNetworkFailure,
  LlmError,
  modelFor,
  modelsUrl,
  preflight,
  readCompletion,
  readModelList,
  serverErrorMessage,
  streamDelta,
  textRequest,
  visionRequest,
  type AiSettings,
  type Capability,
} from '../core/llm'
import type { WireImage } from '../core/images'
import { isTimeout, REQUEST_TIMEOUT_MS, timeoutSignal } from './net'

/** A model reading a picture is allowed to think for three minutes. */
export const GENERATE_TIMEOUT_MS = 180_000

function origin(): string {
  return typeof location === 'undefined' ? 'https://localhost' : location.origin
}

/**
 * One request, with every failure already turned into something worth reading.
 *
 * The `catch` is where the opacity is handled: a `TypeError` here carries no
 * information at all, so it is handed to `explainFailure` with no status and
 * comes back as the two candidates plus this provider's CORS fix. A timeout is
 * told apart first, because "it never answered" and "it refused" want different
 * things done about them.
 */
async function call(ai: AiSettings, url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const pre = preflight(ai, origin())
  if (!pre.ok) throw new LlmError(pre.message ?? 'Not configured.')

  let res: Response
  try {
    res = await fetch(url, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...authHeaders(ai), ...init.headers },
      signal: timeoutSignal(timeoutMs),
    })
  } catch (e) {
    if (isTimeout(e))
      throw new LlmError(
        `No answer from the server within ${Math.round(timeoutMs / 1000)}s. A local model on a slow machine can genuinely take this long — or it may have stopped.`,
      )
    if (isOpaqueNetworkFailure(e)) throw new LlmError(explainFailure(ai, origin(), undefined))
    throw new LlmError((e as Error).message)
  }

  const body = await parseBody(res)
  if (!res.ok) throw new LlmError(explainFailure(ai, origin(), res.status, serverErrorMessage(body)))
  return body
}

/** JSON where there is JSON, the raw text where the server sent an HTML error page. */
async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * What this server can run.
 *
 * Doubles as the connection test, which is why it is the button in settings:
 * it is the cheapest request that proves the address, the CORS configuration
 * and the key are all right at once, and unlike a completion it costs nothing
 * and cannot be refused for being about a picture.
 */
export async function listModels(ai: AiSettings): Promise<string[]> {
  const body = await call(ai, modelsUrl(ai), { method: 'GET' }, REQUEST_TIMEOUT_MS)
  return readModelList(ai, body)
}

/**
 * How long a stream may go without saying anything before it is abandoned.
 *
 * The deadline `net.ts` builds is a *total* one, which is the wrong shape here:
 * a local model writing four hundred words can legitimately take minutes, and a
 * total deadline generous enough for that would also sit patiently through a
 * connection that died two seconds in. What actually distinguishes working from
 * dead is the gap *between* tokens, so that is what is timed — the clock is put
 * back to zero on every chunk that arrives.
 *
 * Generous, because the first gap is the longest: a model has to load and read
 * the whole prompt before it emits anything, and on a cold local model with
 * thirty notes to get through that is not quick.
 */
export const STREAM_IDLE_MS = 90_000

export interface StreamOptions {
  /** Called with each piece of text as it arrives. */
  onChunk?: (text: string) => void
  /** Lets the caller give up — a cancelled dialog, a closed note. */
  signal?: AbortSignal
}

/**
 * Ask for text, and hand it back as it is written.
 *
 * Falls back silently to a single non-streaming request when the server does
 * not answer with an event stream: `stream: true` is advertised by nearly every
 * OpenAI-compatible server and honoured by slightly fewer, and a proxy in the
 * middle may collapse it. There is nothing for a person to do about that, so it
 * is not made their problem — the text simply arrives all at once.
 */
export async function streamText(
  ai: AiSettings,
  system: string,
  user: string,
  opts: StreamOptions = {},
): Promise<string> {
  const url = completionUrl(ai, { capability: 'text', stream: true })
  const body = JSON.stringify(textRequest(ai, system, user, { stream: true }))

  const pre = preflight(ai, origin())
  if (!pre.ok) throw new LlmError(pre.message ?? 'Not configured.')

  const idle = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const kick = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => idle.abort(new DOMException('Idle', 'TimeoutError')), STREAM_IDLE_MS)
  }
  const stop = () => timer && clearTimeout(timer)
  const signal = anySignal([idle.signal, opts.signal])

  let res: Response
  kick()
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(ai) },
      body,
      signal,
    })
  } catch (e) {
    stop()
    throw streamFailure(ai, e, opts.signal)
  }

  if (!res.ok) {
    stop()
    const text = await res.text().catch(() => '')
    let parsed: unknown = text
    try {
      parsed = JSON.parse(text)
    } catch {
      /* an HTML error page; the raw text is the message */
    }
    throw new LlmError(explainFailure(ai, origin(), res.status, serverErrorMessage(parsed)))
  }

  // Not an event stream after all: read it as one ordinary reply.
  if (!/text\/event-stream/i.test(res.headers.get('content-type') ?? '') || !res.body) {
    stop()
    const whole = await res.json().catch(() => undefined)
    const text = readCompletion(ai, whole)
    if (text === undefined) throw emptyAnswer(ai, 'text')
    return text
  }

  let out = ''
  try {
    for await (const event of sseEvents(res.body, kick)) {
      const text = streamDelta(ai, event)
      if (!text) continue
      out += text
      opts.onChunk?.(text)
    }
  } catch (e) {
    stop()
    // Whatever arrived before the break is still worth having, but only the
    // caller knows that: a half-written rewrite is not silently returned as if
    // it were finished.
    throw streamFailure(ai, e, opts.signal)
  }
  stop()
  if (!out.trim()) throw emptyAnswer(ai, 'text')
  return out
}

function emptyAnswer(ai: AiSettings, capability: Capability): LlmError {
  return new LlmError(
    `${modelFor(ai, capability)} answered with nothing.` +
      (capability === 'vision'
        ? ' If it is not a vision model it may have ignored the image — check that the model you picked can see.'
        : ''),
  )
}

function streamFailure(ai: AiSettings, e: unknown, userSignal?: AbortSignal): LlmError {
  if (userSignal?.aborted) return new LlmError('Cancelled.')
  if (isTimeout(e))
    return new LlmError(
      `The server stopped sending after ${Math.round(STREAM_IDLE_MS / 1000)}s of silence. ` +
        `A local model can be slow to start, but this is longer than slow.`,
    )
  if (isOpaqueNetworkFailure(e)) return new LlmError(explainFailure(ai, origin(), undefined))
  return new LlmError((e as Error).message)
}

/**
 * `AbortSignal.any`, with a fallback for engines that have not got it.
 *
 * Two reasons to give up on a stream — the idle clock and the person who closed
 * the dialog — and `fetch` takes one signal.
 */
function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal {
  const live = signals.filter((s): s is AbortSignal => !!s)
  if (live.length === 1) return live[0]
  const AnyOf = (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any
  if (AnyOf) return AnyOf(live)
  const c = new AbortController()
  for (const s of live) {
    if (s.aborted) c.abort(s.reason)
    else s.addEventListener('abort', () => c.abort(s.reason), { once: true })
  }
  return c.signal
}

/**
 * Server-sent events, as parsed objects.
 *
 * The framing is the same for both protocols: `data: ` lines carrying JSON,
 * blank-line separated, and OpenAI's `[DONE]` sentinel to finish. A chunk off
 * the network is not a line, so the tail of one has to be carried into the
 * next — the bug this shape exists to avoid is a JSON object split across two
 * reads, which happens constantly and only under load.
 *
 * `onData` is called for every read rather than every event, because an
 * arriving byte is proof of life whether or not it completed a line.
 */
async function* sseEvents(body: ReadableStream<Uint8Array>, onData: () => void) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      onData()
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          yield JSON.parse(payload)
        } catch {
          /* a partial or non-JSON event; the next one will be whole */
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

/** Ask the configured vision model to answer `prompt` about `image`. */
export async function askAboutImage(
  ai: AiSettings,
  image: WireImage,
  prompt: string,
): Promise<string> {
  const body = await call(
    ai,
    completionUrl(ai, { capability: 'vision' }),
    { method: 'POST', body: JSON.stringify(visionRequest(ai, image, prompt)) },
    GENERATE_TIMEOUT_MS,
  )
  const text = readCompletion(ai, body)
  if (text === undefined) throw emptyAnswer(ai, 'vision')
  return text
}
