/**
 * Callouts: a blockquote that says what kind of aside it is.
 *
 *   > [!WARNING] Don't do this on a Friday
 *   > The deploy window closes at 16:00.
 *
 * The syntax is **GitHub's alert syntax**, which matters more than it looks.
 * It is not an invention here and not an Obsidian extension: GitHub renders it,
 * every other markdown renderer falls back to an ordinary blockquote, and the
 * file on disk is still plain CommonMark. A note with callouts in it opens
 * anywhere and loses only the tint — which is the same bargain the rest of this
 * app makes.
 *
 * Five *kinds* carry a colour, because five is what GitHub defines and every
 * extra one is a palette decision that has to work in light and dark forever.
 * The much longer list of names people actually type — Obsidian's vocabulary,
 * mostly — is aliased onto those five, keeping its own icon where the icon says
 * something the colour doesn't. So `[!bug]` is a bug in caution red rather than
 * a plain quote, and the palette stays five colours wide.
 *
 * A name that isn't in the table is deliberately *not* a callout: it renders as
 * the plain blockquote it is, exactly as GitHub does with an unknown alert.
 *
 * One thing here is Obsidian's rather than GitHub's: the `-` after the marker
 * that means "collapsed". It is the only place a fold could live without
 * inventing state — see `Callout.fold`.
 */

/** The five colour families. Everything else aliases onto one of these. */
export type CalloutKind = 'note' | 'tip' | 'important' | 'warning' | 'caution'

export interface CalloutSpec {
  kind: CalloutKind
  /** Key into ICONS. Aliases share a colour but may keep their own glyph. */
  icon: string
  /** Shown when the author gave the callout no title of its own. */
  label: string
}

/**
 * Every name that means something, mapped to its colour and glyph.
 *
 * Keys are lowercase; lookup lowercases the name, so `[!NOTE]`, `[!Note]` and
 * `[!note]` are one thing.
 */
const TYPES: Record<string, CalloutSpec> = {
  // --- note: the neutral, informational family ---------------------------
  note: { kind: 'note', icon: 'note', label: 'Note' },
  info: { kind: 'note', icon: 'note', label: 'Info' },
  abstract: { kind: 'note', icon: 'abstract', label: 'Abstract' },
  summary: { kind: 'note', icon: 'abstract', label: 'Summary' },
  tldr: { kind: 'note', icon: 'abstract', label: 'TL;DR' },
  example: { kind: 'note', icon: 'example', label: 'Example' },
  quote: { kind: 'note', icon: 'quote', label: 'Quote' },
  cite: { kind: 'note', icon: 'quote', label: 'Citation' },

  // --- tip: advice, and things that went right ---------------------------
  tip: { kind: 'tip', icon: 'tip', label: 'Tip' },
  hint: { kind: 'tip', icon: 'tip', label: 'Hint' },
  success: { kind: 'tip', icon: 'success', label: 'Success' },
  check: { kind: 'tip', icon: 'success', label: 'Check' },
  done: { kind: 'tip', icon: 'success', label: 'Done' },

  // --- important: read this, and questions about it ----------------------
  important: { kind: 'important', icon: 'important', label: 'Important' },
  question: { kind: 'important', icon: 'question', label: 'Question' },
  help: { kind: 'important', icon: 'question', label: 'Help' },
  faq: { kind: 'important', icon: 'question', label: 'FAQ' },

  // --- warning: proceed carefully ----------------------------------------
  warning: { kind: 'warning', icon: 'warning', label: 'Warning' },
  attention: { kind: 'warning', icon: 'warning', label: 'Attention' },
  todo: { kind: 'warning', icon: 'todo', label: 'Todo' },

  // --- caution: it is already broken, or it will break something ---------
  caution: { kind: 'caution', icon: 'caution', label: 'Caution' },
  danger: { kind: 'caution', icon: 'caution', label: 'Danger' },
  error: { kind: 'caution', icon: 'caution', label: 'Error' },
  failure: { kind: 'caution', icon: 'caution', label: 'Failure' },
  fail: { kind: 'caution', icon: 'caution', label: 'Fail' },
  missing: { kind: 'caution', icon: 'caution', label: 'Missing' },
  bug: { kind: 'caution', icon: 'bug', label: 'Bug' },
}

/**
 * Every name the parser accepts, in the order the completion offers them —
 * declaration order, which groups each colour family together.
 */
export const CALLOUT_NAMES: string[] = Object.keys(TYPES)

/** The colour and glyph for a name, or undefined if it isn't a callout type. */
export function calloutSpec(name: string): CalloutSpec | undefined {
  return TYPES[name.toLowerCase()]
}

export interface Callout {
  spec: CalloutSpec
  /** The name as written, before aliasing — `[!bug]` keeps "bug". */
  name: string
  /**
   * Offsets *within the line* of the `[!type]` marker, including any Obsidian
   * fold character and one trailing space. Replacing exactly this range with
   * the icon leaves the title starting flush, the same way a hidden `## `
   * takes its own trailing space with it.
   */
  markerFrom: number
  markerTo: number
  /**
   * Obsidian's fold character, as written: `-` collapsed, `+` expanded, and
   * `''` for a callout nobody has folded yet.
   *
   * Which is also *where the fold lives*. It could have been editor state, and
   * then a note would fold itself back up on every reload, look different in
   * two windows onto the same file, and lose the shape you left it in the
   * moment it synced to another device. Obsidian writes it into the line, the
   * file stays a plain blockquote everywhere else, and the fold survives
   * everything the text survives.
   */
  fold: '' | '-' | '+'
  /** Offset within the line where the fold character sits, or would go. */
  foldAt: number
  /** The author's own title, if they wrote one after the marker. */
  title: string
}

/*
 * `> [!type]` with the quote markers in front of it.
 *
 * The prefix repeats so a callout nested inside another blockquote is still
 * recognised, and the fold character Obsidian writes (`[!note]-`) is captured
 * rather than left on screen as a stray dash: it says whether the callout is
 * collapsed, and the live preview both honours it and writes it.
 */
const CALLOUT = /^((?:[ \t]*>)+[ \t]?)[ \t]*(\[!([A-Za-z][A-Za-z0-9_-]*)\]([-+]?))([ \t]*)(.*)$/

/** Read the first line of a blockquote. Undefined when it isn't a callout. */
export function parseCallout(line: string): Callout | undefined {
  const m = CALLOUT.exec(line)
  if (!m) return undefined
  const spec = TYPES[m[3].toLowerCase()]
  // An unknown name stays an ordinary blockquote, exactly as GitHub renders it.
  if (!spec) return undefined
  const markerFrom = line.indexOf(m[2], m[1].length)
  const markerTo = markerFrom + m[2].length + Math.min(m[5].length, 1)
  const fold = m[4] as '' | '-' | '+'
  return {
    spec,
    name: m[3],
    markerFrom,
    markerTo,
    fold,
    // The `]` of the marker is the last thing before it, fold character or not.
    foldAt: markerFrom + m[2].length - fold.length,
    title: m[6].trim(),
  }
}

/**
 * The same line with its fold character set to what you ask for.
 *
 * `''` removes it, which is what "unfold" writes rather than a `+`: a callout
 * nobody has folded and one somebody has unfolded are the same callout, and
 * leaving a `+` behind would mean every callout ever collapsed carried a mark
 * saying so for the rest of its life. `+` is still read on the way in, because
 * other apps write it.
 */
export function withCalloutFold(line: string, fold: '' | '-' | '+'): string {
  const c = parseCallout(line)
  if (!c || c.fold === fold) return line
  return line.slice(0, c.foldAt) + fold + line.slice(c.foldAt + c.fold.length)
}

/** Inner SVG for each glyph, drawn on a 24×24 grid with `currentColor`. */
export const ICONS: Record<string, string> = {
  note: '<circle cx="12" cy="12" r="9.2"/><path d="M12 11.4v5M12 7.9h.01"/>',
  abstract:
    '<path d="M5 4.5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1Z"/><path d="M8 9h8M8 12.5h8M8 16h5"/>',
  example: '<path d="M9 6.5h11M9 12h11M9 17.5h11M4.4 6.5h.01M4.4 12h.01M4.4 17.5h.01"/>',
  quote:
    '<path d="M10 11.5H5.5a.5.5 0 0 1-.5-.5V7.5a.5.5 0 0 1 .5-.5H9a.5.5 0 0 1 .5.5V16a2.5 2.5 0 0 1-2.5 2.5"/><path d="M19.5 11.5H15a.5.5 0 0 1-.5-.5V7.5a.5.5 0 0 1 .5-.5h3.5a.5.5 0 0 1 .5.5V16a2.5 2.5 0 0 1-2.5 2.5"/>',
  tip: '<path d="M9 17.5h6M10 20.5h4"/><path d="M12 3a6 6 0 0 0-3.4 10.9c.5.4.9 1 .9 1.6h5c0-.6.4-1.2.9-1.6A6 6 0 0 0 12 3Z"/>',
  success: '<circle cx="12" cy="12" r="9.2"/><path d="m8.2 12.2 2.6 2.6 5-5.2"/>',
  important:
    '<path d="M20.5 14.5a2 2 0 0 1-2 2H8l-4 3.5v-14a2 2 0 0 1 2-2h12.5a2 2 0 0 1 2 2Z"/><path d="M12 7.6v4M12 14.2h.01"/>',
  question: '<circle cx="12" cy="12" r="9.2"/><path d="M9.6 9.7a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.8-.9 1.4v.4M12 16.8h.01"/>',
  warning:
    '<path d="M10.3 4.3 2.6 17.4a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z"/><path d="M12 9.6v4M12 16.8h.01"/>',
  todo: '<rect x="3.4" y="3.4" width="17.2" height="17.2" rx="3"/><path d="m8.4 12.2 2.6 2.6 4.6-4.8"/>',
  caution:
    '<path d="M8.6 3.4h6.8l4.8 4.8v6.8l-4.8 4.8H8.6l-4.8-4.8V8.2Z"/><path d="M12 8.2v4.4M12 16h.01"/>',
  bug: '<path d="M8 5.5a4 4 0 0 1 8 0"/><path d="M6.5 10.5a5.5 5.5 0 0 1 11 0v3a5.5 5.5 0 0 1-11 0Z"/><path d="M6.5 12H3M21 12h-3.5M6.9 8 4.2 6.2M17.1 8l2.7-1.8M6.9 16.2 4.2 18M17.1 16.2l2.7 1.8"/>',
}
