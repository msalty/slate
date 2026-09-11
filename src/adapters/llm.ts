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
  modelsUrl,
  preflight,
  readCompletion,
  readModelList,
  serverErrorMessage,
  visionRequest,
  type AiSettings,
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

/** Ask the configured vision model to answer `prompt` about `image`. */
export async function askAboutImage(
  ai: AiSettings,
  image: WireImage,
  prompt: string,
): Promise<string> {
  const body = await call(
    ai,
    completionUrl(ai),
    { method: 'POST', body: JSON.stringify(visionRequest(ai, image, prompt)) },
    GENERATE_TIMEOUT_MS,
  )
  const text = readCompletion(ai, body)
  if (text === undefined)
    throw new LlmError(
      `${ai.visionModel} answered with nothing. If it is not a vision model it may have ignored the image — check that the model you picked can see.`,
    )
  return text
}
