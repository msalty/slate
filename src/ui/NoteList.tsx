/** Middle column: search, date-grouped note rows, and the alternate list views. */

import { useEffect, useRef } from 'preact/hooks'
import {
  attachmentUrl,
  createNote,
  deleteFile,
  deleteNote,
  orphanFiles,
  renameAttachment,
  resolveEmbed,
  restoreFromTrash,
  emptyTrash,
  purge,
  getEntry,
  trashTitle,
} from '../core/vault'
import { dailyNoteFor } from '../core/daily'
import { excerptOf, setFrontmatterKey } from '../core/markdown'
import { getRaw, saveNote } from '../core/vault'
import type { NoteIndexEntry, VaultFile } from '../core/types'
import { basename, formatBytes, mediaClass, relativeTime, startOfDay, ymd } from '../core/util'
import {
  activePath,
  fileList,
  lightboxPath,
  notify,
  openDailyNote,
  openNote,
  orphansOnly,
  query,
  scope,
  queryTerms,
  scopeLabel,
  searchKind,
  searchLabel,
  searchSnippets,
  searching,
  sections,
  trashList,
  unlinkedList,
  visibleNotes,
} from './state'
import {
  allFolderPaths,
  moveNoteToFolder,
  showsTasks,
  smartFolderById,
  tasksForSmartFolder,
} from '../core/folders'
import { TasksPanel } from './RightRail'
import { openMenu, useLongPress, type MenuItem } from './Menu'
import { SwipeRow, type SwipeAction } from './SwipeRow'
import { Highlight } from './Highlight'
import { openPrompt } from './PromptDialog'
import { layoutMode, toggleSidebar } from './layout'
import { MobileScopeBar } from './Mobile'
import { IconImage, IconNewNote, IconPin, IconPlus, IconSearch, IconSidebar, IconClose, IconDots } from './Icons'
import { settings, update } from '../core/settings'
import { newNoteInFolder } from './EditorPane'
import { canShareFiles, shareNote } from './shareNote'

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
  const hl = queryTerms.value
  /*
   * A result row shows the line the match is on, not the note's opening line.
   * Which word put a note in the list is the one thing the row has to answer,
   * and the first line of a long note usually says nothing about it.
   */
  const snippet = searchSnippets.value.get(entry.path)
  const longPress = useLongPress(
    () => noteMenu(entry),
    () => entry.title,
  )

  const row = (
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
        <span class="note-row-title">
          <Highlight text={entry.title} terms={hl} />
        </span>
        <span class="note-row-sub">
          <span class="note-row-date">{relativeTime(stamp)}</span>
          <span class="note-row-excerpt">
            {snippet ? (
              <Highlight text={snippet} terms={hl} />
            ) : (
              entry.excerpt || 'No additional text'
            )}
          </span>
        </span>
      </span>
      <span class="note-row-badges">
        {entry.pinned && <IconPin />}
        {!thumb && entry.embeds.length > 0 && <IconImage />}
      </span>
      {thumb && <img class="note-row-thumb" src={thumb} alt="" loading="lazy" />}
    </button>
  )

  return (
    <SwipeRow
      id={entry.path}
      actions={[
        { label: 'Move', onSelect: () => openMoveMenu(entry) },
        {
          label: 'Delete',
          danger: true,
          onSelect: async () => {
            await deleteNote(entry.path)
            if (activePath.value === entry.path) activePath.value = undefined
            notify(`Moved "${entry.title}" to Deleted`)
          },
        },
      ]}
    >
      {row}
    </SwipeRow>
  )
}

/**
 * The folder picker, as a second menu rather than a dialog: it reuses the same
 * sheet on touch, so moving a note is two taps in the same place.
 */
function openMoveMenu(entry: NoteIndexEntry) {
  const folders = ['', ...allFolderPaths.value].filter((p) => p !== entry.folder)
  if (!folders.length) {
    notify('There are no other folders yet')
    return
  }
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
      /*
       * One item, two behaviours, and the label says which you are getting:
       * a phone opens the share sheet — the only way from here into Mail —
       * and everything else saves the file.
       */
      label: canShareFiles() ? 'Share…' : 'Export as Markdown',
      separated: true,
      onSelect: () => shareNote(entry.path),
    },
    {
      label: folders.length ? 'Move to…' : 'Move to… (no other folders)',
      disabled: !folders.length,
      separated: true,
      onSelect: () => openMoveMenu(entry),
    },
    {
      label: 'Delete',
      danger: true,
      separated: true,
      onSelect: async () => {
        await deleteNote(entry.path)
        if (activePath.value === entry.path) activePath.value = undefined
        notify(`Moved "${entry.title}" to Deleted`)
      },
    },
  ]
}

/**
 * The one thing a day filter is missing: a way to write *about* that day.
 *
 * The palette has had "open today's note" all along, but only for today, and
 * only if you know the palette. Sitting at the top of a day's list it reads as
 * what it is — the note this day doesn't have yet — and it disappears the
 * moment the day has one.
 */
function DailyNoteRow({ day }: { day: number }) {
  return (
    <button class="daily-row" onClick={() => void openDailyNote(day)}>
      <IconPlus size={14} />
      <span>Create daily note</span>
      <span class="daily-row-name">{ymd(day)}.md</span>
    </button>
  )
}

export function NoteList({ children }: { children?: preact.ComponentChildren }) {
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
    await newNoteInFolder(folder, 'Untitled', { seed: body })
  }

  // A Tag Folder set to gather tasks shows tasks here instead of notes.
  const taskFolder = s.kind === 'smart' && showsTasks(smartFolderById(s.id))

  // The day a "create daily note" row would be for, when there isn't one yet.
  const dayNeedingDaily =
    s.kind === 'day' && !query.value && !dailyNoteFor(startOfDay(s.date))
      ? startOfDay(s.date)
      : undefined

  /*
   * Searching renames the header, because the old one was a lie: the list
   * underneath is a handful of results and the header went on saying "All
   * Notes". It names what is being searched rather than just saying "Search",
   * since that is the one thing the screen otherwise never states — the
   * placeholder said it, and the placeholder is gone the moment you type.
   */
  const kind = searchKind.value
  const title = searching.value ? `Search ${searchLabel(kind)}` : scopeLabel(s)

  return (
    <div class="pane list-pane">
      <div class="pane-head">
        {!compact && (
          <button class="icon-btn" onClick={toggleSidebar} title="Toggle sidebar (⌘\)">
            <IconSidebar />
          </button>
        )}
        <span class={compact ? 'pane-title pane-title-lg' : 'pane-title'}>
          {compact && !searching.value ? 'Notes' : title}
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
            placeholder={`Search ${searchLabel(kind)}`}
            value={query.value}
            onInput={(e) => (query.value = (e.target as HTMLInputElement).value)}
            aria-label={`Search ${searchLabel(kind)}`}
          />
          {query.value && (
            <button class="icon-btn" style={{ width: 18, height: 18 }} onClick={() => (query.value = '')}>
              <IconClose size={13} />
            </button>
          )}
        </div>
      </div>

      {compact && <MobileScopeBar />}

      {/*
        * A search filters the list that is here; it never replaces it. Typing
        * in Files used to swap the whole pane for note results, so the one
        * thing you could not do from the Files browser was find a file.
        */}
      <div class="list-scroll" ref={scrollRef}>
        {s.kind === 'trash' ? (
          <TrashView />
        ) : s.kind === 'files' ? (
          <FilesView />
        ) : s.kind === 'unlinked' ? (
          <UnlinkedView />
        ) : s.kind === 'tasks' ? (
          /*
           * The Tasks row lists tasks, not the notes that happen to contain
           * them: it counts tasks in the sidebar, and a list of note titles is
           * one click short of what the count promised.
           */
          <TasksPanel
            query={query.value}
            empty={
              <>
                Type <code>- [ ]</code> in any note to add a task. Every one in the vault turns up
                here.
              </>
            }
          />
        ) : taskFolder ? (
          /*
           * A Tag Folder that gathers tasks puts them here, where its notes
           * would otherwise be. The same rows the rail and the phone's Tasks
           * tab use, so a task is the same thing to tick and to date wherever
           * it turns up.
           */
          <TasksPanel
            items={tasksForSmartFolder(s.kind === 'smart' ? s.id : '')}
            query={query.value}
            empty={<>No tasks match this folder’s rule yet.</>}
          />
        ) : visibleNotes.value.length === 0 ? (
          <>
            {dayNeedingDaily !== undefined && <DailyNoteRow day={dayNeedingDaily} />}
            <div class="empty">
              {query.value ? (
                <>No notes match “{query.value}”.</>
              ) : s.kind === 'day' ? (
                <>Nothing filed under this day yet.</>
              ) : (
                <>
                  Nothing here yet.
                  <br />
                  Press ⌘N to start a note.
                </>
              )}
            </div>
          </>
        ) : (
          <>
            {dayNeedingDaily !== undefined && <DailyNoteRow day={dayNeedingDaily} />}
            {sections.value.map((sec) => (
              <div key={sec.title}>
                {sec.title && <div class="section-label">{sec.title}</div>}
                {sec.items.map((n) => (
                  <NoteRow key={n.path} entry={n} />
                ))}
              </div>
            ))}
          </>
        )}
      </div>
      {/* The pane's own resize handle, mounted by the shell. */}
      {children}
    </div>
  )
}

/** Restore one deleted thing and open it where it lands. */
async function restoreItem(path: string) {
  const p = await restoreFromTrash(path)
  openNote(p)
  notify('Restored')
}

/** Permanently delete one deleted thing, after asking. */
async function purgeItem(path: string) {
  const name = trashTitle(path)
  if (!confirm(`Permanently delete "${name}"? This cannot be undone.`)) return
  if (activePath.value === path) activePath.value = undefined
  await purge(path)
  notify(`Deleted "${name}" for good`)
}

/** Actions on a deleted note or file, shared by the menu and the swipe. */
function trashMenu(f: { path: string }): MenuItem[] {
  return [
    { label: 'Restore', onSelect: () => restoreItem(f.path) },
    {
      label: 'Delete permanently',
      danger: true,
      separated: true,
      onSelect: () => purgeItem(f.path),
    },
  ]
}

/**
 * One row in Deleted.
 *
 * The same shape as a note row and a file row — title, date, preview, and a
 * thumbnail when there is an image to show — rather than the two-line variant
 * with its own Restore and Delete buttons it used to be. The buttons are gone:
 * right-click gives the menu on a pointer, a swipe gives the same two actions
 * on touch, and both were already here doing the job.
 *
 * Its own component so `useLongPress` sits at a stable hook position as the
 * list shortens under it.
 */
function TrashRow({ f }: { f: VaultFile }) {
  const name = trashTitle(f.path)
  const url = mediaClass(f.path) === 'image' ? attachmentUrl(f.path) : undefined
  const longPress = useLongPress(
    () => trashMenu(f),
    () => name,
  )

  return (
    <SwipeRow
      id={f.path}
      actions={[
        { label: 'Restore', onSelect: () => restoreItem(f.path) },
        { label: 'Delete', danger: true, onSelect: () => purgeItem(f.path) },
      ]}
    >
      {/*
        * A deleted note you cannot read is a deleted note you cannot decide
        * about, so the row opens it — read-only in the editor, or in the
        * lightbox when what was deleted was a file rather than a note.
        */}
      <button
        class="note-row"
        aria-current={activePath.value === f.path}
        onClick={() => (f.kind === 'attachment' ? (lightboxPath.value = f.path) : openNote(f.path))}
        onContextMenu={(e) => {
          e.preventDefault()
          openMenu(e, trashMenu(f), name)
        }}
        {...longPress}
      >
        <span class="note-row-main">
          <span class="note-row-title">
            <Highlight text={name} terms={queryTerms.value} />
          </span>
          <span class="note-row-sub">
            <span class="note-row-date">{relativeTime(f.mtime)}</span>
            <span class="note-row-excerpt">
              <Highlight
                text={(f.text !== undefined ? excerptOf(f.text) : '') || formatBytes(f.size)}
                terms={queryTerms.value}
              />
            </span>
          </span>
        </span>
        {url && <img class="note-row-thumb" src={url} alt="" loading="lazy" />}
      </button>
    </SwipeRow>
  )
}

function TrashView() {
  const items = trashList.value
  const q = searching.value
  if (!items.length)
    return <div class="empty">{q ? <>Nothing deleted matches “{query.value}”.</> : 'Nothing deleted.'}</div>
  return (
    <>
      <div class="section-label section-label-row">
        <span>
          {q ? `${items.length} found` : `${items.length} deleted item${items.length === 1 ? '' : 's'}`}
        </span>
        {/*
          * Emptying it is the one action about the whole list rather than
          * about a row, so it lives on the list's own header — and it is
          * spelled out, because the confirm is the only thing standing between
          * a stray tap and everything in here.
          *
          * It goes away during a search. "Empty Trash" over a filtered list
          * either means the wrong thing or does it, and neither is a button
          * worth having.
          */}
        {!q && (
        <button
          class="list-action list-action-danger"
          onClick={async () => {
            if (
              !confirm(
                `Permanently delete all ${items.length} item${items.length === 1 ? '' : 's'}? This cannot be undone.`,
              )
            )
              return
            if (activePath.value && items.some((f) => f.path === activePath.value))
              activePath.value = undefined
            const n = await emptyTrash()
            notify(`Deleted ${n} item${n === 1 ? '' : 's'} for good`)
          }}
        >
          Empty Trash
        </button>
        )}
      </div>
      {items.map((f) => (
        <TrashRow key={f.path} f={f} />
      ))}
    </>
  )
}

/** Rename a file, and with it every reference to the file. */
function renameFilePrompt(path: string) {
  openPrompt({
    title: 'Rename file',
    label: 'Name',
    value: basename(path),
    confirm: 'Rename',
    hint: 'Every note that uses this file is updated to point at the new name.',
    onSubmit: async (next) => {
      const dest = await renameAttachment(path, next)
      if (dest !== path) notify(`Renamed to ${basename(dest)}`)
    },
  })
}

/** Actions on a file, shared by right-click, long-press and the swipe. */
function fileMenu(f: { path: string }): MenuItem[] {
  const name = basename(f.path)
  return [
    { label: 'Open', onSelect: () => (lightboxPath.value = f.path) },
    { label: 'Rename…', onSelect: () => renameFilePrompt(f.path) },
    {
      label: 'Copy path',
      onSelect: async () => {
        try {
          await navigator.clipboard.writeText(f.path)
          notify('Path copied')
        } catch {
          notify('Could not copy the path', 'error')
        }
      },
    },
    {
      label: 'Delete',
      danger: true,
      separated: true,
      onSelect: async () => {
        await deleteFile(f.path)
        notify(`Moved ${name} to Deleted`)
      },
    },
  ]
}

function FileRow({ f, orphan }: { f: VaultFile; orphan: boolean }) {
  const kind = mediaClass(f.path)
  const url = kind === 'image' ? attachmentUrl(f.path) : undefined
  const longPress = useLongPress(
    () => fileMenu(f),
    () => basename(f.path),
  )
  const actions: SwipeAction[] = [
    { label: 'Rename', onSelect: () => renameFilePrompt(f.path) },
    {
      label: 'Delete',
      danger: true,
      onSelect: async () => {
        await deleteFile(f.path)
        notify(`Moved ${basename(f.path)} to Deleted`)
      },
    },
  ]

  return (
    <SwipeRow id={f.path} actions={actions}>
      <button
        class="note-row"
        data-orphan={orphan ? '1' : '0'}
        onClick={() => (lightboxPath.value = f.path)}
        onContextMenu={(e) => {
          e.preventDefault()
          openMenu(e, fileMenu(f), basename(f.path))
        }}
        {...longPress}
      >
        <span class="note-row-main">
          <span class="note-row-title">
            <Highlight text={basename(f.path)} terms={queryTerms.value} />
          </span>
          <span class="note-row-sub">
            {/*
              * A date where a note row and a deleted row both put one. The
              * media kind moves into the preview line beside the size and the
              * path, which is where the rest of the file's details already are.
              */}
            <span class="note-row-date">{relativeTime(f.mtime)}</span>
            {orphan && (
              <span class="orphan-tag" title="No note references this file">
                Orphaned
              </span>
            )}
            <span class="note-row-excerpt">
              {kind} · {formatBytes(f.size)} ·{' '}
              <Highlight text={f.path} terms={queryTerms.value} />
            </span>
          </span>
        </span>
        {url && <img class="note-row-thumb" src={url} alt="" loading="lazy" />}
      </button>
    </SwipeRow>
  )
}

function FilesView() {
  const all = fileList.value
  const q = searching.value
  const orphans = orphanFiles.value
  // The filter turns itself off once there is nothing left to work through,
  // rather than leaving the browser looking empty.
  const only = orphansOnly.value && orphans.size > 0
  const items = only ? all.filter((f) => orphans.has(f.path)) : all

  if (!all.length)
    return q ? (
      <div class="empty">No files match “{query.value}”.</div>
    ) : (
      <div class="empty">
        No files yet.
        <br />
        Paste or drop an image, PDF or video into a note.
      </div>
    )
  return (
    <>
      <div class="section-label section-label-row">
        <span>
          {q
            ? `${items.length} found`
            : only
              ? `${items.length} of ${all.length} files`
              : `${all.length} file${all.length === 1 ? '' : 's'}`}
        </span>
        {orphans.size > 0 && (
          <button
            class="list-action"
            aria-pressed={only}
            title={
              only
                ? 'Show every file again'
                : 'Show only files that no note references — safe to delete, or worth linking somewhere'
            }
            onClick={() => (orphansOnly.value = !only)}
          >
            {orphans.size} orphaned
          </button>
        )}
      </div>
      {items.map((f) => (
        <FileRow key={f.path} f={f} orphan={orphans.has(f.path)} />
      ))}
    </>
  )
}

function UnlinkedView() {
  const items = unlinkedList.value
  const q = searching.value
  if (!items.length)
    return (
      <div class="empty">
        {q ? <>No unlinked mentions match “{query.value}”.</> : 'Every link resolves. Nice.'}
      </div>
    )
  return (
    <>
      <div class="section-label">
        {q ? `${items.length} found` : 'Links pointing at notes that don’t exist yet'}
      </div>
      {items.map(([target, sources]) => (
        <div key={target} class="note-row" style={{ cursor: 'default' }}>
          <span class="note-row-main">
            <span class="note-row-title">
              <Highlight text={target} terms={queryTerms.value} />
            </span>
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
                await newNoteInFolder('', target, { fallback: `# ${target}\n\n` })
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
