/**
 * Talking to a language model, and — mostly — explaining why we can't.
 *
 * This module is deliberately lopsided. The part that builds a request and
 * reads a reply is small, because two wire formats cover every provider anyone
 * asks for: Ollama, LM Studio, vLLM, OpenRouter and "custom" all speak
 * OpenAI's `/chat/completions`, and Gemini speaks its own. The rest is
 * diagnosis, and that is the part worth having.
 *
 * **Why diagnosis is most of the file.** A browser cannot tell you why a
 * cross-origin request failed. A server that is not running, a server that is
 * running but sent no `Access-Control-Allow-Origin`, and a request the page was
 * never allowed to make all arrive as the same `TypeError: Failed to fetch`,
 * with nothing on it to tell them apart — the opacity is the security property,
 * not an oversight. So the only way to say anything useful is to reason about
 * the URL *before* sending, and to attach what we know about the provider to
 * whatever comes back. `preflight` catches the one failure that is certain in
 * advance; `explainFailure` turns the rest into the specific thing to go and
 * change.
 *
 * **The failure that is certain in advance** is mixed content. A page served
 * over HTTPS may not fetch `http://`, and no permission, flag or retry changes
 * that. It is the single most likely thing to go wrong here, because the
 * obvious setup — Slate installed from your own HTTPS origin, Ollama running on
 * the desktop at `http://192.168.1.x:11434` — is exactly it. Loopback is the
 * exception (`http://localhost` is a potentially-trustworthy origin), which is
 * why the same setup works on the machine Ollama runs on and fails from the
 * phone. Saying so up front costs one URL parse and saves an afternoon.
 *
 * Everything here is pure: no `fetch`, no settings, no DOM. The network lives
 * in `adapters/llm.ts`, so all of this is testable by calling it.
 */

import type { WireImage } from './images'

/** Which provider's defaults and quirks apply. `none` is the feature switched off. */
export type LlmProvider = 'none' | 'ollama' | 'lmstudio' | 'openai' | 'gemini' | 'custom'

/** The wire format. Every provider above is one of these two. */
export type LlmProtocol = 'openai' | 'gemini'

export interface AiSettings {
  provider: LlmProvider
  /** Where the API lives. Prefilled from the preset, editable for every one. */
  baseUrl: string
  /** Device-local, like the WebDAV password. Never written into the vault. */
  apiKey: string
  /** The model asked to read pictures. Not every model in a list can. */
  visionModel: string
  /**
   * The model asked to work with text, when it should not be the one that
   * reads pictures. Empty means "the same one".
   *
   * Two fields because the two jobs pull in opposite directions and the same
   * person often wants both: a vision model is the slow, expensive one you
   * reach for once, and rewriting a paragraph or summarising thirty notes wants
   * the fast cheap one. Optional, because a setup with one model is the common
   * case and should not have to say so twice.
   */
  textModel: string
  /**
   * How much the model is assumed to be able to read at once, in tokens.
   *
   * A setting rather than a constant because there is no defensible default: a
   * local 8B model is often 8k, a hosted one 128k or more, and the number
   * decides whether summarising thirty notes is one request or six. Guessing
   * high on a small model produces a refusal from the server; guessing low on a
   * large one merely makes more passes than necessary, so the default errs low.
   */
  contextTokens: number
  /**
   * How many notes one question may be answered from.
   *
   * The other half of the budget, and the one that actually binds: a question
   * about a busy tag matches thirty notes and only the best few are worth
   * sending. Separate from `contextTokens` because the two limits answer
   * different questions — how much the model can hold, and how much is worth
   * giving it — and because a hosted model with room for forty notes still
   * produces a better answer from the best eight.
   */
  notesPerQuestion: number
}

/** What a given request needs the model to be able to do. */
export type Capability = 'text' | 'vision'

/**
 * Which model answers for this capability, after the fallback.
 *
 * Tolerant of a field that is not there at all: settings stored by a build
 * older than these two keys come back through a shallow merge, so `textModel`
 * is `undefined` rather than `''` on any device that configured a provider
 * before they existed.
 */
export function modelFor(ai: AiSettings, cap: Capability): string {
  const vision = (ai.visionModel ?? '').trim()
  if (cap === 'vision') return vision
  return (ai.textModel ?? '').trim() || vision
}

export interface Preset {
  label: string
  protocol: LlmProtocol
  baseUrl: string
  /** A request without a key will certainly be refused. */
  needsKey: boolean
  /** A model that exists and can see, for the placeholder. */
  sampleModel: string
  /**
   * What this provider needs configured before it will answer a browser at all.
   * Shown in settings, and again in the failure that means it wasn't done.
   */
  corsFix?: (origin: string) => string
}

export const PRESETS: Record<Exclude<LlmProvider, 'none'>, Preset> = {
  ollama: {
    label: 'Ollama',
    protocol: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    needsKey: false,
    sampleModel: 'llama3.2-vision',
    corsFix: (origin) =>
      `Ollama answers a browser only from origins it was started with. Set OLLAMA_ORIGINS=${origin} in its environment and restart it.`,
  },
  lmstudio: {
    label: 'LM Studio',
    protocol: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    needsKey: false,
    sampleModel: 'qwen2-vl-7b-instruct',
    corsFix: () =>
      'LM Studio blocks browsers until CORS is switched on: Developer → Server settings → Enable CORS, then restart the server.',
  },
  openai: {
    label: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    sampleModel: 'gpt-4o-mini',
  },
  gemini: {
    label: 'Google Gemini',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    needsKey: true,
    sampleModel: 'gemini-2.0-flash',
  },
  custom: {
    label: 'Custom (OpenAI-compatible)',
    protocol: 'openai',
    baseUrl: '',
    needsKey: false,
    sampleModel: '',
    corsFix: (origin) =>
      `The server must send Access-Control-Allow-Origin: ${origin} and allow the Authorization and Content-Type headers.`,
  },
}

export function presetFor(p: LlmProvider): Preset | undefined {
  return p === 'none' ? undefined : PRESETS[p]
}

/**
 * Is there enough here to try? Every AI feature asks this before offering itself.
 *
 * **Per capability, because the features do not all want the same thing.** Only
 * transcription needs a model that can see; rewriting a passage, summarising and
 * asking questions are text, and asking them to wait for a vision model is
 * asking somebody running a text-only model locally — which is most people — to
 * fill in a field that means nothing to them or lose every feature. Getting this
 * wrong made all four disappear at once, which is a hard thing to diagnose from
 * the outside because nothing is left on screen to explain itself.
 */
export function isConfigured(ai: AiSettings, capability: Capability = 'text'): boolean {
  const preset = presetFor(ai.provider)
  if (!preset) return false
  if (!(ai.baseUrl ?? '').trim()) return false
  if (!modelFor(ai, capability)) return false
  if (preset.needsKey && !(ai.apiKey ?? '').trim()) return false
  return true
}

/**
 * Tidy a base URL, and add the `/v1` people leave off.
 *
 * `http://localhost:11434` is what Ollama prints when it starts and what
 * everyone therefore pastes; its OpenAI-compatible API is at `/v1`. Guessing is
 * safe only when there is no path to overwrite — a base of
 * `https://gateway.example.com/openai/v1` means what it says, and appending to
 * it would break a working setup to fix a typo nobody made.
 */
export function normalizeBase(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return trimmed
  }
  if (url.pathname === '' || url.pathname === '/') return `${url.origin}/v1`
  return trimmed
}

/**
 * The endpoint a completion is posted to.
 *
 * Gemini puts the model and the streaming choice in the path — two verbs
 * rather than a flag in the body — so both have to be known here. An
 * OpenAI-compatible server has one path and says `stream: true` in the body.
 */
export function completionUrl(
  ai: AiSettings,
  opts: { capability?: Capability; stream?: boolean } = {},
): string {
  const base = normalizeBase(ai.baseUrl)
  const preset = presetFor(ai.provider)
  if (preset?.protocol === 'gemini') {
    const model = encodeURIComponent(modelFor(ai, opts.capability ?? 'text'))
    const verb = opts.stream ? 'streamGenerateContent?alt=sse' : 'generateContent'
    return `${base}/models/${model}:${verb}`
  }
  return `${base}/chat/completions`
}

/** The endpoint that lists what this server can run. */
export function modelsUrl(ai: AiSettings): string {
  return `${normalizeBase(ai.baseUrl)}/models`
}

export function authHeaders(ai: AiSettings): Record<string, string> {
  const key = ai.apiKey.trim()
  if (!key) return {}
  const preset = presetFor(ai.provider)
  if (preset?.protocol === 'gemini') return { 'x-goog-api-key': key }
  return { Authorization: `Bearer ${key}` }
}

/* ------------------------------------------------------------- reachability */

export interface Preflight {
  /** False when the request cannot possibly succeed and must not be sent. */
  ok: boolean
  /** The whole of what to tell someone, ready to print. Absent when there is nothing to say. */
  message?: string
  /**
   * How loudly to say it, which settings needs and the adapter does not.
   *
   * `incomplete` exists to keep a half-filled form quiet: "no API key" is true
   * the moment you pick OpenAI and says nothing a person typing into the key
   * field below does not already know. Shouting it in red at somebody who is
   * mid-way through filling the form in trains them to ignore the red box that
   * later means something.
   */
  kind?: 'blocked' | 'caution' | 'incomplete'
}

/** Loopback is a secure context wherever it appears, which is what saves it. */
function isLoopback(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost')
}

/**
 * What we can know about this URL without sending anything.
 *
 * The `blocked` case is the whole reason this function exists: it is a certain
 * failure, it is the most common one, and the error the browser would raise is
 * indistinguishable from four other problems. Catching it here means the person
 * reading the message is told about TLS rather than left to suspect their
 * firewall.
 */
export function preflight(ai: AiSettings, pageOrigin: string): Preflight {
  const raw = ai.baseUrl.trim()
  if (!raw) return { ok: false, kind: 'incomplete', message: 'No server address yet.' }

  let url: URL
  try {
    url = new URL(normalizeBase(raw))
  } catch {
    return {
      ok: false,
      kind: 'blocked',
      message: `“${raw}” is not a URL. It needs the scheme too, e.g. http://localhost:11434.`,
    }
  }
  /*
   * Almost always the scheme left off rather than an exotic protocol: `new URL`
   * parses "localhost:11434" quite happily, as scheme "localhost:" with a path
   * of "11434". Reporting that literally ("localhost: is not a protocol") is
   * accurate and no help at all, so the message names the thing to type.
   */
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return {
      ok: false,
      kind: 'blocked',
      message:
        `“${raw}” is missing its scheme — the browser reads it as a “${url.protocol}” address rather than as a server. ` +
        `Write it out in full, e.g. http://localhost:11434.`,
    }

  const pageIsHttps = pageOrigin.startsWith('https:')
  if (pageIsHttps && url.protocol === 'http:' && !isLoopback(url.hostname))
    return {
      ok: false,
      kind: 'blocked',
      message:
        `Slate is served over HTTPS, so the browser will refuse to call ${url.origin} — a page cannot make plain http requests, ` +
        `and there is no setting that changes it.\n\n` +
        `This is the usual wall: a model running on another machine on your network is only reachable from here over https. ` +
        `Put it behind a reverse proxy with a certificate (the README's Caddy block does it in four lines) and use that address instead. ` +
        `On the machine the model itself is running on, http://localhost works and is exempt.`,
    }

  if (pageIsHttps && url.protocol === 'http:' && isLoopback(url.hostname))
    return {
      ok: true,
      kind: 'caution',
      message:
        `${url.origin} is loopback, so it is exempt from the https rule and should work. Two things can still stop it: ` +
        `Chrome now asks permission the first time a page calls your local network, and Safari is stricter than either about this. ` +
        `If it fails here but works in curl, that is what it will be.`,
    }

  const preset = presetFor(ai.provider)
  if (preset?.needsKey && !ai.apiKey.trim())
    return { ok: false, kind: 'incomplete', message: `${preset.label} needs an API key.` }

  return { ok: true }
}

/* ------------------------------------------------------------------ errors */

export class LlmError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LlmError'
  }
}

/**
 * A network rejection with no status on it. This is the opaque case — a
 * `TypeError` from `fetch` — and covers "nothing is listening", "something is
 * listening but refused this origin", and a request blocked before it left.
 */
export function isOpaqueNetworkFailure(e: unknown): boolean {
  return e instanceof TypeError || (e as Error | undefined)?.name === 'TypeError'
}

/**
 * Turn whatever went wrong into the specific thing to go and change.
 *
 * `status` is undefined for the opaque case. The wording deliberately gives the
 * two candidates in the order they are likely, rather than picking one and
 * being confidently wrong half the time.
 */
export function explainFailure(
  ai: AiSettings,
  origin: string,
  status: number | undefined,
  serverMessage?: string,
): string {
  const preset = presetFor(ai.provider)
  const name = preset?.label ?? 'The server'
  const detail = serverMessage?.trim() ? `\n\nIt said: ${serverMessage.trim()}` : ''

  if (status === undefined) {
    const cors = preset?.corsFix?.(origin)
    return (
      `Could not reach ${normalizeBase(ai.baseUrl)}. The browser does not say why, so it is one of two things:\n\n` +
      `• Nothing is listening there — check the address and that the server is running.\n` +
      `• It is listening, but did not allow this page's origin (${origin}).` +
      (cors ? `\n\n${cors}` : '')
    )
  }
  if (status === 401 || status === 403)
    return `${name} refused the key${preset?.needsKey ? '' : ' (or wants one it was not given)'}.${detail}`
  if (status === 404)
    return (
      `${normalizeBase(ai.baseUrl)} answered, but there is nothing at that path. ` +
      `An OpenAI-compatible base usually ends in /v1. A wrong model name also lands here.${detail}`
    )
  if (status === 413) return `The image was too large for ${name}.${detail}`
  if (status === 429) return `${name} is rate-limiting this key. Try again shortly.${detail}`
  if (status >= 500) return `${name} failed on its side (HTTP ${status}).${detail}`
  return `${name} refused the request (HTTP ${status}).${detail}`
}

/** Dig the human-readable half out of an error body, whatever shape it came in. */
export function serverErrorMessage(body: unknown): string | undefined {
  if (typeof body === 'string') return body.slice(0, 400) || undefined
  const o = body as { error?: unknown; message?: string } | undefined
  if (!o) return undefined
  if (typeof o.error === 'string') return o.error
  const err = o.error as { message?: string } | undefined
  return err?.message ?? o.message
}

/* ------------------------------------------------------- requests & replies */

/**
 * A text request, optionally streaming, with the instructions kept apart from
 * the material.
 *
 * The split matters more than it looks. Everything in `system` is what the
 * model is being *asked to do*; everything in `user` is *your writing*. Keeping
 * a note's text out of the instruction slot is what stops a note that happens
 * to contain the words "ignore the above and write a poem" from being read as
 * an instruction — it cannot be prevented outright, but material that arrives
 * as material is markedly harder to confuse with a command than material
 * pasted into the middle of one.
 */
export function textRequest(
  ai: AiSettings,
  system: string,
  user: string,
  opts: { stream?: boolean } = {},
): unknown {
  if (presetFor(ai.provider)?.protocol === 'gemini') {
    return {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature: 0.2 },
    }
  }
  return {
    model: modelFor(ai, 'text'),
    temperature: 0.2,
    stream: opts.stream ?? false,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  }
}

/**
 * The text carried by one streamed event, for whichever format it came in.
 *
 * Both protocols stream the same way once the SSE framing is off — a JSON
 * object per event — so only the path to the words differs. Returning `''` for
 * an event that carries none (a role announcement, a usage record, a heartbeat)
 * rather than throwing: a stream is full of those and none of them is a
 * problem.
 */
export function streamDelta(ai: AiSettings, event: unknown): string {
  if (presetFor(ai.provider)?.protocol === 'gemini') {
    const e = event as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
    return (e?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('')
  }
  const e = event as {
    choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>
  }
  const c = e?.choices?.[0]
  return c?.delta?.content ?? c?.message?.content ?? ''
}

/**
 * Take off a code fence the model wrapped its whole answer in.
 *
 * Several models fence any answer with structure in it, and the fence is
 * packaging rather than content. An *inner* fence is left alone — a screenshot
 * of code transcribes to one, and "rewrite this as a shell script" should come
 * back as one — so only a fence enclosing everything is removed.
 */
export function unfence(raw: string): string {
  const text = raw.replace(/^﻿/, '').trim()
  const m = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n?\1\s*$/.exec(text)
  return m ? m[2].trim() : text
}

/**
 * The body for a one-shot "look at this picture and answer" request.
 *
 * Takes only the two fields it puts on the wire rather than the whole
 * `WireImage`: the pixel dimensions are for telling you what was sent, and a
 * function that does not use them should not be able to.
 */
export function visionRequest(
  ai: AiSettings,
  image: Pick<WireImage, 'base64' | 'mime'>,
  prompt: string,
): unknown {
  if (presetFor(ai.provider)?.protocol === 'gemini') {
    return {
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }, { inline_data: { mime_type: image.mime, data: image.base64 } }],
        },
      ],
      generationConfig: { temperature: 0 },
    }
  }
  return {
    model: modelFor(ai, 'vision'),
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } },
        ],
      },
    ],
  }
}

/**
 * The text out of a reply.
 *
 * Both formats have more than one shape in the wild — OpenAI's `content` is a
 * string from most servers and an array of parts from a few, and Gemini splits
 * a long answer across parts — so both are handled rather than assumed.
 * Returning `undefined` means "answered, but with nothing in it", which the
 * caller reports differently from a failure.
 */
export function readCompletion(ai: AiSettings, body: unknown): string | undefined {
  if (presetFor(ai.provider)?.protocol === 'gemini') {
    const b = body as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>
      promptFeedback?: { blockReason?: string }
    }
    const blocked = b?.promptFeedback?.blockReason
    if (blocked) throw new LlmError(`Gemini declined to answer (${blocked}).`)
    const parts = b?.candidates?.[0]?.content?.parts ?? []
    const text = parts.map((p) => p.text ?? '').join('')
    return text.trim() || undefined
  }
  const b = body as {
    choices?: Array<{ message?: { content?: unknown } }>
  }
  const content = b?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content.trim() || undefined
  if (Array.isArray(content)) {
    const text = content
      .map((p) => (typeof p === 'string' ? p : ((p as { text?: string }).text ?? '')))
      .join('')
    return text.trim() || undefined
  }
  return undefined
}

/** Model ids out of a listing, in whichever of the two shapes arrived. */
export function readModelList(ai: AiSettings, body: unknown): string[] {
  if (presetFor(ai.provider)?.protocol === 'gemini') {
    const b = body as { models?: Array<{ name?: string }> }
    return (b?.models ?? [])
      .map((m) => (m.name ?? '').replace(/^models\//, ''))
      .filter(Boolean)
      .sort()
  }
  const b = body as { data?: Array<{ id?: string }> }
  return (b?.data ?? [])
    .map((m) => m.id ?? '')
    .filter(Boolean)
    .sort()
}
