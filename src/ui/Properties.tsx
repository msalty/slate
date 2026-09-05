/**
 * The note's frontmatter, as a form.
 *
 * Rich text hides the `---` block (see editor/livePreview.ts) and opens this
 * over it instead, from the date under the title. A key and a value are a form,
 * not prose: typing them into the top of the buffer means getting YAML right by
 * hand — the quoting, the two spaces before a list item, the fences — in the
 * one mode of the app that exists so nobody has to think about markup.
 *
 * Nothing here is required. Frontmatter is optional in a markdown file and
 * optional here: a note without any opens this panel empty, and the block is
 * only written once a property is actually named. Delete the last one and the
 * block goes with it, leaving the file the way it started.
 *
 * The file stays the truth. Every edit rewrites one entry and hands the whole
 * text back to the editor, so what the panel does is exactly what somebody
 * could have typed in source mode — and a property this form has no opinion
 * about survives it untouched.
 */

import { useEffect, useRef, useState } from 'preact/hooks'
import type { EditorView } from '@codemirror/view'
import {
  addProperty,
  coerceValue,
  hasProperty,
  readProperties,
  removeProperty,
  renameProperty,
  sanitizeKey,
  setPropertyValue,
  splitList,
  type Property,
  type PropertyKind,
} from '../core/properties'
import { setDoc } from '../editor/setup'
import { saveNote } from '../core/vault'
import { syncSoon } from '../core/sync'
import { notify } from './state'
import { openMenu } from './Menu'
import { IconCalendar, IconCheckbox, IconClose, IconHash, IconListBullet, IconPlus, IconText } from './Icons'

const KINDS: Array<{ id: PropertyKind; label: string }> = [
  { id: 'text', label: 'Text' },
  { id: 'list', label: 'List' },
  { id: 'number', label: 'Number' },
  { id: 'date', label: 'Date' },
  { id: 'checkbox', label: 'Checkbox' },
]

function kindLabel(kind: PropertyKind): string {
  return KINDS.find((k) => k.id === kind)?.label ?? 'Text'
}

function KindIcon({ kind }: { kind: PropertyKind }) {
  switch (kind) {
    case 'list':
      return <IconListBullet size={14} />
    case 'number':
      return <IconHash size={14} />
    case 'date':
      return <IconCalendar size={14} />
    case 'checkbox':
      return <IconCheckbox size={14} />
    default:
      return <IconText size={14} />
  }
}

interface PanelProps {
  path: string
  /**
   * The note as it is *this instant*, read from the buffer rather than from the
   * vault: the editor saves on a delay, and a panel working from the saved copy
   * would write a property into a version of the note that is 400ms old and
   * take a sentence back out with it.
   */
  getText: () => string
  getView: () => EditorView | null
}

export function Properties({ path, getText, getView }: PanelProps) {
  /*
   * Writing into the buffer is not something Preact hears about, so the panel
   * re-renders itself after each edit. Everything shown is derived from the
   * text; this is only the nudge to go and read it again.
   */
  const [, bump] = useState(0)
  const [adding, setAdding] = useState(false)
  /** A property just named, whose value field should get the caret. */
  const [pending, setPending] = useState<string | null>(null)
  const props = readProperties(getText())

  const write = (next: string) => {
    if (next === getText()) return
    const view = getView()
    if (view) setDoc(view, next, path)
    else void saveNote(path, next).then(() => syncSoon())
    bump((n) => n + 1)
  }

  /** Names the drafted property, or says why it could not be named. */
  const add = (key: string): boolean => {
    const k = sanitizeKey(key)
    if (!k) {
      setAdding(false)
      return true
    }
    if (hasProperty(getText(), k)) {
      notify(`This note already has a property called ${k}`, 'error')
      return false
    }
    write(addProperty(getText(), k, ''))
    setAdding(false)
    // Named, so the caret moves on to the thing it is worth: the value.
    setPending(k)
    return true
  }

  return (
    <div class="properties">
      <div class="properties-inner">
        {props.length === 0 && !adding && (
          <p class="properties-empty">
            No properties yet — they are optional. Add one to file this note by
            date, tag or anything else you like.
          </p>
        )}

        {props.map((p) => (
          <PropertyRow
            key={p.key}
            p={p}
            getText={getText}
            write={write}
            focusValue={pending === p.key}
            onFocused={() => setPending(null)}
          />
        ))}

        {adding && <NewRow onCommit={add} onCancel={() => setAdding(false)} />}

        <button class="property-add" onClick={() => setAdding(true)} disabled={adding}>
          <IconPlus size={14} />
          Add property
        </button>
      </div>
    </div>
  )
}

function PropertyRow({
  p,
  getText,
  write,
  focusValue,
  onFocused,
}: {
  p: Property
  getText: () => string
  write: (next: string) => void
  focusValue: boolean
  onFocused: () => void
}) {
  /*
   * What is in the two fields while they are being typed into.
   *
   * The panel re-reads the file after every keystroke, and the file's idea of
   * the value is tidied — a list comes back as "a, b" however it was typed. Put
   * that back into a focused input and the caret jumps to the end mid-word. So
   * a field being edited shows what was typed, and snaps to the file's version
   * when it is left.
   */
  const [draft, setDraft] = useState<string | null>(null)
  const [keyDraft, setKeyDraft] = useState<string | null>(null)
  const valueRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!focusValue) return
    valueRef.current?.focus()
    onFocused()
  }, [focusValue])

  const setValue = (v: string) => {
    setDraft(v)
    write(setPropertyValue(getText(), p.key, p.kind === 'list' ? splitList(v) : v))
  }

  /*
   * A rename lands when the field is left, not as it is typed: a key rewritten
   * on every keystroke would put `t:`, `ti:`, `tit:` through the file on the
   * way to `title:`. Escape drops it — and has to say so through a ref, since
   * the blur it causes runs before the state it sets has been applied.
   */
  const abandoned = useRef(false)

  const commitKey = () => {
    const typed = keyDraft
    setKeyDraft(null)
    if (typed === null || abandoned.current) {
      abandoned.current = false
      return
    }
    const k = sanitizeKey(typed)
    if (!k || k === p.key) return
    const next = renameProperty(getText(), p.key, k)
    if (next === getText()) {
      notify(`This note already has a property called ${k}`, 'error')
      return
    }
    write(next)
  }

  const shown = draft ?? p.value

  return (
    <div class="property-row">
      <button
        class="property-kind"
        title={`${kindLabel(p.kind)} — change what kind of value this is`}
        aria-label={`${p.key}: ${kindLabel(p.kind)}`}
        onClick={(e) =>
          openMenu(
            e,
            KINDS.map((k) => ({
              label: k.label,
              checked: k.id === p.kind,
              onSelect: () => write(setPropertyValue(getText(), p.key, coerceValue(p, k.id))),
            })),
            p.key,
          )
        }
      >
        <KindIcon kind={p.kind} />
      </button>

      <input
        class="property-key"
        value={keyDraft ?? p.key}
        aria-label="Property name"
        spellcheck={false}
        onInput={(e) => setKeyDraft(e.currentTarget.value)}
        onBlur={commitKey}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            abandoned.current = true
            e.currentTarget.blur()
          }
        }}
      />

      {p.kind === 'checkbox' ? (
        <label class="property-check">
          <input
            ref={valueRef}
            type="checkbox"
            checked={p.value === 'true'}
            onChange={(e) =>
              write(setPropertyValue(getText(), p.key, e.currentTarget.checked ? 'true' : 'false'))
            }
          />
          <span>{p.value === 'true' ? 'Yes' : 'No'}</span>
        </label>
      ) : (
        <input
          ref={valueRef}
          class="property-value"
          type={p.kind === 'date' ? 'date' : 'text'}
          inputMode={p.kind === 'number' ? 'decimal' : undefined}
          value={shown}
          aria-label={`${p.key} value`}
          placeholder={p.kind === 'list' ? 'one, two, three' : 'Empty'}
          onInput={(e) => setValue(e.currentTarget.value)}
          onBlur={() => setDraft(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
          }}
        />
      )}

      <button
        class="property-remove"
        aria-label={`Remove ${p.key}`}
        title={`Remove ${p.key}`}
        onClick={() => write(removeProperty(getText(), p.key))}
      >
        <IconClose size={14} />
      </button>
    </div>
  )
}

/**
 * The row for a property that does not exist yet.
 *
 * Only a name is asked for, and nothing is written until one is given: a row
 * abandoned half-typed leaves no trace in the file, which is the difference
 * between an optional block and one that fills up with `property-3:` every time
 * somebody clicks the wrong button.
 */
function NewRow({
  onCommit,
  onCancel,
}: {
  onCommit: (key: string) => boolean
  onCancel: () => void
}) {
  const [key, setKey] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  /*
   * Naming happens once. Enter leaves the field and the blur does the naming,
   * so without this the two would both fire and the second would report the
   * property it had just made as a name already in use. Escape closes the same
   * door from the other side: it is a blur too.
   */
  const settled = useRef(false)

  useEffect(() => ref.current?.focus(), [])

  const finish = (name: boolean) => {
    if (settled.current) return
    settled.current = true
    if (!name || !key.trim()) {
      onCancel()
      return
    }
    // A name the note is already using leaves the row open and the caret in it.
    if (!onCommit(key)) {
      settled.current = false
      ref.current?.focus()
    }
  }

  return (
    <div class="property-row">
      <span class="property-kind">
        <IconText size={14} />
      </span>
      <input
        ref={ref}
        class="property-key"
        value={key}
        aria-label="New property name"
        placeholder="Name"
        spellcheck={false}
        onInput={(e) => setKey(e.currentTarget.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') finish(false)
        }}
      />
      <span class="property-value property-hint">Name it, then give it a value</span>
      {/*
        * Answered on mousedown, and the focus change prevented with it: left
        * to the click, the field would have blurred first and named the
        * property this button exists to abandon.
        */}
      <button
        class="property-remove"
        aria-label="Cancel"
        title="Cancel"
        onMouseDown={(e) => {
          e.preventDefault()
          finish(false)
        }}
        onClick={() => finish(false)}
      >
        <IconClose size={14} />
      </button>
    </div>
  )
}
