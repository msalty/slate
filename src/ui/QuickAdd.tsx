/**
 * The quick-capture sheet.
 *
 * One field, focused, with the keyboard already up: two taps from anywhere to
 * a task on today's list or a note that is named after what you typed. It
 * borrows the action sheet's geometry rather than being a dialog, so it is a
 * sheet on a phone and a small panel on a desktop, and it rides `--kb-inset`
 * the same way every other sheet does.
 *
 * The one unusual thing here is that the field is **always mounted**, off
 * screen when the sheet is closed. iOS raises the keyboard only for a `focus()`
 * that happens inside the tap that asked for it, and a component that mounts on
 * a signal change is rendered a microtask too late for that — so the element
 * that will be typed into already exists when the button is pressed, and
 * `openQuickAdd` focuses it synchronously. Without this the sheet opens on a
 * phone with no keyboard and the first thing you do is tap the field.
 */

import { useEffect, useRef, useState } from 'preact/hooks'
import { computed, signal } from '@preact/signals'
import { captureNote, captureTasks, taskDestination } from '../core/capture'
import { settings, update } from '../core/settings'
import { folderTree, type FolderNode } from '../core/folders'
import { dueLabel, duePresets, startOfDay } from '../core/util'
import { openMenu } from './Menu'
import { anchorOf, openDueMenu } from './DueMenu'
import { notify, openNote } from './state'
import { IconCheck, IconClose, IconNewNote } from './Icons'

export type QuickAddMode = 'task' | 'note'

interface QuickAddState {
  mode: QuickAddMode
  /** The note a task is filed in — the calendar's day panel is that day's page. */
  day?: number
  /** A date the caller already knows, from the group or day it was pressed in. */
  due?: number
  /** Text a launcher shortcut or the share sheet arrived with. */
  text?: string
}

const state = signal<QuickAddState | null>(null)

/** True while the sheet is up — read by the phone's back button, which closes
 * the sheet before it closes anything behind it. */
export const quickAddOpen = computed(() => state.value !== null)

/**
 * Open the sheet, and put the keyboard up in the same gesture.
 *
 * Callable from anywhere — a button, a menu item, a launch URL. The focus is
 * deliberately not in an effect: see the note at the top of this file.
 */
export function openQuickAdd(opts: QuickAddState) {
  state.value = opts
  document.querySelector<HTMLTextAreaElement>('.qa-field')?.focus()
}

export function closeQuickAdd() {
  state.value = null
}

/** Folders as flat rows, for the note destination menu. */
function flatten(node: FolderNode, depth = 0): Array<{ path: string; label: string }> {
  const out: Array<{ path: string; label: string }> = []
  for (const c of node.children) {
    out.push({ path: c.path, label: `${'  '.repeat(depth)}${c.name}` })
    out.push(...flatten(c, depth + 1))
  }
  return out
}

export function QuickAdd() {
  const st = state.value
  const open = !!st
  const [mode, setMode] = useState<QuickAddMode>('task')
  const [text, setText] = useState('')
  const [due, setDue] = useState<number | undefined>(undefined)
  /*
   * What this sitting of the sheet has already put away, and where. It stands
   * in for the toast a task capture used to raise: the sheet stays open, the
   * toast is pinned to the bottom of the screen, and the two would be drawn on
   * top of each other. A count also says something a toast cannot — that the
   * three you have just reeled off are all in.
   */
  const [added, setAdded] = useState<{ count: number; path: string } | null>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  /* One capture at a time: two quick taps on Add would otherwise both read the
     note before either had written to it, and the first line would be lost. */
  const busy = useRef(false)
  const s = settings.value

  // Each opening starts clean, carrying whatever the caller already knew.
  useEffect(() => {
    if (!st) return
    setMode(st.mode)
    setText(st.text ?? '')
    setDue(st.due)
    setAdded(null)
  }, [st])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeQuickAdd()
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [open])

  /* The field grows with what is in it, up to a third of the screen. */
  useEffect(() => {
    const el = field.current
    if (!el || !open) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, Math.round(innerHeight / 3))}px`
  }, [text, open, mode])

  const day = st?.day
  const dest =
    mode === 'task' ? taskDestination(day) : s.quickAddNoteFolder || 'All Notes'

  const add = async (andOpen = false) => {
    const body = text.trim()
    if (!body || busy.current) return
    busy.current = true
    try {
      const r =
        mode === 'task'
          ? await captureTasks({ text: body, due, day })
          : await captureNote({ text: body })

      if (!r.ok) {
        notify(
          r.reason === 'locked'
            ? `${dest} is read-only, so nothing was added.`
            : 'Nothing to add.',
          'error',
        )
        return
      }

      if (mode === 'task') {
        /*
         * Tasks arrive in threes. The sheet stays up with the field cleared
         * and the date kept, so a second and a third are one tap each.
         */
        setText('')
        setAdded({ count: (added?.count ?? 0) + r.count, path: r.path })
        field.current?.focus()
        return
      }

      closeQuickAdd()
      if (andOpen) openNote(r.path, { editing: true })
      else notify(`Created ${r.path}`, 'info', { label: 'Open', run: () => openNote(r.path) })
    } finally {
      busy.current = false
    }
  }

  const destMenu = (e: MouseEvent) => {
    if (mode === 'task') {
      openMenu(
        e,
        [
          {
            label: day === undefined ? "Today's note" : 'That day’s note',
            checked: s.quickAddTaskTarget === 'daily',
            onSelect: () => update({ quickAddTaskTarget: 'daily' }),
          },
          {
            label: 'Inbox',
            checked: s.quickAddTaskTarget === 'inbox',
            onSelect: () => update({ quickAddTaskTarget: 'inbox' }),
          },
        ],
        'File the task in',
      )
      return
    }
    openMenu(
      e,
      [
        {
          label: 'All Notes',
          checked: s.quickAddNoteFolder === '',
          onSelect: () => update({ quickAddNoteFolder: '' }),
        },
        ...flatten(folderTree.value).map((f) => ({
          label: f.label,
          checked: s.quickAddNoteFolder === f.path,
          onSelect: () => update({ quickAddNoteFolder: f.path }),
        })),
      ],
      'Put the note in',
    )
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey
    // Enter adds a task, which is a line; a note is prose, so it takes ⌘Enter.
    if (e.key === 'Enter' && (mod || (mode === 'task' && !e.shiftKey))) {
      e.preventDefault()
      void add()
    }
  }

  return (
    <div class="qa-root" data-open={open ? '1' : '0'} aria-hidden={open ? undefined : 'true'}>
      {open && <div class="qa-scrim" onClick={() => closeQuickAdd()} />}
      <div
        class="qa-sheet"
        role="dialog"
        aria-modal={open ? 'true' : undefined}
        aria-label="Quick add"
      >
        <div class="qa-head">
          <div class="qa-seg" role="group" aria-label="What to add">
            {(['task', 'note'] as const).map((m) => (
              <button
                key={m}
                class="qa-seg-btn"
                aria-pressed={mode === m}
                tabIndex={open ? undefined : -1}
                onClick={() => {
                  setMode(m)
                  field.current?.focus()
                }}
              >
                {m === 'task' ? <IconCheck size={13} /> : <IconNewNote size={13} />}
                {m === 'task' ? 'Task' : 'Note'}
              </button>
            ))}
          </div>
          <span class="spacer" />
          {added && mode === 'task' && (
            <button
              class="qa-added"
              tabIndex={open ? undefined : -1}
              onClick={() => {
                closeQuickAdd()
                openNote(added.path)
              }}
            >
              <IconCheck size={12} />
              {added.count} added
            </button>
          )}
          <button
            class="icon-btn"
            onClick={() => closeQuickAdd()}
            tabIndex={open ? undefined : -1}
            aria-label="Close"
          >
            <IconClose size={16} />
          </button>
        </div>

        <div class="qa-input">
          <textarea
            class="qa-field"
            ref={field}
            rows={1}
            value={text}
            tabIndex={open ? undefined : -1}
            enterkeyhint={mode === 'task' ? 'done' : 'enter'}
            placeholder={mode === 'task' ? 'What needs doing?' : 'Start a note…'}
            aria-label={mode === 'task' ? 'Task' : 'Note'}
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
            onKeyDown={onKeyDown}
          />
          <button
            class="qa-add"
            disabled={!text.trim()}
            tabIndex={open ? undefined : -1}
            onClick={() => void add()}
          >
            Add
          </button>
        </div>

        <div class="qa-chips">
          {mode === 'task' ? (
            <>
              {duePresets(startOfDay(Date.now()))
                .slice(0, 3)
                .map((p) => (
                  <button
                    key={p.date}
                    class="qa-chip"
                    aria-pressed={due === p.date}
                    tabIndex={open ? undefined : -1}
                    onClick={() => setDue(due === p.date ? undefined : p.date)}
                  >
                    {p.label}
                  </button>
                ))}
              <button
                class="qa-chip"
                aria-pressed={due !== undefined && !duePresets().some((p) => p.date === due)}
                tabIndex={open ? undefined : -1}
                onClick={(e) => openDueMenu(anchorOf(e.currentTarget as Element), due, setDue)}
              >
                {due !== undefined && !duePresets().some((p) => p.date === due)
                  ? dueLabel(due)
                  : 'Date…'}
              </button>
            </>
          ) : (
            <button class="qa-chip" tabIndex={open ? undefined : -1} onClick={() => void add(true)}>
              Add &amp; open
            </button>
          )}
          <button
            class="qa-chip qa-dest"
            tabIndex={open ? undefined : -1}
            onClick={destMenu}
            aria-label={`Destination: ${dest}. Change it.`}
          >
            {dest}
          </button>
        </div>
      </div>
    </div>
  )
}
