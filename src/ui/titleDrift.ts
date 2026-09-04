/**
 * Offering to name a note after the heading you just typed in it.
 *
 * A note made with *New note here* is called `Untitled.md`, and a note started
 * from a template is `Untitled.md` with a heading waiting to be filled in.
 * Type "Kickoff with Acme" into that heading and the file is still Untitled —
 * so the note list, the wikilink you would write to it and the file on disk all
 * say Untitled, about a note that plainly is not.
 *
 * The offer is deliberately narrow. It is made **only for a note that has never
 * been named**, never for one whose title merely differs from its heading:
 * plenty of vaults keep `2026-09-04.md` headed `# Thursday` on purpose, and an
 * app that asked about that every time you paused would be a nuisance rather
 * than a help. And it is an offer — nothing renames a file in a synced vault
 * without being asked.
 */

import { firstHeading, parseFrontmatter } from '../core/markdown'
import { renameNote, UNTITLED } from '../core/vault'
import { safeSegment, titleFromPath } from '../core/util'
import { activePath, notify, openNote } from './state'

/** `Untitled`, and the `Untitled 2` that a second one gets. */
const UNNAMED = new RegExp(`^${UNTITLED}( \\d+)?$`)

/**
 * Notes already asked about, so a pause halfway through the next paragraph
 * does not ask again. Per session and per path, which is the right grain: the
 * question is only interesting the first time it becomes answerable.
 */
const asked = new Set<string>()

export function offerTitleFromHeading(path: string, text: string): void {
  if (asked.has(path)) return
  if (!UNNAMED.test(titleFromPath(path))) return

  const heading = firstHeading(text, parseFrontmatter(text).bodyStart)?.trim()
  if (!heading) return
  // A file name cannot hold everything a heading can; if nothing survives the
  // cleaning there is nothing to offer.
  const clean = safeSegment(heading)
  if (!clean || UNNAMED.test(clean)) return

  asked.add(path)
  notify(`Name this note “${clean}”?`, 'info', {
    label: 'Rename',
    run: () => {
      void renameNote(path, clean).then((next) => {
        // Follow it, but only if it is still the note being looked at — the
        // toast outlives the moment it was raised in.
        if (activePath.peek() === path) openNote(next)
        notify(`Renamed to “${titleFromPath(next)}”`)
      })
    },
  })
}
