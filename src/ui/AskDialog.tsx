/**
 * Starting a conversation: one question, and what it is allowed to read.
 *
 * A dialog rather than creating an empty note and dropping you in it, for one
 * reason: **the first question is what the file is named after**, and a note
 * called "Ask — untitled" is a note nobody finds again. Asking for it up front
 * also puts the scope on screen at the moment it is chosen, rather than leaving
 * it as a thing to discover in the frontmatter later.
 *
 * Nothing is sent from here. The dialog writes the note and opens it; the
 * composer at the bottom of that note asks the question — so the first turn runs
 * through exactly the same path as every one after it.
 */

import { useEffect, useRef, useState } from 'preact/hooks'
import { signal } from '@preact/signals'
import { canAsk, startConversation } from '../app/ask'
import { ALL, noteScopeRule, sourceDescription } from '../core/ask'
import { settings } from '../core/settings'
import { notify, openNote, scope, scopeLabel, scopeRule, visibleNotes } from './state'
import { pendingQuestion } from './Composer'
import { IconClose } from './Icons'

interface Draft {
  /** The rule the conversation starts scoped to. */
  source: string
  /** What that rule was called on screen when it was chosen. */
  label: string
  /** How many notes it covers right now, for the line under the field. */
  count: number
  /** A note the conversation starts pinned to — what "ask about this note" sets. */
  pin?: string
}

const draft = signal<Draft | undefined>(undefined)

export { canAsk }

/**
 * Open the starter, scoped to the list you are looking at.
 *
 * A day, the task list, the files browser and the trash have no rule that means
 * the same thing, so they start from the whole vault — and the dialog says so
 * rather than implying a narrower conversation than it is about to have.
 */
export function openAsk(opts: { pin?: string } = {}) {
  const rule = scopeRule(scope.value)
  /*
   * Asking *about* a note starts scoped to that note's own neighbourhood, not
   * to the whole vault and not to whichever list you were standing on. The
   * first version answered from everything, and it read as a bug: you name a
   * note, and back comes an answer citing four others that merely shared a
   * word with your question. What is nearby in the graph is what the note is
   * actually connected to — and "and nothing else" is one option along.
   */
  const about = !!opts.pin
  draft.value = {
    source: about ? noteScopeRule('links', opts.pin!) : (rule ?? ALL),
    label: !about && rule ? scopeLabel(scope.value) : 'All notes',
    count: !about && rule ? visibleNotes.value.length : 0,
    pin: opts.pin,
  }
}

/**
 * Start a conversation about the note you are looking at.
 *
 * The entry point this feature was missing. Both ways in were list-shaped —
 * the note list's ⋯ and the palette — so the most obvious thing to want, a
 * question about the note on screen, was the one thing you could not ask
 * without first going somewhere else and describing it.
 *
 * It still goes through the dialog rather than starting straight away, because
 * the first question is what the conversation is named after and that is worth
 * being asked for.
 */
export function askAboutNote(title: string) {
  openAsk({ pin: title })
}

export function AskDialog() {
  const d = draft.value
  const [question, setQuestion] = useState('')
  const [source, setSource] = useState(ALL)
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (!d) return
    setQuestion('')
    setSource(d.source)
    setBusy(false)
    requestAnimationFrame(() => box.current?.focus())
  }, [d])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        draft.value = undefined
      }
    }
    if (d) addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [d])

  if (!d) return null

  const close = () => (draft.value = undefined)

  const go = async () => {
    const q = question.trim()
    if (!q || busy) return
    setBusy(true)
    try {
      const path = await startConversation(source, q, d.pin ? [d.pin] : [])
      close()
      openNote(path)
      /*
       * Handed to the composer rather than asked here, so the first turn is the
       * same code as the twentieth. It picks this up when it mounts.
       */
      pendingQuestion.value = { path, question: q }
    } catch (e) {
      notify((e as Error).message, 'error')
      setBusy(false)
    }
  }

  const folder = settings.value.generatedFolder
  const scoped = source !== ALL
  const onlyTheNote = !!d.pin && source === noteScopeRule('note', d.pin)

  return (
    <div class="scrim" onClick={close}>
      <div
        class="dialog"
        style={{ width: 'min(560px, 100%)' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Ask your notes"
      >
        <div class="dialog-head">
          <h2>{d.pin ? `Ask about “${d.pin}”` : 'Ask your notes'}</h2>
          <span style={{ flex: 1 }} />
          <button class="icon-btn" onClick={close} aria-label="Close">
            <IconClose />
          </button>
        </div>

        <div class="dialog-body">
          <label class="field">
            <span>What do you want to know?</span>
            <textarea
              ref={box}
              class="ask-question"
              rows={3}
              placeholder="What did we decide about the Q3 migration?"
              value={question}
              disabled={busy}
              onInput={(e) => setQuestion((e.target as HTMLTextAreaElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void go()
                }
              }}
            />
            <small>This becomes the conversation's name, so it is worth being specific.</small>
          </label>

          <label class="field">
            <span>Answer from</span>
            <select
              value={source}
              disabled={busy}
              onChange={(e) => setSource((e.target as HTMLSelectElement).value)}
            >
              {/*
                * Asking about a note offers that note's own neighbourhood
                * before it offers the vault — widening is a choice you make,
                * not the starting point.
                */}
              {d.pin ? (
                <>
                  <option value={noteScopeRule('links', d.pin)}>
                    This note and the notes linked to it
                  </option>
                  <option value={noteScopeRule('note', d.pin)}>This note and nothing else</option>
                </>
              ) : (
                d.source !== ALL && (
                  <option value={d.source}>
                    {d.label} — {d.count} {d.count === 1 ? 'note' : 'notes'}
                  </option>
                )
              )}
              <option value={ALL}>All notes</option>
            </select>
            <small>
              {scoped
                ? `Kept in the note as a rule (${source}), re-read on every question — so you can change it later by editing the note.`
                : 'A narrower scope gives a small local model a much better chance of finding the right notes.'}
            </small>
          </label>

          <div class="callout">
            {d.pin && (
              <>
                <strong>{d.pin}</strong> is pinned to the conversation, so every question has it in
                front of it{onlyTheNote ? ' — and nothing else is searched at all' : ''}. Both the
                pin and the scope can be changed from the composer later.{' '}
              </>
            )}
            Each question searches {sourceDescription(source)} and sends up to{' '}
            {settings.value.ai.notesPerQuestion} notes to your provider. The conversation is an ordinary note in{' '}
            <code>{folder || 'the vault root'}</code>, and every answer records what it read.
          </div>
        </div>

        <div class="dialog-foot">
          <span style={{ flex: 1 }} />
          <button class="btn" onClick={close}>
            Cancel
          </button>
          <button class="btn btn-primary" disabled={!question.trim() || busy} onClick={() => void go()}>
            {busy ? 'Starting…' : 'Start'}
          </button>
        </div>
      </div>
    </div>
  )
}
