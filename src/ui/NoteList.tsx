/** Middle column: search, date-grouped note rows, and the alternate list views. */

import { useEffect, useRef } from 'preact/hooks'
import {
  attachmentUrl,
  createNote,
  deleteNote,
  resolveEmbed,
  restoreFromTrash,
  forget,
  getEntry,
} from '../core/vault'
import { setFrontmatterKey } from '../core/markdown'
import { getRaw, saveNote } from '../core/vault'
import type { NoteIndexEntry } from '../core/types'
import { basename, formatBytes, mediaClass, relativeTime } from '../core/util'
import {
  activePath,
  fileList,
  lightboxPath,
  notify,
  openNote,
  query,
  scope,
  scopeLabel,
  sections,
  trashList,
  unlinkedList,
  visibleNotes,
} from './state'
import { allFolderPaths, moveNoteToFolder } from '../core/folders'
import { openMenu, useLongPress, type MenuItem } from './Menu'
import { layoutMode, toggleSidebar } from './layout'
import { MobileScopeBar } from './Mobile'
import { IconImage, IconNewNote, IconPin, IconSearch, IconSidebar, IconClose, IconDots } from './Icons'
import { settings, update } from '../core/settings'

/** First image embed in a note, used as the row thumbnail. */
function thumbFor(entry: NoteIndexEntry): string | undefined {
  for (const ref of entry.embeds) {
    const p = resolveEmbed(ref, entry.path)
    if (p && mediaClass(p) === 'image') {
      const url = attachmentUrl(p)
      if (url) return url
    }
  }
  return undefined
}

function NoteRow({ entry }: { entry: NoteIndexEntry }) {
  const active = activePath.value === entry.path
  const thumb = thumbFor(entry)
  const stamp = settings.value.sortBy === 'ctime' ? entry.ctime : entry.mtime
  const longPress = useLongPress(
    () => noteMenu(entry),
    () => entry.title,
  )

  return (
    <button
      class="note-row"
      aria-current={active}
      onClick={() => openNote(entry.path)}
      onContextMenu={(e) => {
        e.preventDefault()
        openMenu(e, noteMenu(entry), entry.title)
      }}
      {...longPress}
    >
      <span class="note-row-main">
        <span class="note-row-title">{entry.title}</span>
        <span class="note-row-sub">
          <span class="note-row-date">{relativeTime(stamp)}</span>
          <span class="note-row-excerpt">{entry.excerpt || 'No additional text'}</span>
        </span>
      </span>
      <span class="note-row-badges">
        {entry.pinned && <IconPin />}
        {!thumb && entry.embeds.length > 0 && <IconImage />}
      </span>
      {thumb && <img class="note-row-thumb" src={thumb} alt="" loading="lazy" />}
    </button>
  )
}

/** Actions on a note row, shared by right-click and long-press. */
function noteMenu(entry: NoteIndexEntry): MenuItem[] {
  const f = getRaw(entry.path)
  const folders = ['', ...allFolderPaths.value].filter((p) => p !== entry.folder)

  return [
    {
      label: entry.pinned ? 'Unpin' : 'Pin to top',
      onSelect: async () => {
        if (!f) return
        await saveNote(
          entry.path,
          setFrontmatterKey(f.text ?? '', 'pinned', entry.pinned ? 'false' : 'true'),
        )
      },
    },
    {
      label: 'Duplicate',
      onSelect: async () => {
        if (!f) return
        openNote(await createNote(entry.folder, `${entry.title} copy`, f.text ?? ''))
      },
    },
    {
      label: folders.length ? 'Move to…' : 'Move to… (no other folders)',
      disabled: !folders.length,
      separated: true,
      onSelect: () => {
        // A second menu rather than a picker dialog: it reuses the same sheet
        // on touch, so moving a note is two taps in the same place.
        openMenu(
          { clientX: window.innerWidth / 2, clientY: window.innerHeight / 2 },
          folders.map((path) => ({
            label: path || 'Vault root',
            onSelect: async () => {
              const dest = await moveNoteToFolder(entry.path, path)
              activePath.value = dest
              notify(`Moved to ${path || 'the vault root'}`)
            },
          })),
          `Move "${entry.title}" to`,
        )
      },
    },
    {
      label: 'Delete',
      danger: true,
      separated: true,
      onSelect: async () => {
        await deleteNote(entry.path)
        if (activePath.value === entry.path) activePath.value = undefined
        notify(`Moved "${entry.title}" to Recently Deleted`)
      },
    },
  ]
}

export function NoteList() {
  const scrollRef = useRef<HTMLDivElement>(null)
  const s = scope.value
  const compact = layoutMode.value === 'compact'

  // Keep the selected row in view when selection moves from elsewhere
  // (keyboard nav, a wikilink jump, the command palette).
  useEffect(() => {
    const el = scrollRef.current?.querySelector('[aria-current="true"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [activePath.value])

  const newNote = async () => {
    const folder = s.kind === 'folder' ? s.path : ''
    let body = ''
    if (s.kind === 'tag') body = `#${s.tag}\n\n`
    openNote(await createNote(folder, 'Untitled', body))
  }

  return (
    <div class="pane list-pane">
      <div class="pane-head">
        {!compact && (
          <button class="icon-btn" onClick={toggleSidebar} title="Toggle sidebar (⌘\)">
            <IconSidebar />
          </button>
        )}
        <span class={compact ? 'pane-title pane-title-lg' : 'pane-title'}>
          {compact ? 'Notes' : scopeLabel(s)}
        </span>
        <span class="spacer" />
        {compact && (
          <button
            class="icon-btn"
            aria-label="Sort order"
            onClick={(e) =>
              openMenu(
                e,
                [
                  { label: 'Sort by date edited', onSelect: () => update({ sortBy: 'mtime' }) },
                  { label: 'Sort by date created', onSelect: () => update({ sortBy: 'ctime' }) },
                  { label: 'Sort by title', onSelect: () => update({ sortBy: 'title' }) },
                ],
                'Sort',
              )
            }
          >
            <IconDots size={19} />
          </button>
        )}
        {!compact && (
        <select
          class="sort-select"
          value={settings.value.sortBy}
          onChange={(e) => update({ sortBy: (e.target as HTMLSelectElement).value as never })}
          title="Sort order"
          aria-label="Sort order"
        >
          <option value="mtime">Edited</option>
          <option value="ctime">Created</option>
          <option value="title">Title</option>
        </select>
        )}
        <button class="icon-btn" onClick={newNote} title="New note (⌘N)">
          <IconNewNote />
        </button>
      </div>

      <div class="search-wrap">
        <div class="search-box">
          <IconSearch size={14} />
          <input
            type="search"
            placeholder="Search all notes"
            value={query.value}
            onInput={(e) => (query.value = (e.target as HTMLInputElement).value)}
            aria-label="Search notes"
          />
          {query.value && (
            <button class="icon-btn" style={{ width: 18, height: 18 }} onClick={() => (query.value = '')}>
              <IconClose size={13} />
            </button>
          )}
        </div>
      </div>

      {compact && <MobileScopeBar />}

      <div class="list-scroll" ref={scrollRef}>
        {s.kind === 'trash' && !query.value ? (
          <TrashView />
        ) : s.kind === 'files' && !query.value ? (
          <FilesView />
        ) : s.kind === 'unlinked' && !query.value ? (
          <UnlinkedView />
        ) : visibleNotes.value.length === 0 ? (
          <div class="empty">
            {query.value ? (
              <>No notes match “{query.value}”.</>
            ) : (
              <>
                Nothing here yet.
                <br />
                Press ⌘N to start a note.
              </>
            )}
          </div>
        ) : (
          sections.value.map((sec) => (
            <div key={sec.title}>
              {sec.title && <div class="section-label">{sec.title}</div>}
              {sec.items.map((n) => (
                <NoteRow key={n.path} entry={n} />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function TrashView() {
  const items = trashList.value
  if (!items.length) return <div class="empty">Recently Deleted is empty.</div>
  return (
    <>
      <div class="section-label">Deleted notes are kept until you remove them here.</div>
      {items.map((f) => (
        <div key={f.path} class="note-row" style={{ cursor: 'default' }}>
          <span class="note-row-main">
            <span class="note-row-title">
              {basename(f.path).replace(/^[\d-]+T[\d-]+--(?:\d+--)?/, '')}
            </span>
            <span class="note-row-sub">
              <span class="note-row-date">{relativeTime(f.mtime)}</span>
              <span class="note-row-excerpt">{(f.text ?? '').slice(0, 90) || formatBytes(f.size)}</span>
            </span>
          </span>
          <span class="note-row-badges">
            <button
              class="status-btn"
              onClick={async () => {
                const p = await restoreFromTrash(f.path)
                openNote(p)
                notify('Restored')
              }}
            >
              Restore
            </button>
            <button
              class="status-btn"
              style={{ color: 'var(--danger)' }}
              onClick={async () => {
                if (!confirm('Permanently delete this note? This cannot be undone.')) return
                await forget(f.path)
              }}
            >
              Delete
            </button>
          </span>
        </div>
      ))}
    </>
  )
}

function FilesView() {
  const items = fileList.value
  if (!items.length)
    return (
      <div class="empty">
        No files yet.
        <br />
        Paste or drop an image, PDF or video into a note.
      </div>
    )
  return (
    <>
      <div class="section-label">{items.length} files</div>
      {items.map((f) => {
        const kind = mediaClass(f.path)
        const url = kind === 'image' ? attachmentUrl(f.path) : undefined
        return (
          <button key={f.path} class="note-row" onClick={() => (lightboxPath.value = f.path)}>
            <span class="note-row-main">
              <span class="note-row-title">{basename(f.path)}</span>
              <span class="note-row-sub">
                <span class="note-row-date">{kind}</span>
                <span class="note-row-excerpt">
                  {formatBytes(f.size)} · {f.path}
                </span>
              </span>
            </span>
            {url && <img class="note-row-thumb" src={url} alt="" loading="lazy" />}
          </button>
        )
      })}
    </>
  )
}

function UnlinkedView() {
  const items = unlinkedList.value
  if (!items.length) return <div class="empty">Every link resolves. Nice.</div>
  return (
    <>
      <div class="section-label">Links pointing at notes that don’t exist yet</div>
      {items.map(([target, sources]) => (
        <div key={target} class="note-row" style={{ cursor: 'default' }}>
          <span class="note-row-main">
            <span class="note-row-title">{target}</span>
            <span class="note-row-sub">
              <span class="note-row-excerpt">
                linked from {sources.map((p) => getEntry(p)?.title ?? p).join(', ')}
              </span>
            </span>
          </span>
          <span class="note-row-badges">
            <button
              class="status-btn"
              onClick={async () => {
                const p = await createNote('', target, `# ${target}\n\n`)
                activePath.value = p
              }}
            >
              Create
            </button>
          </span>
        </div>
      ))}
    </>
  )
}
