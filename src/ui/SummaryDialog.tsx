/**
 * Summarising whatever the note list is currently showing.
 *
 * **The list is the query.** Rather than a summarise button on a tag, on a Tag
 * Folder, on a folder and on a search — four places to build and four to keep
 * in step — this acts on the set of notes in front of you, however you narrowed
 * it. A tag, a saved rule, a folder, a search, a day on the calendar: they all
 * already produce a list, and "summarise these" means the ones you can see.
 *
 * **Nothing is sent until the count is on screen.** This is the first feature
 * that sends your writing rather than a picture, and possibly a great deal of
 * it, so the dialog opens on a statement of what would leave the device — how
 * many notes, roughly how many tokens, to which provider, in how many passes —
 * and a button that has to be pressed. The estimate is labelled as one.
 */

import { useEffect, useRef, useState } from 'preact/hooks'
import { signal } from '@preact/signals'
import { planFor, runSummary, writeSummaryNote } from '../app/summarise'
import { isConfigured, modelFor, presetFor } from '../core/llm'
import { MAX_BATCHES, type Plan } from '../core/summary'
import { settings } from '../core/settings'
import type { NoteIndexEntry } from '../core/types'
import { notify, openNote, scopeLabel, scope, visibleNotes } from './state'
import { IconClose } from './Icons'

interface Target {
  what: string
  notes: NoteIndexEntry[]
}

const target = signal<Target | undefined>(undefined)

/**
 * Is there anywhere to send a summary?
 *
 * Configuration only — deliberately not "and the list is non-empty". Whether
 * the command is *offered* should depend on something stable, not on what the
 * list happens to hold this second: the palette builds its command list from a
 * memo, and a gate that reads a signal the memo does not depend on produces an
 * entry that is right when it was last rebuilt and wrong now. An empty list is
 * handled where it is actually known, by `openSummary` below, which says so.
 */
export function canSummarise(): boolean {
  return isConfigured(settings.value.ai)
}

export function openSummary() {
  const notes = visibleNotes.value
  if (!notes.length) {
    notify('There are no notes in this list to summarise', 'error')
    return
  }
  target.value = { what: scopeLabel(scope.value), notes }
}

export function SummaryDialog() {
  const t = target.value
  const [plan, setPlan] = useState<Plan | undefined>()
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number }>()
  const [out, setOut] = useState('')
  const [error, setError] = useState<string | undefined>()
  const abort = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!t) return
    setPlan(planFor(t.notes))
    setOut('')
    setError(undefined)
    setProgress(undefined)
    setRunning(false)
    return () => abort.current?.abort()
  }, [t])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        abort.current?.abort()
        target.value = undefined
      }
    }
    if (t) addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [t])

  if (!t || !plan) return null

  const ai = settings.value.ai
  const provider = presetFor(ai.provider)?.label ?? 'your provider'
  const sending = plan.batches.flat().length
  const tooBig = plan.batches.length > MAX_BATCHES

  const close = () => {
    abort.current?.abort()
    abort.current = null
    target.value = undefined
  }

  const go = async () => {
    setRunning(true)
    setError(undefined)
    setOut('')
    const controller = new AbortController()
    abort.current = controller
    try {
      let acc = ''
      const body = await runSummary(t.what, plan, {
        signal: controller.signal,
        onProgress: (done, total) => setProgress({ done, total }),
        onChunk: (c) => {
          acc += c
          setOut(acc)
        },
      })
      const path = await writeSummaryNote(t.what, body, sending)
      close()
      openNote(path)
      notify(`Summary of ${t.what} written from ${sending} ${sending === 1 ? 'note' : 'notes'}`)
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message)
      setRunning(false)
    } finally {
      if (abort.current === controller) abort.current = null
    }
  }

  return (
    <div class="scrim" onClick={close}>
      <div
        class="dialog"
        style={{ width: 'min(640px, 100%)' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Summarise notes"
      >
        <div class="dialog-head">
          <h2>Summarise {t.what}</h2>
          <span style={{ flex: 1 }} />
          <button class="icon-btn" onClick={close} aria-label="Close">
            <IconClose />
          </button>
        </div>

        <div class="dialog-body">
          {!running && !error && (
            <>
              <div class="summary-figures">
                <Figure n={sending} label={sending === 1 ? 'note' : 'notes'} />
                <Figure n={`~${short(plan.tokens)}`} label="tokens, estimated" />
                <Figure
                  n={plan.batches.length}
                  label={plan.batches.length === 1 ? 'request' : 'requests'}
                />
              </div>

              <p class="summary-says">
                The full text of {sending === 1 ? 'this note' : `these ${sending} notes`} will be
                sent to <strong>{provider}</strong> and read by{' '}
                <strong>{modelFor(ai, 'text')}</strong>. The result is written as a new note you can
                edit or delete; nothing already in your vault is changed.
              </p>

              {plan.batches.length > 1 && !tooBig && (
                <div class="callout">
                  This is more than one request's worth, so it goes in {plan.batches.length} passes
                  and a final one that merges them. Every note is covered — nothing is dropped to
                  make it fit. If that is more than you want to send, narrow the list first.
                </div>
              )}

              {plan.skipped.length > 0 && (
                <div class="callout">
                  {plan.skipped.length} empty {plan.skipped.length === 1 ? 'note is' : 'notes are'}{' '}
                  being left out.
                </div>
              )}

              {plan.truncated && (
                <div class="callout">
                  One note is longer than a single request can hold and will be cut short. Raise{' '}
                  <em>Context budget</em> in Settings → AI if your model can take more.
                </div>
              )}

              {tooBig && (
                <div class="callout callout-danger">
                  This would take {plan.batches.length} requests, past the limit of {MAX_BATCHES}.
                  Narrow the list — a tag, a folder, or a search — and try again. A summary distilled
                  from that many passes is thinner than one of a set you actually meant.
                </div>
              )}
            </>
          )}

          {running && (
            <>
              <p class="transcribe-status">
                {progress && progress.total > 1
                  ? `Pass ${progress.done + 1} of ${progress.total}…`
                  : 'Reading the notes…'}
              </p>
              {out && <pre class="transform-stream">{out}</pre>}
            </>
          )}

          {error && (
            <div class="callout callout-danger" style={{ whiteSpace: 'pre-wrap' }}>
              {error}
            </div>
          )}
        </div>

        <div class="dialog-foot">
          <span style={{ flex: 1 }} />
          <button class="btn" onClick={close}>
            Cancel
          </button>
          <button class="btn btn-primary" disabled={running || tooBig} onClick={() => void go()}>
            {running ? 'Working…' : `Send ${sending} ${sending === 1 ? 'note' : 'notes'}`}
          </button>
        </div>
      </div>
    </div>
  )
}

function Figure({ n, label }: { n: number | string; label: string }) {
  return (
    <div class="summary-figure">
      <span class="summary-figure-n">{n}</span>
      <span class="summary-figure-label">{label}</span>
    </div>
  )
}

/** 18400 → "18k". The exact number is noise at this size. */
function short(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}
