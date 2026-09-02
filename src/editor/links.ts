/**
 * External links: recognising them, opening them, and editing them.
 *
 * A note is a plain markdown file, so a link is whatever the text says it is —
 * `[label](https://…)`, a bare `https://…`, a `mailto:`, an `ssh://` to a box
 * you keep notes about. All of them are worth one tap, and the operating
 * system already knows which program handles each scheme. So the rule here is
 * to recognise generously and hand off to the platform, with one hard line:
 * `javascript:`, `data:` and friends are never opened, because a note that
 * syncs from a shared vault is untrusted input.
 */

import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

/**
 * Schemes that carry an authority — `scheme://host/…`. Anything shaped like
 * this is allowed through even if it isn't listed, because "and whatever else
 * my machine handles" is the whole point; the deny list below is what keeps
 * that safe.
 */
const AUTHORITY_RE = /^[a-z][a-z0-9+.-]{1,31}:\/\//i

/**
 * Schemes without an authority, which have to be named to be recognised:
 * `mailto:you@example.com` has no `//`, and neither does `tel:`.
 */
const FLAT_SCHEMES = new Set([
  'mailto',
  'tel',
  'sms',
  'callto',
  'facetime',
  'facetime-audio',
  'skype',
  'im',
  'xmpp',
  'matrix',
  'geo',
  'maps',
  'magnet',
  'bitcoin',
  'news',
  'sip',
  'sips',
  'webcal',
  'market',
  'msteams',
  'zoommtg',
  'slack',
  'spotify',
  'obsidian',
])

/**
 * Never opened, whatever the text says.
 *
 * `javascript:` executes in the page, and `data:`/`blob:` can carry a whole
 * document — a link in a synced note is content from wherever that vault has
 * been, so neither gets a chance to run.
 */
const DENIED = new Set(['javascript', 'data', 'blob', 'vbscript', 'about', 'chrome', 'file'])

function schemeOf(url: string): string {
  const m = /^([a-z][a-z0-9+.-]{0,31}):/i.exec(url)
  return m ? m[1].toLowerCase() : ''
}

/** True when this string names something the platform could open. */
export function isUri(raw: string): boolean {
  const s = raw.trim()
  if (!s) return false
  const scheme = schemeOf(s)
  if (!scheme) return /^www\.[^\s]+\.[^\s]/i.test(s)
  if (DENIED.has(scheme)) return false
  return AUTHORITY_RE.test(s) || FLAT_SCHEMES.has(scheme)
}

/**
 * The URL to actually navigate to, or undefined when the text isn't one — or
 * names a scheme we refuse. A bare `www.` host gets https, the way every
 * address bar does.
 */
export function normalizeUri(raw: string): string | undefined {
  const s = raw.trim()
  if (!isUri(s)) return undefined
  return schemeOf(s) ? s : `https://${s}`
}

/**
 * A Home Screen web app on iOS.
 *
 * It is the one place `window.open` is the wrong call for a web link. There is
 * no tab to open one in, so iOS opens an empty view *inside the app*, hands the
 * URL to Safari, and leaves that blank page behind — which is what you come
 * back to, and have to dismiss, when you return to the app.
 *
 * `navigator.standalone` is iOS's own flag for this and exists nowhere else. An
 * installed app on a desktop or on Android is deliberately not included: there
 * `window.open` puts the link in an ordinary browser window, which is exactly
 * what it should do.
 */
function iosStandalone(): boolean {
  return (navigator as Navigator & { standalone?: boolean }).standalone === true
}

/**
 * Open a link the way its scheme wants to be opened.
 *
 * Web links get a tab. Everything else is a hand-off to another program —
 * a mail client, a dialler, a terminal — and `window.open` for those leaves an
 * orphaned blank tab behind on most browsers, so they navigate instead: the
 * handler takes over and the page never actually unloads.
 *
 * On iOS's Home Screen apps that hand-off is the right shape for a web link
 * too. The address is outside the app's scope, so iOS opens it in the browser
 * and the app is still sitting there when you come back — with no blank page in
 * between, because none was ever opened.
 */
export function openUri(raw: string): void {
  const url = normalizeUri(raw)
  if (!url) return
  const scheme = schemeOf(url)
  if ((scheme === 'http' || scheme === 'https') && !iosStandalone()) {
    window.open(url, '_blank', 'noopener,noreferrer')
    return
  }
  window.location.href = url
}

/* ------------------------------------------------------------- scanning */

/**
 * Bare URLs in a line of text.
 *
 * Deliberately a textual scan, like the hashtag and highlight scanners: the
 * markdown parser only autolinks a subset of this, and a `ssh://` in a note is
 * every bit as clickable as an `https://`.
 *
 * Trailing punctuation is trimmed, because a sentence that ends "see
 * https://example.com." means the link without the full stop. Balanced
 * brackets are kept — Wikipedia URLs are full of them.
 */
const BARE_URI_RE =
  /(^|[\s(<])((?:[a-z][a-z0-9+.-]{1,31}:\/\/|(?:mailto|tel|sms|callto|facetime|skype|xmpp|matrix|geo|maps|magnet|webcal|market|msteams|zoommtg|slack|obsidian|sip|news|bitcoin):|www\.)[^\s<>"')\]]*[^\s<>"')\].,;:!?])/gi

export interface UriMatch {
  from: number
  to: number
  url: string
}

export function scanUris(text: string, offset = 0): UriMatch[] {
  const out: UriMatch[] = []
  BARE_URI_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = BARE_URI_RE.exec(text))) {
    const raw = m[2]
    if (!isUri(raw)) continue
    const from = offset + m.index + m[1].length
    out.push({ from, to: from + raw.length, url: raw })
  }
  return out
}

/* ------------------------------------------------------- editing a link */

export interface LinkSpan {
  /** Range of the whole `[text](url)` construct. */
  from: number
  to: number
  text: string
  url: string
}

/** The markdown link the caret sits in, if any. */
export function linkAt(state: EditorState, pos: number): LinkSpan | undefined {
  const line = state.doc.lineAt(pos)
  const re = /(!?)\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^)\s]*)(\s+"[^"\n]*")?\s*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line.text))) {
    if (m[1]) continue // an image, not a link
    const from = line.from + m.index
    const to = from + m[0].length
    if (pos < from || pos > to) continue
    const rawUrl = m[3]
    const url = rawUrl.startsWith('<') && rawUrl.endsWith('>') ? rawUrl.slice(1, -1) : rawUrl
    return { from, to, text: m[2], url }
  }
  return undefined
}

/** A bare URL the caret sits in — also editable as a link. */
export function bareUriAt(state: EditorState, pos: number): LinkSpan | undefined {
  const line = state.doc.lineAt(pos)
  for (const u of scanUris(line.text, line.from)) {
    if (pos >= u.from && pos <= u.to) return { from: u.from, to: u.to, text: '', url: u.url }
  }
  return undefined
}

/**
 * What the link dialog should open with: an existing link under the caret, or
 * the selected text as a label waiting for a URL.
 */
export function linkTarget(state: EditorState): {
  from: number
  to: number
  text: string
  url: string
} {
  const range = state.selection.main
  const existing = linkAt(state, range.head) ?? bareUriAt(state, range.head)
  if (existing) return existing
  if (!range.empty) {
    return {
      from: range.from,
      to: range.to,
      text: state.doc.sliceString(range.from, range.to),
      url: '',
    }
  }
  // No selection: offer the word the caret is in, the way the inline marks do.
  const line = state.doc.lineAt(range.head)
  const rel = range.head - line.from
  const left = /[\w'-]*$/.exec(line.text.slice(0, rel))?.[0].length ?? 0
  const right = /^[\w'-]*/.exec(line.text.slice(rel))?.[0].length ?? 0
  return {
    from: range.head - left,
    to: range.head + right,
    text: line.text.slice(rel - left, rel + right),
    url: '',
  }
}

/**
 * Write a link over a range. An empty URL removes the link and leaves the
 * label behind, which is what "clear" means to someone who opened the dialog
 * on an existing one.
 */
export function linkEdit(
  from: number,
  to: number,
  text: string,
  url: string,
): TransactionSpec {
  const label = text.trim()
  const target = url.trim()
  const insert = !target ? label : label && label !== target ? `[${label}](${target})` : target
  return {
    changes: { from, to, insert },
    selection: EditorSelection.cursor(from + insert.length),
    userEvent: 'input.format',
  }
}

export function applyLink(view: EditorView, from: number, to: number, text: string, url: string) {
  view.dispatch(linkEdit(from, to, text, url))
  view.focus()
}
