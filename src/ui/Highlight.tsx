/**
 * The searched-for words, marked where they appear.
 *
 * A list of results whose rows look exactly like every other row makes you
 * read each one to work out why it is there — particularly when the match is
 * in the body rather than the title, which is most of the time. Marking the
 * words answers that at a glance, and it is the only reason the row bothers to
 * show a snippet instead of the note's opening line.
 *
 * Colour alone, no highlighter block: a row can carry several marks and a
 * band of background across a 12px line is louder than the text it is trying
 * to help you read.
 */

import { matchRanges } from '../core/util'

export function Highlight({ text, terms }: { text: string; terms: string[] }) {
  const ranges = matchRanges(text, terms)
  if (!ranges.length) return <>{text}</>

  const out: preact.ComponentChildren[] = []
  let at = 0
  for (const [i, r] of ranges.entries()) {
    if (r.from > at) out.push(text.slice(at, r.from))
    out.push(
      <mark key={i} class="hit">
        {text.slice(r.from, r.to)}
      </mark>,
    )
    at = r.to
  }
  if (at < text.length) out.push(text.slice(at))
  return <>{out}</>
}
