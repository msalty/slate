/**
 * A lab bench for the related-notes scoring, over the vault you actually have.
 *
 * Not a feature, and deliberately hard to arrive at by accident: it is reached
 * by putting `?probe=related` in the address bar and by nothing else. No menu
 * item, no command, no setting — the scoring is not wired into the app and
 * this is how you decide whether it ever should be.
 *
 * It exists because the question "is this any good?" cannot be answered by a
 * test. The unit tests pin down what would make a good ranking impossible; the
 * script in `scripts/related.ts` asks the same question of a folder of
 * markdown. This asks it of the notes in front of you, which is the only
 * version of the question that counts.
 *
 * **The two controls are the ones worth having.** The evidence bar, because it
 * is the number that actually decides what is shown — drag it commoner and the
 * junk it keeps out appears. And the order: *weakest first* is the honest view,
 * because a heuristic is judged by the worst answer it accepts rather than the
 * best one it finds. Anybody can find the good ones.
 *
 * Lazily imported from `main.tsx`, so none of this — nor the scoring — is in
 * the bundle that a normal load fetches.
 */

import { useMemo, useState } from 'preact/hooks'
import { contentNotes } from '../core/vault'
import { EVIDENCE, relatedNotes, type RelatedNote } from '../core/related'
import type { NoteIndexEntry } from '../core/types'

interface Row {
  note: NoteIndexEntry
  hits: Array<RelatedNote<NoteIndexEntry>>
}

export function RelatedProbe() {
  const notes = contentNotes.value
  const [evidence, setEvidence] = useState(EVIDENCE)
  const [order, setOrder] = useState<'weakest' | 'strongest' | 'vault'>('weakest')
  const [q, setQ] = useState('')

  /*
   * Every note scored against every other. One pass over the vault builds the
   * index and the rest share it, so this is linear-ish rather than quadratic —
   * see `indexOf` in core/related.ts, which exists largely because of this
   * screen.
   */
  const rows = useMemo<Row[]>(
    () => notes.map((note) => ({ note, hits: relatedNotes(notes, note.path, { evidence }) })),
    [notes, evidence],
  )

  const answered = rows.filter((r) => r.hits.length > 0)
  const capped = rows.filter((r) => r.hits.length >= 8).length
  const median = (xs: number[]) =>
    xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase()
    const list = term
      ? rows.filter((r) => r.note.title.toLowerCase().includes(term))
      : answered
    if (order === 'vault') return list
    const dir = order === 'weakest' ? 1 : -1
    return [...list].sort((a, b) => dir * ((a.hits[0]?.score ?? 0) - (b.hits[0]?.score ?? 0)))
  }, [rows, answered, order, q])

  return (
    <div class="probe">
      <div class="probe-head">
        <h1>
          Related notes <small>a probe, not a feature</small>
        </h1>

        <div class="probe-stats">
          <Stat
            label="nothing related"
            value={`${Math.round(((rows.length - answered.length) / Math.max(1, rows.length)) * 100)}%`}
            note="most notes should land here"
          />
          <Stat
            label="hit the cap of 8"
            value={`${Math.round((capped / Math.max(1, rows.length)) * 100)}%`}
            note="a full list is usually padding"
          />
          <Stat label="median list" value={String(median(answered.map((r) => r.hits.length)))} note="1–3 reads well" />
          <Stat
            label="median top score"
            value={median(answered.map((r) => r.hits[0].score)).toFixed(2)}
            note={`evidence bar is ${evidence.toFixed(2)}`}
          />
          <Stat label="notes" value={String(rows.length)} note="in this vault" />
        </div>

        <div class="probe-controls">
          {/*
            * Shown as "one note in N", because that is literally what the
            * number is: every score here is `log(1 / the fraction of the vault
            * carrying this)`, so the bar is a statement about rarity and reads
            * far better as one than as 2.08.
            */}
          <label>
            <span>
              Counts as evidence at <strong>1 in {Math.round(Math.exp(evidence))}</strong>
            </span>
            <input
              type="range"
              min={Math.log(2)}
              max={Math.log(60)}
              step="0.01"
              value={evidence}
              onInput={(e) => setEvidence(Number((e.target as HTMLInputElement).value))}
            />
            <button class="probe-reset" onClick={() => setEvidence(EVIDENCE)}>
              reset
            </button>
          </label>
          <div class="seg" role="radiogroup" aria-label="Order">
            {(['weakest', 'strongest', 'vault'] as const).map((k) => (
              <button
                key={k}
                class="seg-btn"
                role="radio"
                aria-checked={order === k}
                onClick={() => setOrder(k)}
              >
                {k === 'weakest' ? 'Weakest first' : k === 'strongest' ? 'Strongest first' : 'Vault order'}
              </button>
            ))}
          </div>
          <input
            class="probe-find"
            type="search"
            placeholder="Find a note whose answer you already know…"
            value={q}
            onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          />
        </div>

        <p class="probe-hint">
          <strong>Weakest first</strong> is the view that decides this. The best answers are easy to
          find and prove nothing; what matters is whether the <em>worst thing still being shown</em>{' '}
          is defensible. If it is, the bar is right. If it is junk, drag the bar rarer until it
          stops being junk — and that number is the answer. A relation needs two things clearing
          that bar, or one thing at least two and a half times rarer standing on its own.
        </p>
      </div>

      <div class="probe-list">
        {shown.length === 0 && <div class="empty">Nothing to show.</div>}
        {shown.map((r) => (
          <div class="probe-note" key={r.note.path}>
            <div class="probe-title">
              {r.note.title}
              <small>
                {r.note.folder || '/'}
                {r.note.tags.length ? ` · ${r.note.tags.map((t) => `#${t}`).join(' ')}` : ''}
              </small>
            </div>
            {r.hits.length === 0 ? (
              <div class="probe-hit probe-none">nothing related</div>
            ) : (
              r.hits.map((h) => (
                <div class="probe-hit" key={h.note.path}>
                  <span class="probe-score">{h.score.toFixed(2)}</span>
                  <span class="probe-name">{h.note.title}</span>
                  <span class="probe-why">{h.why.join(', ')}</span>
                </div>
              ))
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div class="probe-stat">
      <div class="probe-stat-value">{value}</div>
      <div class="probe-stat-label">{label}</div>
      <div class="probe-stat-note">{note}</div>
    </div>
  )
}
