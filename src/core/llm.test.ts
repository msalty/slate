/**
 * The half of the model connection that can be wrong without anyone noticing.
 *
 * Two things are tested here and one is not. The wire shapes are tested because
 * a request built slightly wrong fails identically to a server that is down.
 * The diagnosis is tested *harder*, because it is the only thing standing
 * between a person and an afternoon spent suspecting their firewall — and
 * because a wrong diagnosis is worse than none: it sends them to go and change
 * something that was already right. What is not tested is `fetch`, which is the
 * whole reason none of this file touches it.
 */

import { describe, expect, it } from 'vitest'
import {
  authHeaders,
  completionUrl,
  explainFailure,
  isConfigured,
  modelFor,
  modelsUrl,
  normalizeBase,
  preflight,
  readCompletion,
  readModelList,
  serverErrorMessage,
  visionRequest,
  type AiSettings,
} from './llm'

const ollama = (over: Partial<AiSettings> = {}): AiSettings => ({
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  apiKey: '',
  visionModel: 'llama3.2-vision',
  textModel: '',
  contextTokens: 16000,
  notesPerQuestion: 6,
  ...over,
})

const gemini = (over: Partial<AiSettings> = {}): AiSettings => ({
  provider: 'gemini',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  apiKey: 'k',
  visionModel: 'gemini-2.0-flash',
  textModel: '',
  contextTokens: 16000,
  notesPerQuestion: 6,
  ...over,
})

const image = { base64: 'QUJD', mime: 'image/jpeg' }

describe('the base URL', () => {
  it('adds the /v1 people leave off a bare address', () => {
    expect(normalizeBase('http://localhost:11434')).toBe('http://localhost:11434/v1')
    expect(normalizeBase('http://localhost:11434/')).toBe('http://localhost:11434/v1')
  })

  it('leaves a path that was actually typed alone', () => {
    expect(normalizeBase('https://gw.example.com/openai/v1')).toBe('https://gw.example.com/openai/v1')
    expect(normalizeBase('https://gw.example.com/v1/')).toBe('https://gw.example.com/v1')
  })

  it('does not mangle something that is not a URL, so the error can say so', () => {
    expect(normalizeBase('localhost:11434')).toBe('localhost:11434')
  })
})

describe('endpoints and auth', () => {
  it('posts an OpenAI-compatible completion to /chat/completions', () => {
    expect(completionUrl(ollama())).toBe('http://localhost:11434/v1/chat/completions')
    expect(modelsUrl(ollama())).toBe('http://localhost:11434/v1/models')
  })

  it('puts the model in the path for Gemini, escaped', () => {
    expect(completionUrl(gemini())).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
    )
  })

  it('sends the key the way each provider wants it, and none when there is none', () => {
    expect(authHeaders(ollama())).toEqual({})
    expect(authHeaders(ollama({ apiKey: 'sk-1' }))).toEqual({ Authorization: 'Bearer sk-1' })
    expect(authHeaders(gemini())).toEqual({ 'x-goog-api-key': 'k' })
  })
})

describe('whether the feature is offered at all', () => {
  it('needs a provider, an address and a model', () => {
    expect(isConfigured(ollama())).toBe(true)
    expect(isConfigured(ollama({ provider: 'none' }))).toBe(false)
    expect(isConfigured(ollama({ baseUrl: '  ' }))).toBe(false)
    expect(isConfigured(ollama({ visionModel: '' }))).toBe(false)
  })

  it('needs a key only where one is required', () => {
    expect(isConfigured(ollama({ apiKey: '' }))).toBe(true)
    expect(isConfigured(gemini({ apiKey: '' }))).toBe(false)
  })

  /*
   * The regression this pins: asking for a *vision* model before offering the
   * three text features made all four vanish at once for anyone running a
   * text-only model, which is most people running one locally — and with every
   * affordance gone there was nothing left on screen to explain why.
   */
  it('offers the text features to somebody with no vision model at all', () => {
    const textOnly = ollama({ visionModel: '', textModel: 'qwen2.5:14b' })
    expect(isConfigured(textOnly, 'text')).toBe(true)
    expect(isConfigured(textOnly)).toBe(true)
    expect(isConfigured(textOnly, 'vision')).toBe(false)
  })

  it('lets one model in either field serve everything it can', () => {
    const visionOnly = ollama({ visionModel: 'llama3.2-vision', textModel: '' })
    expect(isConfigured(visionOnly, 'text')).toBe(true)
    expect(isConfigured(visionOnly, 'vision')).toBe(true)
  })

  it('still refuses when there is no model of any kind', () => {
    const none = ollama({ visionModel: '', textModel: '' })
    expect(isConfigured(none, 'text')).toBe(false)
    expect(isConfigured(none, 'vision')).toBe(false)
  })

  it('survives settings stored before these fields existed', () => {
    // A shallow merge hands the old four-key object straight through, so the
    // two newer keys arrive as `undefined` rather than as empty strings.
    const old = { provider: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '', visionModel: 'llava' }
    expect(() => isConfigured(old as never)).not.toThrow()
    expect(isConfigured(old as never)).toBe(true)
    expect(modelFor(old as never, 'text')).toBe('llava')
  })
})

describe('preflight: the failure that is certain in advance', () => {
  it('refuses an http server on the network from an https page, and says why', () => {
    const p = preflight(ollama({ baseUrl: 'http://192.168.1.10:11434/v1' }), 'https://notes.example.com')
    expect(p.ok).toBe(false)
    expect(p.kind).toBe('blocked')
    expect(p.message).toMatch(/HTTPS/)
    expect(p.message).toMatch(/reverse proxy/)
  })

  it('lets loopback through, because it is exempt — with the caveat attached', () => {
    const p = preflight(ollama(), 'https://notes.example.com')
    expect(p.ok).toBe(true)
    expect(p.kind).toBe('caution')
    expect(p.message).toMatch(/loopback/)
  })

  it('has no objection to either when the page itself is http', () => {
    expect(preflight(ollama({ baseUrl: 'http://192.168.1.10:11434/v1' }), 'http://localhost:5173').ok).toBe(
      true,
    )
  })

  it('treats 127.0.0.1, ::1 and *.localhost as loopback too', () => {
    for (const host of ['http://127.0.0.1:11434', 'http://[::1]:11434', 'http://ollama.localhost']) {
      const p = preflight(ollama({ baseUrl: host }), 'https://notes.example.com')
      expect(p.ok, host).toBe(true)
    }
  })

  it('says nothing loud about a form that is merely unfinished', () => {
    expect(preflight(ollama({ baseUrl: '' }), 'https://n.example').kind).toBe('incomplete')
    expect(preflight(gemini({ apiKey: '' }), 'https://n.example').kind).toBe('incomplete')
  })

  it('catches an address with no scheme, which is the common typo', () => {
    // `new URL` parses this as scheme "localhost:", so the naive message would
    // be about protocols rather than about the http:// that is missing.
    const p = preflight(ollama({ baseUrl: 'localhost:11434' }), 'https://n.example')
    expect(p.ok).toBe(false)
    expect(p.message).toMatch(/missing its scheme/)
    expect(p.message).toMatch(/http:\/\/localhost:11434/)
  })

  it('still reports something that is not a URL at all', () => {
    expect(preflight(ollama({ baseUrl: 'not a url' }), 'https://n.example').message).toMatch(/not a URL/)
  })
})

describe('explaining a failure that already happened', () => {
  it('gives both candidates for the opaque case, and the provider-specific fix', () => {
    const m = explainFailure(ollama(), 'https://notes.example.com', undefined)
    expect(m).toMatch(/Nothing is listening/)
    expect(m).toMatch(/did not allow this page/)
    expect(m).toMatch(/OLLAMA_ORIGINS=https:\/\/notes\.example\.com/)
  })

  it('names the CORS switch for LM Studio instead', () => {
    const m = explainFailure(ollama({ provider: 'lmstudio' }), 'https://n.example', undefined)
    expect(m).toMatch(/Enable CORS/)
  })

  it('reads 404 as a path problem, since that is what it nearly always is', () => {
    expect(explainFailure(ollama(), 'https://n.example', 404)).toMatch(/\/v1/)
  })

  it('passes the server’s own words through when it sent any', () => {
    expect(explainFailure(gemini(), 'https://n.example', 400, 'unsupported mime type')).toMatch(
      /unsupported mime type/,
    )
  })

  it('digs the message out of either error envelope', () => {
    expect(serverErrorMessage({ error: { message: 'no such model' } })).toBe('no such model')
    expect(serverErrorMessage({ error: 'flat' })).toBe('flat')
    expect(serverErrorMessage({ message: 'top level' })).toBe('top level')
    expect(serverErrorMessage(undefined)).toBeUndefined()
  })
})

describe('the request body', () => {
  it('builds OpenAI content parts with the image as a data URL', () => {
    const body = visionRequest(ollama(), image, 'read it') as {
      model: string
      messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>
    }
    expect(body.model).toBe('llama3.2-vision')
    expect(body.messages[0].content[0]).toEqual({ type: 'text', text: 'read it' })
    expect(body.messages[0].content[1].image_url?.url).toBe('data:image/jpeg;base64,QUJD')
  })

  it('builds Gemini inline_data with the bare base64, and no model in the body', () => {
    const body = visionRequest(gemini(), image, 'read it') as {
      model?: string
      contents: Array<{ parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> }>
    }
    expect(body.model).toBeUndefined()
    expect(body.contents[0].parts[1].inline_data).toEqual({ mime_type: 'image/jpeg', data: 'QUJD' })
  })
})

describe('reading the reply', () => {
  it('takes OpenAI content as a string or as parts', () => {
    expect(readCompletion(ollama(), { choices: [{ message: { content: ' hi ' } }] })).toBe('hi')
    expect(
      readCompletion(ollama(), { choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] } }] }),
    ).toBe('ab')
  })

  it('joins Gemini parts, because a long answer arrives split', () => {
    expect(
      readCompletion(gemini(), { candidates: [{ content: { parts: [{ text: 'one ' }, { text: 'two' }] } }] }),
    ).toBe('one two')
  })

  it('reports an empty answer as undefined rather than as an empty string', () => {
    expect(readCompletion(ollama(), { choices: [{ message: { content: '   ' } }] })).toBeUndefined()
    expect(readCompletion(ollama(), {})).toBeUndefined()
    expect(readCompletion(gemini(), { candidates: [] })).toBeUndefined()
  })

  it('turns a Gemini safety block into an error rather than silence', () => {
    expect(() => readCompletion(gemini(), { promptFeedback: { blockReason: 'SAFETY' } })).toThrow(/SAFETY/)
  })

  it('reads a model list in either shape, stripping Gemini’s models/ prefix', () => {
    expect(readModelList(ollama(), { data: [{ id: 'b' }, { id: 'a' }] })).toEqual(['a', 'b'])
    expect(readModelList(gemini(), { models: [{ name: 'models/gemini-2.0-flash' }] })).toEqual([
      'gemini-2.0-flash',
    ])
    expect(readModelList(ollama(), {})).toEqual([])
  })
})
