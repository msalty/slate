/** Right-of-centre column: the note itself. */

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { EditorView } from '@codemirror/view'
import { createEditorState, fontCompartment, previewCompartment, setDoc } from '../editor/setup'
import {
  livePreview,
  linkClicks,
  tableField,
  focusedField,
  focusWatcher,
  interactedField,
} from '../editor/livePreview'
import {
  backlinkMap,
  getEntry,
  getRaw,
  renameNote,
  revision,
  saveNote,
  deleteNote,
  createNote,
} from '../core/vault'
import { rebaseBuffer } from '../core/rebase'
import { settings, update } from '../core/settings'
import { syncSoon } from '../core/sync'
import { activePath, closeMobileEditor, historyOpen, notify } from './state'
import { layoutMode, railState, toggleRail } from './layout'
import { debounce, relativeTime } from '../core/util'
import {
  IconCamera,
  IconChevronLeft,
  IconCode,
  IconDots,
  IconEye,
  IconHistory,
  IconImagePlus,
  IconPaperclip,
  IconRail,
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
  // Reading the vault's revision here is what makes the editor notice writes it
  // did not make: a sync pull, a restore from history, a task toggled elsewhere.
  const rev = revision.value
  const entry = path ? getEntry(path) : undefined
  const file = path ? getRaw(path) : undefined

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
    if (!view || !p) return
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
      live: settings.value.editorMode === 'live',
      fontSize: settings.value.fontSize,
      onChange: (text) => saveRef.current(path, text),
    })
    const view = new EditorView({ state, parent: hostRef.current })
    viewRef.current = view

    const onScroll = () => setScrolled(view.scrollDOM.scrollTop > 4)
    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true })

    // Focus the body, unless the note is brand new and still called Untitled —
    // then the title is what the user wants to type first.
    if (getEntry(path)?.title !== 'Untitled') view.focus()

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

  // Live/source toggle and font size reconfigure in place.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: [
        previewCompartment.reconfigure(
          settings.value.editorMode === 'live'
            ? [focusedField, focusWatcher, interactedField, livePreview, tableField, linkClicks]
            : [],
        ),
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
    }
  }, [])

  const compact = layoutMode.value === 'compact'

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
  const live = settings.value.editorMode === 'live'

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
    <div class="pane editor-pane" data-scrolled={scrolled ? '1' : '0'}>
      <div class="pane-head editor-head">
        {compact && (
          <button class="icon-btn" onClick={closeMobileEditor} aria-label="Back">
            <IconChevronLeft size={20} />
          </button>
        )}
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
        <span class="spacer" />
        <button class="icon-btn" onClick={insertMenu} title="Insert photo or file" aria-label="Insert photo or file">
          <IconImagePlus />
        </button>
        {compact ? (
          <button
            class="icon-btn"
            aria-label="Note actions"
            onClick={(e) =>
              openMenu(
                e,
                [
                  {
                    label: live ? 'Show markdown source' : 'Back to live preview',
                    onSelect: () => update({ editorMode: live ? 'source' : 'live' }),
                  },
                  { label: 'Version history', onSelect: () => (historyOpen.value = true) },
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
              aria-pressed={!live}
              onClick={() => update({ editorMode: live ? 'source' : 'live' })}
              title={live ? 'Show markdown source (⌘⇧M)' : 'Back to live preview (⌘⇧M)'}
            >
              {live ? <IconCode /> : <IconEye />}
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

      <div class="editor-body">
        <div class="editor-host" ref={hostRef} />
      </div>

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

      <div
        class="editor-date"
        style={{ position: 'absolute', top: 12, left: 0, right: 0, pointerEvents: 'none' }}
        hidden
      >
        {file ? relativeTime(file.mtime) : ''}
      </div>
    </div>
  )
}

/** Exposed so the shell's command palette can create-and-open in one step. */
export async function newNoteInFolder(folder: string, title = 'Untitled') {
  const p = await createNote(folder, title)
  activePath.value = p
  return p
}
