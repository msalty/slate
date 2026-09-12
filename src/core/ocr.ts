/**
 * Reading the text out of a picture and putting it in the note.
 *
 * The first thing in Slate that asks a model for anything, and it is first on
 * purpose: it is the shape of AI feature that cannot hurt you. One picture
 * goes out, some text comes back, you read it and decide. Nothing is written
 * until you press the button, what gets written is ordinary markdown in an
 * ordinary file, and with no provider configured the feature is not there at
 * all rather than there and broken.
 *
 * Two rules it keeps:
 *
 *   - **The vault never holds anything only a model can explain.** A
 *     transcription lands as plain text in the note, indistinguishable from
 *     typing it in yourself, because that is what it is. No sidecar file, no
 *     marker, nothing to migrate later.
 *   - **Nothing is destroyed.** Text is inserted after the picture it came
 *     from, never over anything, and the write goes through `saveNote` — so it
 *     takes a version-history snapshot like every other edit and is undone by
 *     the same machinery.
 *
 * The text work here is pure and separately tested; the network half is two
 * calls to `adapters/llm.ts`.
 */

import { unfence } from './llm'
import { scanMdLinks, scanWikiLinks } from './markdown'

/**
 * What the model is asked for.
 *
 * Written to constrain rather than to charm. The two failure modes that make a
 * transcription useless are commentary ("This image appears to show…") and
 * helpfulness — a model that corrects a misspelling, completes a cut-off word
 * or tidies a layout has given you something other than what is in the picture,
 * and you cannot tell which parts by reading it. Hence "verbatim", hence the
 * explicit instruction to leave errors alone, and hence being told what to do
 * when there is no text, which is the case that otherwise produces a paragraph
 * of apology.
 */
export const TRANSCRIBE_PROMPT = [
  'Transcribe every piece of text in this image, verbatim.',
  '',
  'Rules:',
  '- Output only the transcription. No preamble, no commentary, no description of the image.',
  '- Keep the original line breaks, reading order and structure.',
  '- Reproduce spelling, punctuation and capitalisation exactly as written, including mistakes. Do not correct, complete or tidy anything.',
  '- Use markdown only where the image itself is structured that way: headings as #, lists as -, checkboxes as - [ ] or - [x], and tables as markdown tables.',
  '- Where text is genuinely illegible, write [illegible] in its place rather than guessing.',
  '- If the image contains no text at all, reply with exactly: (no text found)',
].join('\n')

/** What the prompt asks for when there is nothing to read. */
export const NO_TEXT = '(no text found)'

/**
 * Take off what the model wrapped the answer in.
 *
 * Only two things are removed, both of which are the model packaging rather
 * than content: an outer code fence, which several models add when the answer
 * is structured, and surrounding blank space. Everything else is left exactly
 * as it came, including anything that looks like a preamble — a line that
 * *might* be commentary might equally be the first line of a letter, and a
 * transcription that quietly drops the top line of the page is worse than one
 * with an obvious stray sentence you can delete in a keystroke.
 *
 * An inner fence is left alone: a screenshot of code transcribes *to* a fenced
 * block, and stripping that would be stripping the content.
 */
export function cleanTranscript(raw: string): string {
  return unfence(raw)
}

/** Did the model tell us the picture has nothing to read? */
export function foundNothing(text: string): boolean {
  return text.replace(/[.\s]+$/, '').toLowerCase() === NO_TEXT.replace(/[.\s]+$/, '')
}

/* ---------------------------------------------------------------- insertion */

export interface InsertOptions {
  /** Vault path of the attachment that was transcribed. */
  target: string
  /** Resolve an embed reference the way the vault does, from this note. */
  resolve: (ref: string) => string | undefined
}

/**
 * Put `transcript` into `text`, after the embed of the picture it came from.
 *
 * Position is the whole point. A transcription appended to the end of a long
 * note is separated from the picture that explains it, and a note with four
 * screenshots in it becomes four unattributed blocks of text at the bottom.
 * After the embed it reads as a caption and needs no explanation at all.
 *
 * An embed can be written three ways — `![[path]]`, `![](path)` and a bare
 * relative path in either — and resolution is the vault's job rather than this
 * function's, so the caller passes it in and the tests can pass a map.
 *
 * The fallback is the end of the note, for the case the lightbox reached the
 * file from the file list rather than from a note that embeds it. Appending
 * there is a little untidy and never wrong; refusing would be neither.
 */
export function insertTranscript(text: string, transcript: string, opts: InsertOptions): string {
  const body = transcript.trim()
  if (!body) return text

  const at = embedLineEnd(text, opts)
  if (at === undefined) {
    const base = text.replace(/\s+$/, '')
    return base ? `${base}\n\n${body}\n` : `${body}\n`
  }

  /*
   * Exactly one blank line on each side, whatever was there before.
   *
   * The blank lines already in the note are absorbed rather than added to, so
   * transcribing into the same place twice does not open a widening gap — the
   * same rule quick capture keeps when it appends a line.
   */
  const head = text.slice(0, at)
  const rest = text.slice(at).replace(/^\n+/, '')
  return rest ? `${head}\n\n${body}\n\n${rest}` : `${head}\n\n${body}\n`
}

/** Offset of the end of the line carrying the first embed of `target`. */
function embedLineEnd(text: string, opts: InsertOptions): number | undefined {
  const hits: number[] = []
  for (const w of scanWikiLinks(text))
    if (w.embed && opts.resolve(w.target) === opts.target) hits.push(w.from)
  for (const m of scanMdLinks(text))
    if (m.embed && opts.resolve(stripSize(m.url)) === opts.target) hits.push(m.from)
  if (!hits.length) return undefined

  const from = Math.min(...hits)
  const end = text.indexOf('\n', from)
  return end === -1 ? text.length : end
}

/** `photo.webp#w=400` is the same file as `photo.webp`. */
function stripSize(url: string): string {
  return url.replace(/#w=\d+$/, '')
}
