/**
 * A Lezer inline parser for `[[wikilinks]]` and `![[embeds]]`.
 *
 * Teaching the markdown parser about them (rather than pattern-matching over
 * the text) means everything downstream — decorations, the live-preview mark
 * hiding, code-block exclusion — gets them right for free, including the awkward
 * cases like a wikilink inside a code fence, which must stay literal.
 */

import { type MarkdownConfig, type InlineContext } from '@lezer/markdown'
import { tags, Tag } from '@lezer/highlight'

export const wikiLinkTag = Tag.define(tags.link)
export const wikiEmbedTag = Tag.define(tags.link)

const OPEN = 91 // [
const BANG = 33 // !
const CLOSE = 93 // ]
const ESCAPE = 92 // \

function findClose(cx: InlineContext, from: number): number {
  const limit = Math.min(cx.end, from + 1024)
  for (let i = from; i < limit - 1; i++) {
    // A newline ends the candidate: wikilinks never span lines.
    if (cx.char(i) === 10) return -1
    /*
     * A backslash takes the next character with it, as `WIKI_INNER` in
     * core/wikilink.ts does — so a note called `A]` is `[[A\]]]`, and the
     * link closes at the last two brackets rather than one early. Everything
     * else in the editor reads the inside through that module; this is the one
     * place that has to find the end of it character by character.
     */
    if (cx.char(i) === ESCAPE) {
      if (cx.char(i + 1) === 10) return -1
      i++
      continue
    }
    if (cx.char(i) === CLOSE && cx.char(i + 1) === CLOSE) return i + 2
  }
  return -1
}

export const WikiLink: MarkdownConfig = {
  defineNodes: [
    { name: 'WikiLink', style: wikiLinkTag },
    { name: 'WikiEmbed', style: wikiEmbedTag },
    { name: 'WikiLinkMark', style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: 'WikiLink',
      // Must run before Link so `[[x]]` isn't consumed as a nested `[x]`.
      before: 'Link',
      parse(cx, next, pos) {
        const embed = next === BANG
        const start = embed ? pos + 1 : pos
        if (cx.char(start) !== OPEN || cx.char(start + 1) !== OPEN) return -1
        const end = findClose(cx, start + 2)
        if (end < 0) return -1
        // Reject an empty target: `[[]]` is not a link.
        if (end - start <= 4) return -1
        return cx.addElement(
          cx.elt(embed ? 'WikiEmbed' : 'WikiLink', pos, end, [
            cx.elt('WikiLinkMark', pos, start + 2),
            cx.elt('WikiLinkMark', end - 2, end),
          ]),
        )
      },
    },
  ],
}
