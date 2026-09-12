/**
 * The one piece of chrome a conversation needs.
 *
 * A strip under the editor, on notes whose frontmatter says `type: conversation`
 * and nowhere else. Everything above it is the ordinary editor showing an
 * ordinary note — which is the point: the conversation is a file, and this is
 * only the thing that appends to it.
 *
 * **The answer streams into the note, not into a bubble.** You watch the file
 * being written, and when it stops there is nothing to accept or dismiss: the
 * text is already in the note, saved by the same debounce as your own typing and
 * snapshotted into version history the same way. That is the one place this
 * feature departs from the rule the others keep — no diff, no confirmation —
 * and it earns it by being *append-only to a note that exists for this*. Nothing
 * you wrote is touched, and an answer you dislike is deleted like any paragraph.
 *
 * The editor is read-only while a turn runs. Two people typing into one document
 * is a merge problem, and one of them being a model streaming into the last line
 * is not worth solving.
 */

import { useEffect, useRef, useState } from 'preact/hooks'
import { signal } from '@preact/signals'
import { EditorView } from '@codemirror/view'
import { askTurn, searchesAnything } from '../app/ask'
import {
  dropLastTurn,
  lastTurn,
  noteScope,
  noteScopeRule,
  openTurn,
  pinsOf,
  provenanceCallout,
  sourceDescription,
  sourceLabel,
  sourceOf,
  withPins,
} from '../core/ask'
import { setFrontmatterKey } from '../core/markdown'
import { isConfigured } from '../core/llm'
import { settings } from '../core/settings'
import { resolveLink } from '../core/vault'
import { openMenu, type MenuItem } from './Menu'
import { openNotePicker } from './pickNote'
import { openPrompt } from './PromptDialog'
import { notify, scope, scopeLabel, scopeRule } from './state'
import { IconChevron, IconClose, IconSparkle } from './Icons'

/**
 * A question handed over by the starter dialog, waiting for the composer that
 * is about to mount on the note it just created.
 *
 * Carried by path as well as text, so a question meant for one conversation
 * cannot be asked of another — the note has to finish opening before the
 * composer exists, and in between the active note is still the old one.
 */
export const pendingQuestion = signal<{ path: string; question: string } | undefined>(undefined)

export interface ComposerProps {
  /** Read at send time: the view is rebuilt whenever the open note changes. */
  getView: () => EditorView | null
  /**
   * The note as the vault holds it.
   *
   * The chips are drawn from this rather than from the view, and that is not a
   * detail. A component re-renders because a signal it read changed; the
   * editor's document is neither, so a composer that read the buffer was right
   * only by luck of timing — reopen a conversation and the view is rebuilt in
   * an effect, after this has already drawn itself from whatever view was there
   * before, with nothing left to tell it otherwise. The symptom was a
   * conversation whose pins were in the file and not on the chip.
   */
  text: string
  /** The note this composer belongs to, so a handed-over question can be matched. */
  path: string
}

export function Composer({ getView, text, path }: ComposerProps) {
  const [question, setQuestion] = useState('')
  const [status, setStatus] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const abort = useRef<AbortController | null>(null)
  const box = useRef<HTMLTextAreaElement | null>(null)
  /** `send` is declared below; the handoff effect above needs to reach it. */
  const sendRef = useRef<((q?: string) => Promise<void>) | null>(null)
  const running = !!status

  useEffect(() => () => abort.current?.abort(), [])

  /*
   * The question the starter dialog asked for, once this composer exists on the
   * note it was meant for. Cleared first, so a failure does not re-ask it on
   * every re-render — and so closing the note mid-answer does not queue it up
   * again the next time the note is opened.
   */
  useEffect(() => {
    const handed = pendingQuestion.value
    if (!handed || handed.path !== path) return
    pendingQuestion.value = undefined
    // Passed rather than set into the box first: `send` reads the box from its
    // own render's closure, which would still be empty on the next frame.
    requestAnimationFrame(() => void sendRef.current?.(handed.question))
  }, [pendingQuestion.value, path])

  /*
   * The vault is a save behind the buffer, and a chip that takes half a second
   * to admit what you just told it reads as a control that did not work. So a
   * write puts its own result up immediately and hands back to the vault as
   * soon as the save lands — which is also what clears it, since `text`
   * changing is exactly the save arriving.
   */
  const [justWritten, setJustWritten] = useState<string | undefined>(undefined)
  useEffect(() => setJustWritten(undefined), [text, path])

  const doc = justWritten ?? text
  const source = sourceOf(doc)
  const pins = pinsOf(doc)
  const missingPins = pins.filter((t) => !resolveLink(t))
  const hasTurn = !!lastTurn(doc)
  /*
   * Whether a search runs at all. Scoped to one pinned note there is nothing
   * to search, so Redo — whose whole offer is "searching for something else" —
   * would be a control that cannot do the thing it names. The same test decides
   * it here and in the turn itself, so the chip and the request agree.
   */
  const searches = searchesAnything(source, pins, path)
  /* The standing line has to name the setting's value, not the old constant. */
  const limit = Math.max(1, settings.value.ai.notesPerQuestion || 6)

  /**
   * Change what the conversation is allowed to read.
   *
   * Written into the note's own frontmatter rather than held in component
   * state, because it is part of what the conversation *is* — a reader three
   * weeks later needs to know the answers came from `#work` and not from
   * everything — and because a file is a better place for it than a signal that
   * disappears when the note is closed.
   */
  const pickScope = (e: MouseEvent) => {
    const v = getView()
    if (!v) return
    const here = scopeRule(scope.value)
    const items: MenuItem[] = []

    /*
     * A conversation about a note gets its own two rungs before the vault, so
     * the ladder in the menu is the same one the starter offered: the note, the
     * note and its neighbours, everything. Which note that is comes from the
     * scope already in the file rather than from the first pin — the scope is
     * what "about" means here, and it survives unpinning and repinning.
     */
    const ns = noteScope(source)
    const about = ns?.title ?? pins[0]
    if (about) {
      items.push(
        {
          label: `${about} and the notes linked to it`,
          checked: ns?.kind === 'links',
          onSelect: () => setSource(v, noteScopeRule('links', about)),
        },
        {
          label: `${about} and nothing else`,
          checked: ns?.kind === 'note',
          onSelect: () => setSource(v, noteScopeRule('note', about)),
        },
      )
    }

    items.push({
      label: 'All notes',
      checked: source === 'all',
      separated: items.length > 0,
      onSelect: () => setSource(v, 'all'),
    })
    if (here && here !== source) {
      items.push({
        label: `The list you were on — ${scopeLabel(scope.value)}`,
        onSelect: () => setSource(v, here),
      })
    }
    openMenu(e, items, 'Answer from')
  }

  const setSource = (v: EditorView, next: string) => {
    const now = v.state.doc.toString()
    const updated = setFrontmatterKey(now, 'source', next)
    if (updated === now) return
    v.dispatch({
      changes: { from: 0, to: now.length, insert: updated },
      userEvent: 'input.ask.scope',
    })
    setJustWritten(updated)
  }

  /**
   * Notes this conversation sends whatever the question is.
   *
   * The scope chip next door says what may be *searched*; this says what is sent
   * without being searched for. Both end up in the note's frontmatter, because
   * both are part of what the conversation is rather than a setting somewhere
   * else — a reader three weeks later can see that every answer had the
   * migration plan in front of it.
   *
   * The menu is the whole editor for it: the pinned notes, each one click from
   * being unpinned, and one row that opens the picker. Nobody types a title.
   */
  const pinMenu = (e: MouseEvent) => {
    const v = getView()
    if (!v) return
    const items: MenuItem[] = pins.map((title) => ({
      label: missingPins.includes(title) ? `${title} — not found` : title,
      checked: !missingPins.includes(title),
      danger: missingPins.includes(title),
      onSelect: () => setPins(v, pins.filter((t) => t !== title)),
    }))
    items.push({
      label: 'Pin a note…',
      separated: items.length > 0,
      onSelect: () =>
        openNotePicker({
          title: 'Pin a note to this conversation',
          placeholder: 'Search your notes…',
          // The conversation cannot pin itself — it would read itself back and
          // grow more certain every turn — and a note already pinned is not a
          // choice.
          exclude: [path, ...pins.map((t) => resolveLink(t)).filter((p): p is string => !!p)],
          onPick: (entry) => {
            const live = getView()
            if (live) setPins(live, [...pins, entry.title])
          },
        }),
    })
    if (pins.length > 1) {
      items.push({
        label: 'Unpin all',
        danger: true,
        onSelect: () => setPins(v, []),
      })
    }
    openMenu(e, items, 'Always send')
  }

  const setPins = (v: EditorView, titles: string[]) => {
    const now = v.state.doc.toString()
    const updated = withPins(now, titles)
    if (updated === now) return
    v.dispatch({
      changes: { from: 0, to: now.length, insert: updated },
      userEvent: 'input.ask.pins',
    })
    setJustWritten(updated)
  }

  /**
   * Ask the last question again, searching for something else.
   *
   * The lever the provenance callout was always pointing at. It shows what was
   * searched for, so when an answer is wrong you can usually see that the
   * *search* was wrong — and until now that diagnosis was a dead end, because
   * the only way to act on it was to delete the answer by hand and rephrase the
   * question hoping for luckier terms. Asking the same model for terms again
   * would be the one thing that cannot help; these go straight to the index.
   *
   * The question and the old terms are read back out of the note rather than
   * kept in memory, so this works on a conversation opened fresh or synced from
   * another device — and honours an edit you made to the question meanwhile.
   */
  const redo = () => {
    const v = getView()
    if (!v || running) return
    const last = lastTurn(v.state.doc.toString())
    if (!last) {
      notify('Nothing to ask again yet', 'error')
      return
    }
    openPrompt({
      title: 'Search for something else',
      label: 'Search terms, separated by commas',
      value: last.terms.join(', '),
      placeholder: 'rollback, downtime',
      hint: `“${last.question}” is asked again, searching for these instead. The answer it gave is replaced.`,
      confirm: 'Ask again',
      onSubmit: (value) => {
        const terms = value
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
        if (!terms.length) return
        void send(last.question, { terms, replaceLast: true })
      },
    })
  }

  const stop = () => {
    abort.current?.abort()
    abort.current = null
    setStatus(undefined)
  }

  const send = async (override?: string, opts: { terms?: string[]; replaceLast?: boolean } = {}) => {
    const q = (override ?? question).trim()
    const v = getView()
    if (!q || !v || running) return
    if (!isConfigured(settings.value.ai)) {
      notify('Set up a provider in Settings → AI first', 'error')
      return
    }

    const controller = new AbortController()
    abort.current = controller
    setError(undefined)
    setStatus('Thinking…')
    setQuestion('')

    /*
     * The heading goes in first, and the answer streams underneath it. So a
     * question that fails still leaves the question in the note — which is
     * right: you asked it, the record should say so, and an empty heading is an
     * obvious invitation to press the button again rather than a silent nothing.
     */
    /*
     * A redo takes the old exchange out first, so the note ends up with one
     * answer to the question rather than two — and the same question heading is
     * written back, which keeps the file identical in shape to a fresh turn.
     */
    const before = opts.replaceLast ? dropLastTurn(v.state.doc.toString()) : v.state.doc.toString()
    const withHeading = openTurn(before, q)
    v.dispatch({
      changes: { from: 0, to: before.length, insert: withHeading },
      selection: { anchor: withHeading.length },
      scrollIntoView: true,
      userEvent: 'input.ask',
    })

    const base = withHeading
    let streamed = ''
    const paint = (text: string) => {
      const live = getView()
      if (!live || controller.signal.aborted) return
      const now = live.state.doc.toString()
      // Only ever rewrite the tail this turn owns. Anything else in the document
      // — a sync that landed, an edit in another window — is left alone.
      if (!now.startsWith(base)) return
      live.dispatch({
        changes: { from: base.length, to: now.length, insert: text },
        scrollIntoView: true,
        userEvent: 'input.ask',
      })
    }

    try {
      const { answer, provenance } = await askTurn(q, before, source, path, {
        terms: opts.terms,
        signal: controller.signal,
        onStatus: setStatus,
        onChunk: (c) => {
          streamed += c
          paint(streamed)
        },
      })
      paint(`${answer}\n\n${provenanceCallout(provenance)}\n`)
    } catch (e) {
      if (!controller.signal.aborted) {
        setError((e as Error).message)
        // Leave the question, take back the half-written answer: a paragraph
        // that stops mid-sentence reads as something you wrote and abandoned.
        paint('')
      }
    } finally {
      if (abort.current === controller) abort.current = null
      setStatus(undefined)
      requestAnimationFrame(() => box.current?.focus())
    }
  }

  sendRef.current = send

  /*
   * Pins count against the limit, so the line has to say so — the alternative
   * is somebody pinning four notes against a limit of four and never working
   * out why the search stopped mattering.
   */
  const footnote = pins.length
    ? `Up to ${limit} ${limit === 1 ? 'note' : 'notes'} a question — ${pins.length} pinned, the rest from ${sourceDescription(source)}.`
    : `Up to ${limit} ${limit === 1 ? 'note' : 'notes'} from ${sourceDescription(source)}, cited in the answer.`

  return (
    <div class="composer">
      {error && (
        <div class="composer-error" role="alert">
          <span>{error}</span>
          <button class="icon-btn" onClick={() => setError(undefined)} aria-label="Dismiss">
            <IconClose size={13} />
          </button>
        </div>
      )}

      {/*
        * One box: the question on its own row, and the controls that qualify it
        * on a row beneath. The two used to share a line, which put the field in
        * the middle of a row of chips and left the send button as a 40px square
        * at the end of it — so the thing you press most often was the smallest
        * target, and the thing you type into was the one that got squeezed
        * whenever a scope rule ran long.
        *
        * The border is on the box rather than the field, so the whole thing
        * lights up as one control when the caret is in it.
        */}
      <div class="composer-box">
        <textarea
          ref={box}
          class="composer-input"
          rows={2}
          placeholder={running ? '' : 'Ask about your notes…'}
          value={question}
          disabled={running}
          onInput={(e) => {
            const el = e.target as HTMLTextAreaElement
            setQuestion(el.value)
            // Grow with the question, up to a point — a long one should be
            // readable before it is sent, and the note still needs the screen.
            // CSS holds the floor, so a field emptied by a send does not
            // collapse to one line and take the box down with it.
            el.style.height = 'auto'
            el.style.height = `${Math.min(el.scrollHeight, 160)}px`
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />

        <div class="composer-controls">
          <button
            class="composer-scope"
            onClick={pickScope}
            disabled={running}
            title="What these answers may be drawn from"
          >
            <span>{sourceLabel(source)}</span>
            <IconChevron size={10} />
          </button>

          <button
            class="composer-scope"
            data-id="composer-pins"
            onClick={pinMenu}
            disabled={running}
            title="Notes sent with every question, whatever it is"
          >
            <span>
              {!pins.length
                ? 'Pin a note'
                : missingPins.length
                  ? `${pins.length} pinned, ${missingPins.length} missing`
                  : `${pins.length} pinned`}
            </span>
            <IconChevron size={10} />
          </button>

          {/*
            * Only once there is an exchange to redo, which is also the only time
            * it would mean anything — a conversation with no turns has no terms
            * to start from and no answer to replace, and one that searches
            * nothing has no other terms to offer.
            */}
          {hasTurn && searches && (
            <button
              class="composer-scope composer-redo"
              onClick={redo}
              disabled={running}
              title="Ask the last question again, searching for something else"
            >
              Redo
            </button>
          )}

          {/*
            * Takes whatever the chips leave, so it is the widest thing in the
            * row and reads as the default action — which it is, since Enter
            * does the same thing.
            */}
          {running ? (
            <button class="btn composer-send" onClick={stop}>
              Stop
            </button>
          ) : (
            <button
              class="btn btn-primary composer-send"
              disabled={!question.trim()}
              onClick={() => void send()}
              title="Ask (Enter)"
            >
              <IconSparkle size={15} />
              <span>Ask</span>
            </button>
          )}
        </div>
      </div>

      {/*
        * One line, and the title carries the whole of it: the status replaces
        * the standing explanation rather than pushing the note up a row every
        * time a turn starts, and a rule naming a long note title would
        * otherwise decide how tall the composer is.
        */}
      <div class="composer-foot" title={footnote}>
        {status ?? footnote}
      </div>
    </div>
  )
}
