/** Right-of-centre column: the note itself. */

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { EditorView } from '@codemirror/view'
import {
  createEditorState,
  fontCompartment,
  previewCompartment,
  previewExtensions,
  setDoc,
} from '../editor/setup'
import { FormatBar } from './FormatBar'
import {
  backlinkMap,
  getEntry,
  getRaw,
  isTrashed,
  renameNote,
  restoreFromTrash,
  revision,
  saveNote,
  deleteNote,
  createNote,
  forget,
  trashDisplayName,
} from '../core/vault'
import { activeEditor } from '../editor/context'
import { focusedCell } from '../editor/table'
import { rebaseBuffer } from '../core/rebase'
import { settings, update } from '../core/settings'
import { syncSoon } from '../core/sync'
import {
  EDITOR_MODES,
  activePath,
  closeMobileEditor,
  formatSheetOpen,
  historyOpen,
  notify,
} from './state'
import { layoutMode, railState, toggleRail } from './layout'
import { debounce, longDateTime } from '../core/util'
import {
  IconCamera,
  IconCheck,
  IconChevronLeft,
  IconCode,
  IconDots,
  IconEye,
  IconHistory,
  IconImagePlus,
  IconPaperclip,
  IconRail,
  IconRichText,
  IconTrash,
} from './Icons'
import { openMenu, type MenuItem } from './Menu'
import { hasCamera, pickAndInsert } from '../editor/pickImage'

export function EditorPane() {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const pathRef = useRef<string | undefined>(undefined)
  const [scrolled, setScrolled] = useState(false)
  const path = activePath.value
  const compact = layoutMode.value === 'compact'
  // Reading the vault's revision here is what makes the editor notice writes it
  // did not make: a sync pull, a restore from history, a task toggled elsewhere.
  const rev = revision.value
  const entry = path ? getEntry(path) : undefined
  const file = path ? getRaw(path) : undefined
  // A note open from Recently Deleted is shown, not edited — you restore it
  // first. Reading one is how you decide whether you want it back.
  const trashed = !!path && isTrashed(path)

  /**
   * The text the buffer and the vault last agreed on — the base for folding in
   * a version that arrives from somewhere else while the note is open.
   */
  const baseRef = useRef('')

  /**
   * Autosave. 400ms is short enough that a crash loses nothing meaningful and
   * long enough that a burst of typing is one write rather than dozens.
   * The flush on note change and on unmount is what makes it safe.
   */
  const saveRef = useRef(
    debounce((p: string, text: string) => {
      baseRef.current = text
      void saveNote(p, text).then(() => syncSoon())
    }, 400),
  )

  const flush = () => {
    const view = viewRef.current
    const p = pathRef.current
    if (!view || !p || isTrashed(p)) return
    saveRef.current.flush()
    const text = view.state.doc.toString()
    baseRef.current = text
    void saveNote(p, text)
  }

  // Rebuild the editor when the open note changes. A fresh state per note means
  // undo history is scoped to the note, which is what people expect.
  useLayoutEffect(() => {
    if (!hostRef.current) return
    if (pathRef.current && pathRef.current !== path) flush()

    viewRef.current?.destroy()
    viewRef.current = null
    pathRef.current = path
    if (!path) return

    const f = getRaw(path)
    baseRef.current = f?.text ?? ''
    const state = createEditorState({
      doc: f?.text ?? '',
      path,
      mode: settings.value.editorMode,
      fontSize: settings.value.fontSize,
      readOnly: isTrashed(path),
      onChange: (text) => saveRef.current(path, text),
    })
    const view = new EditorView({ state, parent: hostRef.current })
    viewRef.current = view
    // Published so the format bar, the link dialog and the table controls can
    // act on the editor without each being handed a getter.
    activeEditor.value = view

    const onScroll = () => setScrolled(view.scrollDOM.scrollTop > 4)
    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true })

    // Focus the body, unless the note is brand new and still called Untitled —
    // then the title is what the user wants to type first. A deleted note is
    // never focused: there is nothing to type into it.
    if (!isTrashed(path) && getEntry(path)?.title !== 'Untitled') view.focus()

    return () => {
      view.scrollDOM.removeEventListener('scroll', onScroll)
    }
  }, [path])

  /**
   * Fold a version that arrived from elsewhere into the open buffer.
   *
   * Without this the editor keeps showing — and, on the next keystroke, saves —
   * the text it was seeded with, so a note open on two machines has each side
   * writing its stale copy back over the other's, forever.
   */
  useEffect(() => {
    const view = viewRef.current
    if (!path || !view || pathRef.current !== path) return
    const incoming = getRaw(path)?.text
    if (incoming === undefined || incoming === baseRef.current) return

    const buffer = view.state.doc.toString()
    const r = rebaseBuffer(baseRef.current, buffer, incoming)
    baseRef.current = r.changed ? r.text : incoming
    if (!r.changed) return

    setDoc(view, r.text, path)
    // A merge produced text neither side had; the vault needs it too, and the
    // debounced save the dispatch just scheduled would be 400ms late.
    if (r.text !== incoming) void saveNote(path, r.text).then(() => syncSoon())
    if (r.conflicted)
      notify('This note changed elsewhere while you were typing — both edits are marked in place')
  }, [path, rev])

  /*
   * On a phone, the keyboard and the Format sheet never share the screen.
   *
   * Between them they leave a sliver of note visible, and you are either
   * formatting or typing — never both in the same second. So opening the sheet
   * dismisses the keyboard, and touching the note to type closes the sheet.
   * The editor runs blurred while the sheet is open, which is also why the
   * caret is kept visible by CSS: it is what the buttons act on.
   */
  useEffect(() => {
    const view = viewRef.current
    if (!view || !compact || !formatSheetOpen.value) return
    /*
     * Whatever is being typed into has to give the keyboard up, and in a table
     * that is a cell rather than the editor: a cell is its own editing host, so
     * `contentDOM.blur()` does nothing to it and the keyboard would stay up
     * under the sheet. The cell remains what the buttons act on after it
     * blurs — it is marked, not forgotten.
     */
    const active = document.activeElement
    if (active instanceof HTMLElement && view.dom.contains(active)) active.blur()
    else view.contentDOM.blur()
    // The pane is shorter now the sheet is in it; put the caret back in sight.
    const settle = setTimeout(() => {
      const v = viewRef.current
      if (!v) return
      /*
       * A table cell is nowhere near the editor's own caret, which in a note
       * opened straight into a table is still sitting at position 0 — scrolling
       * to that is what used to throw the table off the top of the screen.
       */
      const cell = focusedCell.value
      const pos = cell
        ? Math.min(cell.from, v.state.doc.length)
        : v.state.selection.main.head
      v.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
    }, 60)
    const close = () => (formatSheetOpen.value = false)
    // `focusin`, not `focus` on the content: focus does not bubble, and a table
    // cell taking it is just as much "I want to type again" as the note is.
    view.dom.addEventListener('focusin', close)
    return () => {
      clearTimeout(settle)
      view.dom.removeEventListener('focusin', close)
    }
  }, [formatSheetOpen.value, compact, path])

  // Live/source toggle and font size reconfigure in place.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: [
        previewCompartment.reconfigure(previewExtensions(settings.value.editorMode)),
        fontCompartment.reconfigure(
          EditorView.theme({ '&': { '--editor-font-size': `${settings.value.fontSize}px` } } as never),
        ),
      ],
    })
  }, [settings.value.editorMode, settings.value.fontSize])

  // Never leave an unsaved buffer behind.
  useEffect(() => {
    const onHide = () => flush()
    addEventListener('pagehide', onHide)
    addEventListener('beforeunload', onHide)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush()
    })
    return () => {
      removeEventListener('pagehide', onHide)
      removeEventListener('beforeunload', onHide)
      flush()
      viewRef.current?.destroy()
      viewRef.current = null
      activeEditor.value = null
    }
  }, [])

  if (!path || !entry) {
    return (
      <div class="pane editor-pane">
        <div class="pane-head">
          <span class="spacer" />
          <button
            class="icon-btn"
            aria-pressed={railState.value !== 'hidden'}
            onClick={toggleRail}
            title="Calendar and tasks (⌘⇧R)"
          >
            <IconRail />
          </button>
        </div>
        <div class="empty" style={{ marginTop: '18vh' }}>
          Select a note, or press ⌘N to write a new one.
        </div>
      </div>
    )
  }

  const links = backlinkMap.value.get(path) ?? []
  const mode = settings.value.editorMode
  const rich = mode === 'rich'

  /** The three presentations, as a menu with the active one ticked. */
  const modeItems: MenuItem[] = EDITOR_MODES.map((m) => ({
    label: m.label,
    icon: mode === m.id ? <IconCheck size={15} /> : <span style={{ width: 15 }} />,
    onSelect: () => update({ editorMode: m.id }),
  }))

  /** Camera / library / any file — all land in the note as resizable embeds. */
  const insertMenu = (e: { clientX: number; clientY: number }) => {
    const view = viewRef.current
    if (!view) return
    const items: MenuItem[] = []
    if (hasCamera()) {
      items.push({
        label: 'Take Photo',
        icon: <IconCamera size={16} />,
        onSelect: () => pickAndInsert(view, 'camera'),
      })
    }
    items.push(
      {
        label: 'Photo Library',
        icon: <IconImagePlus size={16} />,
        onSelect: () => pickAndInsert(view, 'library'),
      },
      {
        label: 'Choose File…',
        icon: <IconPaperclip size={16} />,
        separated: true,
        onSelect: () => pickAndInsert(view, 'file'),
      },
    )
    openMenu(e, items, 'Insert')
  }

  return (
    <div
      class="pane editor-pane"
      data-width={settings.value.editorWidth}
      data-scrolled={scrolled ? '1' : '0'}
      data-format-open={rich && compact && formatSheetOpen.value ? '1' : '0'}
    >
      <div class="pane-head editor-head">
        {compact && (
          <button class="icon-btn" onClick={closeMobileEditor} aria-label="Back">
            <IconChevronLeft size={20} />
          </button>
        )}
        {trashed ? (
          <span class="editor-title-input" aria-label="Deleted note">
            {trashDisplayName(path)}
          </span>
        ) : (
        <input
          class="editor-title-input"
          value={entry.title}
          aria-label="Note title"
          onBlur={async (e) => {
            const next = (e.target as HTMLInputElement).value.trim()
            if (!next || next === entry.title) return
            flush()
            const p = await renameNote(path, next)
            activePath.value = p
            notify('Renamed — links updated')
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') {
              ;(e.target as HTMLInputElement).value = entry.title
              ;(e.target as HTMLInputElement).blur()
            }
          }}
        />
        )}
        <span class="spacer" />
        {!trashed && compact && rich && (
          <button
            class="icon-btn fmt-open"
            aria-label="Format"
            title="Format"
            aria-pressed={formatSheetOpen.value}
            onClick={() => {
              const open = !formatSheetOpen.value
              formatSheetOpen.value = open
              // Closing it means they want to type again.
              if (!open) viewRef.current?.focus()
            }}
          >
            Aa
          </button>
        )}
        {!trashed && (
          <button
            class="icon-btn"
            onClick={insertMenu}
            title="Insert photo or file"
            aria-label="Insert photo or file"
          >
            <IconImagePlus />
          </button>
        )}
        {trashed ? (
          <button
            class="icon-btn"
            aria-pressed={railState.value !== 'hidden'}
            onClick={toggleRail}
            title="Calendar and tasks (⌘⇧R)"
          >
            <IconRail />
          </button>
        ) : compact ? (
          <button
            class="icon-btn"
            aria-label="Note actions"
            onClick={(e) =>
              openMenu(
                e,
                [
                  ...modeItems,
                  {
                    label: 'Version history',
                    separated: true,
                    onSelect: () => {
                      historyOpen.value = true
                    },
                  },
                  {
                    label: 'Delete note',
                    danger: true,
                    separated: true,
                    onSelect: async () => {
                      saveRef.current.flush()
                      await deleteNote(path)
                      activePath.value = undefined
                      closeMobileEditor()
                      notify('Moved to Recently Deleted')
                    },
                  },
                ],
                entry.title,
              )
            }
          >
            <IconDots size={19} />
          </button>
        ) : (
          <>
            <button
              class="icon-btn"
              aria-label="Editor mode"
              title={`Editor mode: ${EDITOR_MODES.find((m) => m.id === mode)?.label} (⌘⇧M cycles)`}
              onClick={(e) => openMenu(e, modeItems, 'Editor mode')}
            >
              {mode === 'rich' ? <IconRichText /> : mode === 'live' ? <IconEye /> : <IconCode />}
            </button>
            <button
              class="icon-btn"
              onClick={() => (historyOpen.value = true)}
              title="Version history"
            >
              <IconHistory />
            </button>
            <button
              class="icon-btn"
              onClick={async () => {
                if (!confirm(`Move "${entry.title}" to Recently Deleted?`)) return
                saveRef.current.flush()
                await deleteNote(path)
                activePath.value = undefined
                notify('Moved to Recently Deleted')
              }}
              title="Delete note"
            >
              <IconTrash />
            </button>
            <button
              class="icon-btn"
              aria-pressed={railState.value !== 'hidden'}
              onClick={toggleRail}
              title="Calendar and tasks (⌘⇧R)"
            >
              <IconRail />
            </button>
          </>
        )}
      </div>

      {trashed && (
        <div class="trash-banner">
          <span>
            In Recently Deleted. Restore it to make changes.
          </span>
          <span class="spacer" />
          <button
            class="row-action"
            onClick={async () => {
              const p = await restoreFromTrash(path)
              activePath.value = p
              notify('Restored')
            }}
          >
            Restore
          </button>
          <button
            class="row-action row-action-danger"
            onClick={async () => {
              if (!confirm(`Permanently delete "${trashDisplayName(path)}"? This cannot be undone.`))
                return
              await forget(path)
              activePath.value = undefined
              if (compact) closeMobileEditor()
            }}
          >
            Delete
          </button>
        </div>
      )}

      {rich && !compact && !trashed && (
        <FormatBar variant="bar" getView={() => viewRef.current} />
      )}

      {/*
        * Apple Notes' one piece of chrome inside the page: when the note was
        * last touched, centred, faint, and nowhere near anything clickable.
        */}
      {file && (
        <div class="editor-date" title={`Created ${longDateTime(file.ctime)}`}>
          {longDateTime(file.mtime)}
        </div>
      )}

      <div class="editor-body">
        <div class="editor-host" ref={hostRef} />
      </div>

      {rich && compact && !trashed && formatSheetOpen.value && (
        <FormatBar variant="sheet" getView={() => viewRef.current} />
      )}

      {links.length > 0 && (
        <div class="backlinks">
          <div class="backlinks-inner">
            <h3>
              {links.length} linked mention{links.length === 1 ? '' : 's'}
            </h3>
            {links.map((p) => {
              const e = getEntry(p)
              if (!e) return null
              return (
                <button key={p} class="backlink-row" onClick={() => (activePath.value = p)}>
                  {e.title}
                  <small>{e.excerpt}</small>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

/** Exposed so the shell's command palette can create-and-open in one step. */
export async function newNoteInFolder(folder: string, title = 'Untitled') {
  const p = await createNote(folder, title)
  activePath.value = p
  return p
}
