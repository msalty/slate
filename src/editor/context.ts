/** Editor-scoped context: which note is open, so embeds resolve relatively. */

import { Facet } from '@codemirror/state'

export interface NoteContext {
  path: string
}

export const noteContext = Facet.define<NoteContext, NoteContext>({
  combine: (v) => v[0] ?? { path: '' },
})

/** Ask the shell to open a note by wikilink target. */
export function requestOpenLink(target: string, exists: boolean) {
  dispatchEvent(new CustomEvent('slate:open-link', { detail: { target, exists } }))
}

/** Ask the shell to open the lightbox for a vault file. */
export function requestLightbox(path: string) {
  dispatchEvent(new CustomEvent('slate:lightbox', { detail: { path } }))
}
