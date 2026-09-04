/**
 * Hand a note to the rest of the machine, as the markdown it already is.
 *
 * There is nothing to convert. The buffer, the file on disk and the thing that
 * leaves here are the same bytes — frontmatter, wikilinks and all — which is
 * the whole reason this is twenty lines rather than a renderer. A note exported
 * from Slate opens in Obsidian, in vim, or in the next notes app.
 *
 * Two ways out, and the device decides which:
 *
 *   - **The share sheet**, where the platform has one. On a phone that is the
 *     way to reach Mail, Messages, Files and everything else in one gesture,
 *     and it is the only one of the two that can put a note into an email.
 *   - **A download**, everywhere else. `<a download>` is unglamorous and works
 *     in every desktop browser without a permission prompt.
 */

import { basename, titleFromPath } from '../core/util'
import { getRaw } from '../core/vault'
import { notify } from './state'

const MARKDOWN = 'text/markdown'

/** A note as a file, or undefined when the path is not a note. */
function noteFile(path: string): File | undefined {
  const f = getRaw(path)
  if (!f || f.kind !== 'note') return undefined
  return new File([f.text ?? ''], basename(path), { type: MARKDOWN })
}

/**
 * Whether this device would open a share sheet, so a menu can say which of the
 * two things its item is about to do.
 *
 * `canShare` has to be asked with a file, not just checked for existence:
 * desktop Chrome has the method and refuses files, and answering "share" there
 * would promise a sheet that never appears.
 */
export function canShareFiles(): boolean {
  if (typeof navigator === 'undefined' || !navigator.canShare) return false
  try {
    return navigator.canShare({ files: [new File([''], 'note.md', { type: MARKDOWN })] })
  } catch {
    return false
  }
}

export async function shareNote(path: string): Promise<void> {
  const file = noteFile(path)
  if (!file) return

  /*
   * Called with no `await` in front of it, and that is load-bearing: both of
   * these need the user gesture that opened the menu still to be in progress,
   * and anything awaited first would end it.
   */
  if (canShareFiles()) {
    try {
      await navigator.share({ files: [file], title: titleFromPath(path) })
      return
    } catch (e) {
      // Dismissing the sheet is a decision, not a failure — nothing to fall
      // back to. Anything else means the sheet never worked, so download.
      if ((e as Error).name === 'AbortError') return
    }
  }

  download(file)
  notify(`Exported ${file.name}`)
}

function download(file: File) {
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  /*
   * Revoked late rather than straight away. The download is started by the
   * click but not necessarily finished by the time this line runs, and
   * revoking a blob URL out from under an in-flight save cancels it.
   */
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
