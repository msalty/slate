/**
 * Rewriting a selection, with the change shown before it is made.
 *
 * The diff is the feature. A model that returns a good rewrite and one that
 * quietly drops the third sentence produce replies that look equally plausible
 * read on their own, and the only way to tell them apart is against what was
 * there — so the answer is never shown on its own. Accept applies exactly what
 * is in the diff; Cancel writes nothing.
 *
 * Streaming is here for a reason beyond looking busy: a local model can take a
 * minute on a long paragraph, and a dialog that shows nothing for a minute is
 * one people close and never open again.
 */

import { useEffect, useRef, useState } from 'preact/hooks'
import { signal } from '@preact/signals'
import { streamText } from '../adapters/llm'
import { diffLines, type DiffLine } from '../core/merge'
import { isConfigured } from '../core/llm'
import { settings } from '../core/settings'
import {
  cleanTransformed,
  stillMatches,
  transformSystem,
  transformUser,
  TRANSFORMS,
  verdict,
} from '../core/transform'
import { activeEditor } from '../editor/context'
import { notify } from './state'
import { IconClose } from './Icons'

interface Target {
  from: number
  to: number
  /** The text as it stood when the dialog opened, and what is sent. */
  text: string
}

const target = signal<Target | undefined>(undefined)

/**
 * Open the dialog on whatever is selected, if anything is.
 *
 * Refusing an empty selection here rather than offering to transform the whole
 * note: "rewrite this note" is a different and much less safe feature than
 * "rewrite this paragraph", and quietly promoting one to the other because
 * nothing was selected is how somebody loses a note.
 */
export function openTransform(): boolean {
  const view = activeEditor.value
  if (!view) {
    notify('Open a note first', 'error')
    return false
  }
  const { from, to } = view.state.selection.main
  if (from === to) {
    notify('Select the text you want to change first', 'error')
    return false
  }
  target.value = { from, to, text: view.state.sliceDoc(from, to) }
  return true
}

/** Is the command worth offering at all? */
export function canTransform(): boolean {
  return isConfigured(settings.value.ai)
}

export function TransformDialog() {
  const t = target.value
  const [instruction, setInstruction] = useState('')
  const [preset, setPreset] = useState<string | undefined>()
  const [out, setOut] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [done, setDone] = useState(false)
  const abort = useRef<AbortController | null>(null)

  useEffect(() => {
    if (t) {
      setInstruction('')
      setPreset(undefined)
      setOut('')
      setError(undefined)
      setDone(false)
      setBusy(false)
    }
    return () => abort.current?.abort()
  }, [t?.from, t?.to])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    if (t) addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [t])

  if (!t) return null

  const close = () => {
    abort.current?.abort()
    abort.current = null
    target.value = undefined
    // The note was never unfocused as far as the person is concerned.
    activeEditor.value?.focus()
  }

  const run = async (task: string, presetId?: string) => {
    if (!task.trim()) return
    setPreset(presetId)
    setBusy(true)
    setDone(false)
    setError(undefined)
    setOut('')
    const controller = new AbortController()
    abort.current = controller
    try {
      let acc = ''
      await streamText(settings.value.ai, transformSystem(task), transformUser(t.text), {
        signal: controller.signal,
        onChunk: (c) => {
          acc += c
          setOut(acc)
        },
      })
      setOut(cleanTransformed(acc))
      setDone(true)
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message)
    } finally {
      if (abort.current === controller) abort.current = null
      setBusy(false)
    }
  }

  /**
   * Put the rewrite in the buffer — but only over the words it was made from.
   *
   * A sync pull can land while this dialog is open, and the editor folds the
   * incoming version into the buffer underneath it. The offsets would then
   * point somewhere else entirely, so the text at the range is checked against
   * what was sent before anything is written.
   */
  const accept = () => {
    const view = activeEditor.value
    if (!view) {
      notify('The note was closed, so nothing was changed', 'error')
      close()
      return
    }
    if (!stillMatches(view.state.doc.toString(), t.from, t.to, t.text)) {
      notify('The note changed while this was open, so nothing was written', 'error')
      close()
      return
    }
    view.dispatch({
      changes: { from: t.from, to: t.to, insert: out },
      selection: { anchor: t.from, head: t.from + out.length },
      scrollIntoView: true,
      userEvent: 'input.transform',
    })
    close()
    notify('Rewrite applied — ⌘Z puts it back')
  }

  const state = done ? verdict(t.text, out) : 'ok'
  const lines = done && state === 'ok' ? diffLines(t.text, out) : []

  return (
    <div class="scrim" onClick={close}>
      <div
        class="dialog"
        style={{ width: 'min(720px, 100%)' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Transform selection"
      >
        <div class="dialog-head">
          <h2>Change this passage</h2>
          <span style={{ flex: 1 }} />
          <button class="icon-btn" onClick={close} aria-label="Close">
            <IconClose />
          </button>
        </div>

        <div class="dialog-body">
          <div class="transform-presets">
            {TRANSFORMS.map((p) => (
              <button
                key={p.id}
                class="btn transform-preset"
                aria-pressed={preset === p.id}
                disabled={busy}
                title={p.hint}
                onClick={() => void run(p.instruction, p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>

          <label class="field">
            <span>Or say what to do with it</span>
            <input
              type="text"
              placeholder="Rewrite this as a note to the team"
              value={instruction}
              disabled={busy}
              onInput={(e) => setInstruction((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === 'Enter' && void run(instruction)}
            />
          </label>

          {busy && (
            <>
              <p class="transcribe-status">Writing…</p>
              {out && <pre class="transform-stream">{out}</pre>}
            </>
          )}

          {error && (
            <div class="callout callout-danger" style={{ whiteSpace: 'pre-wrap' }}>
              {error}
            </div>
          )}

          {done && state === 'empty' && (
            <div class="callout callout-danger">
              The model returned nothing, so there is no change to make.
            </div>
          )}
          {done && state === 'unchanged' && (
            <div class="callout">
              The model returned the passage unchanged — by its reading there was nothing to do.
            </div>
          )}

          {done && state === 'ok' && (
            <div class="diff" role="group" aria-label="Proposed change">
              {lines.map((l, i) => (
                <DiffRow key={i} line={l} />
              ))}
            </div>
          )}
        </div>

        <div class="dialog-foot">
          <span style={{ flex: 1 }} />
          <button class="btn" onClick={close}>
            {done && state === 'ok' ? 'Discard' : 'Cancel'}
          </button>
          <button class="btn btn-primary" disabled={!done || state !== 'ok'} onClick={accept}>
            Replace the passage
          </button>
        </div>
      </div>
    </div>
  )
}

function DiffRow({ line }: { line: DiffLine }) {
  const mark = line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '
  return (
    <div class="diff-line" data-kind={line.kind}>
      <span class="diff-mark" aria-hidden="true">
        {mark}
      </span>
      {/* A blank line still needs a row, or a diff of paragraphs collapses. */}
      <span class="diff-text">{line.text || ' '}</span>
    </div>
  )
}
