/**
 * Wires the vault, the image encoder and the model together for one
 * transcription. The three halves are each testable on their own and this is
 * the seam that has to know about all of them, so it stays small.
 */

import { askAboutImage } from '../adapters/llm'
import { toWireImage } from '../core/images'
import { LlmError } from '../core/llm'
import { cleanTranscript, foundNothing, insertTranscript, TRANSCRIBE_PROMPT } from '../core/ocr'
import { isWriteProtected, parseFrontmatter } from '../core/markdown'
import { settings } from '../core/settings'
import { editNote, getRaw, resolveEmbed } from '../core/vault'

export interface Transcript {
  text: string
  /** True when the model reported the picture has no text in it. */
  empty: boolean
  /** What was actually sent, for the line that says so. */
  sent: { bytes: number; width: number; height: number }
}

/**
 * Read the text out of a vault attachment.
 *
 * Nothing is written here. The result goes to the review dialog, and only a
 * press of *Insert* reaches a file — which is the whole reason this returns a
 * string rather than taking a note path.
 */
export async function transcribeAttachment(path: string): Promise<Transcript> {
  const file = getRaw(path)
  if (!file?.blob)
    throw new LlmError('That image has not been downloaded to this device yet. Sync, then try again.')

  const image = await toWireImage(file.blob)
  const raw = await askAboutImage(settings.value.ai, image, TRANSCRIBE_PROMPT)
  const text = cleanTranscript(raw)
  return {
    text: foundNothing(text) ? '' : text,
    empty: foundNothing(text) || !text,
    sent: { bytes: image.bytes, width: image.width, height: image.height },
  }
}

/**
 * Write a transcription into `notePath`, after the picture it came from.
 *
 * Goes through `editNote` like any other edit, so it takes a version-history
 * snapshot and can be undone from the same place. A locked or imported note
 * refuses, the same as quick capture refuses one — a note marked `lock: true`
 * means it, and an AI feature is the last thing that should be the exception.
 */
export async function insertIntoNote(
  notePath: string,
  attachmentPath: string,
  transcript: string,
): Promise<void> {
  const note = getRaw(notePath)
  if (note?.text === undefined) throw new Error('That note is not available on this device.')
  /*
   * Worked out from the note as it is once its lock is held. The transcription
   * takes seconds to come back, and the note can be edited in that time — the
   * text read before it would have been written back over the edit.
   */
  let refused = false
  await editNote(notePath, (text) => {
    if (isWriteProtected(parseFrontmatter(text).data)) {
      refused = true
      return undefined
    }
    const next = insertTranscript(text, transcript, {
      target: attachmentPath,
      resolve: (ref) => resolveEmbed(ref, notePath),
    })
    return next === text ? undefined : next
  })
  if (refused) throw new Error('That note is read-only, so nothing was written to it.')
}
