/**
 * ⌘K — jump to a note, go to a collection, or run a command.
 *
 * One box for all three, because in practice "open the note about X", "show me
 * the Work folder" and "sync now" are the same reflex, and a second shortcut to
 * remember is a shortcut nobody uses.
 *
 * Collections came last and matter most: until they were here, a folder or a
 * tag could only be reached by finding it in the sidebar, which is what obliged
 * the sidebar to list every one of them at all times. See ./places.
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { allTags, getEntry, getText, notes, search, type SearchHit } from '../core/vault'
import { scanHeadings, type Heading } from '../core/markdown'
import { dailyNoteFor } from '../core/daily'
import { sync } from '../core/sync'
import {
  folderConnected,
  folderName,
  folderNeedsPermission,
  folderSync,
  reconnectFolder,
} from '../core/foldersync'
import { activeVaultId, switchToVault, vaults } from '../core/vaults'
import { settings, update } from '../core/settings'
import { layoutMode, railState, sidebarState, toggleRail, toggleSidebar } from './layout'
import { canPopOut, openPopout } from './popout'
import {
  activePath,
  editorMaximized,
  editorModeLabel,
  goToScope,
  nextEditorMode,
  notify,
  openDailyNote,
  openNote,
  paletteOpen,
  paletteSeed,
  scope,
  scopeLabel,
  settingsOpen,
} from './state'
import {
  cappedPaletteNote,
  emptyPaletteMessage,
  matchPlaces,
  parsePaletteQuery,
  type Place,
} from './places'
import { folderTree, smartFolders } from '../core/folders'
import { matchesAll, relativeTime, searchTerms, startOfDay } from '../core/util'
import { newNoteInFolder } from './EditorPane'
import { canShareFiles, shareNote } from './shareNote'
import { openQuickAdd } from './QuickAdd'
import { openNewEvent } from './newEvent'
import { canTransform, openTransform } from './TransformDialog'
import { canSummarise, openSummary } from './SummaryDialog'
import { askAboutNote, openAsk } from './AskDialog'
import { canAsk } from '../app/ask'
import { claimEscape, useModalLayer } from './modal'

interface Cmd {
  id: string
  label: string
  hint?: string
  run: () => void | Promise<void>
}

/** One line of the palette, whichever of the four kinds it came from. */
type Row =
  | { kind: 'cmd'; cmd: Cmd }
  | { kind: 'place'; place: Place }
  | { kind: 'note'; path: string; title: string; sub: string }
  | { kind: 'heading'; heading: Heading }

function rowKey(row: Row): string {
  if (row.kind === 'cmd') return `cmd:${row.cmd.id}`
  if (row.kind === 'place') return row.place.id
  if (row.kind === 'heading') return `head:${row.heading.line}`
  return `note:${row.path}`
}

/**
 * The glyph in front of a row, saying what kind of thing it is before the
 * label is read. A Tag Folder shows the emoji its owner gave it — the same one
 * the sidebar shows, so the row is recognised rather than parsed.
 *
 * A heading shows the `#` it is written with — which is also the tag glyph,
 * and never beside one: `@` is a list of headings and nothing else, the same
 * way `#` is a list of tags and nothing else. What tells the levels apart is
 * the indent, because that is what a heading's level *means*.
 */
function rowGlyph(row: Row): string {
  if (row.kind === 'cmd') return '⌘'
  if (row.kind === 'note') return '›'
  if (row.kind === 'heading') return '#'
  if (row.place.kind === 'tag') return '#'
  if (row.place.kind === 'folder') return '/'
  return row.place.emoji ?? '🏷️'
}

function rowLabel(row: Row): string {
  if (row.kind === 'cmd') return row.cmd.label
  if (row.kind === 'place') return row.place.label
  if (row.kind === 'heading') return row.heading.text
  return row.title
}

function rowSub(row: Row): string {
  if (row.kind === 'cmd') return row.cmd.hint ?? ''
  if (row.kind === 'place') return row.place.sub
  if (row.kind === 'heading') return ''
  return row.sub
}

export function CommandPalette() {
  const { root } = useModalLayer(paletteOpen.value)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  /*
   * Whether the keyboard is currently driving the selection.
   *
   * While it is, the pointer is ignored entirely — and it has to be, because
   * an arrow key scrolls the list and scrolling slides a different row under a
   * pointer that never moved. The browser calls that `mouseenter` and reports
   * it exactly like a deliberate hover, so a palette that trusts hover has its
   * selection yanked to wherever the mouse happened to be left sitting: you
   * press ↓ three times, and Enter opens something else entirely.
   *
   * Only a real `mousemove` hands control back. A pointer that has not moved
   * has not expressed an opinion, whatever the event says.
   */
  const byKey = useRef(false)
  const open = paletteOpen.value

  useEffect(() => {
    // Also cleared on the way out, so a seed set while the palette happened to
    // be open cannot survive to prefill the *next* ⌘K with somebody else's `>`.
    if (!open) {
      paletteSeed.value = ''
      return
    }
    // Peeked rather than read, so consuming the seed here cannot re-run this.
    setQ(paletteSeed.peek())
    paletteSeed.value = ''
    setSel(0)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  /*
   * Follow the selection with the scroll.
   *
   * A palette is a keyboard instrument — ⌘K, type, arrow down, Enter — and a
   * bare `#` in a vault of sixty tags is far longer than the eight or so rows
   * that fit. Without this, ↓ walks the selection off the bottom of the box:
   * you cannot see what is selected, and Enter opens whatever it landed on.
   * `nearest` scrolls the least it can, so a row already on screen never
   * moves the list under you.
   */
  useEffect(() => {
    if (!byKey.current) return
    listRef.current
      ?.querySelector('[data-sel="1"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [sel])

  /* A new query is a new list, and it is read from the top. */
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0
  }, [q])

  // The day the calendar is filtered to, if it is filtered to one at all.
  const day = scope.value.kind === 'day' ? startOfDay(scope.value.date) : undefined

  /** The open note, for the commands that are about a note rather than a list. */
  const openEntry = activePath.value ? getEntry(activePath.value) : undefined

  const commands = useMemo<Cmd[]>(
    () => [
      {
        id: 'new',
        label: 'New note',
        hint: '⌘N',
        run: async () => {
          await newNoteInFolder(scope.value.kind === 'folder' ? scope.value.path : '')
        },
      },
      {
        id: 'quick-task',
        label: 'Quick add task',
        run: () => openQuickAdd({ mode: 'task' }),
      },
      {
        id: 'quick-note',
        label: 'Quick add note',
        run: () => openQuickAdd({ mode: 'note' }),
      },
      {
        id: 'share',
        label: canShareFiles() ? 'Share this note' : 'Export this note as Markdown',
        run: async () => {
          const path = activePath.value
          if (!path) {
            notify('Open a note first.', 'error')
            return
          }
          await shareNote(path)
        },
      },
      /*
       * The two AI commands are absent rather than disabled when no provider is
       * configured — the same rule the Transcribe button follows. A palette
       * that lists what you cannot do is a palette people scroll past.
       */
      ...(canTransform()
        ? ([
            {
              id: 'transform',
              label: 'Change the selected passage…',
              hint: '⌘⇧U',
              run: () => {
                openTransform()
              },
            },
          ] satisfies Cmd[])
        : []),
      ...(canAsk()
        ? ([
            {
              id: 'ask',
              label: 'Ask your notes…',
              run: () => openAsk(),
            },
          ] satisfies Cmd[])
        : []),
      /* Only with a note open, since it is a question about that note. */
      ...(canAsk() && openEntry
        ? ([
            {
              id: 'ask-note',
              label: `Ask about this note — ${openEntry.title}`,
              run: () => askAboutNote(openEntry.title),
            },
          ] satisfies Cmd[])
        : []),
      ...(canSummarise()
        ? ([
            {
              id: 'summarise',
              label: `Summarise these notes — ${scopeLabel(scope.value)}`,
              run: () => openSummary(),
            },
          ] satisfies Cmd[])
        : []),
      {
        id: 'new-event',
        label:
          day !== undefined && day !== startOfDay(Date.now())
            ? `New event on ${new Date(day).toLocaleDateString(undefined, {
                month: 'long',
                day: 'numeric',
              })}…`
            : 'New event…',
        run: () => openNewEvent(),
      },
      {
        id: 'daily',
        label: "Open today's note",
        run: () => openDailyNote(startOfDay(Date.now())),
      },
      // Any other day is reachable too, once the calendar is on it.
      ...(day !== undefined && day !== startOfDay(Date.now())
        ? [
            {
              id: 'daily-day',
              label: `${dailyNoteFor(day) ? 'Open' : 'Create'} the daily note for ${new Date(
                day,
              ).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}`,
              run: () => openDailyNote(day),
            },
          ]
        : []),
      { id: 'sync', label: 'Sync now', hint: '⌘S', run: () => void sync().then(() => notify('Sync finished')) },
      /*
       * A folder can end a session needing its permission handed back, and the
       * only way out of that is a click. The palette is a click, so it is one
       * of the ways out — the status bar being the one you cannot miss.
       */
      ...(folderNeedsPermission.value
        ? [
            {
              id: 'folder-reconnect',
              label: `Reconnect the folder “${folderName.value}”`,
              run: async () => {
                if (await reconnectFolder()) notify(`Reconnected to “${folderName.value}”.`)
                else notify('Permission was not granted, so the folder is still disconnected.', 'error')
              },
            },
          ]
        : []),
      ...(folderConnected.value
        ? [
            {
              id: 'folder-sync',
              label: `Check the folder “${folderName.value}” now`,
              run: () => void folderSync().then(() => notify('Folder checked')),
            },
          ]
        : []),
      /*
       * One row per other vault rather than a "switch vault" that opens a menu:
       * the palette is a place people type a name into, and "Work" is the name
       * they would type. Absent entirely with one vault, which is most of them.
       */
      ...vaults.value
        .filter((v) => v.id !== activeVaultId.value)
        .map((v) => ({
          id: `vault-${v.id}`,
          label: `Switch to ${v.name}`,
          run: () => void switchToVault(v.id),
        })),
      { id: 'settings', label: 'Open settings', hint: '⌘,', run: () => (settingsOpen.value = true) },
      {
        id: 'mode',
        label: `Editor mode: ${editorModeLabel(settings.value.editorMode)} — switch to ${editorModeLabel(
          nextEditorMode(settings.value.editorMode),
        ).toLowerCase()}`,
        hint: '⌘⇧M',
        run: () => update({ editorMode: nextEditorMode(settings.value.editorMode) }),
      },
      /*
       * All four of these are desktop ideas, and absent rather than disabled
       * below the breakpoint — the rule the AI commands and the Transcribe
       * button already follow. A phone's editor is the whole screen, it has no
       * second window to put a note in, and neither side panel exists there at
       * all: the compact layout does not render the rail, and the scrim that
       * dismisses a drawer is not rendered either, so a sidebar opened from
       * here would have covered the screen with no way to tap it away.
       *
       * Both panels go through the same toggle their shortcut uses and take
       * their label from what is on screen rather than from the setting.
       * Between 1180 and 1400 the rail is a drawer and `showRightRail` is not
       * what decides whether you can see it, so "Hide calendar" used to flip a
       * preference that changed nothing while ⌘⇧R — claimed by that very row
       * as its shortcut — opened the drawer properly.
       */
      ...(layoutMode.value === 'compact'
        ? []
        : [
            {
              id: 'sidebar',
              label: sidebarState.value === 'hidden' ? 'Show sidebar' : 'Hide sidebar',
              hint: '⌘\\',
              run: () => toggleSidebar(),
            },
            {
              id: 'rail',
              label: railState.value === 'hidden' ? 'Show calendar' : 'Hide calendar',
              hint: '⌘⇧R',
              run: () => toggleRail(),
            },
            {
              id: 'focus',
              label: editorMaximized.value ? 'Leave focus mode' : 'Focus mode',
              hint: '⌘⇧F',
              run: () => (editorMaximized.value = !editorMaximized.value),
            },
            ...(canPopOut()
              ? [
                  {
                    id: 'popout',
                    label: 'Open this note in a new window',
                    run: () => {
                      const path = activePath.value
                      if (!path) {
                        notify('Open a note first.', 'error')
                        return
                      }
                      if (!openPopout(path))
                        notify('Your browser blocked the new window. Allow pop-ups for Slate.', 'error')
                    },
                  },
                ]
              : []),
          ]),
      {
        id: 'theme',
        label: `Theme: ${settings.value.theme}`,
        run: () =>
          update({
            theme:
              settings.value.theme === 'system'
                ? 'light'
                : settings.value.theme === 'light'
                  ? 'dark'
                  : 'system',
          }),
      },
      /*
       * These two go through `goToScope` rather than `setScope` for the same
       * reason every collection row below does: on a phone the palette is over
       * the editor, and a scope change behind it is a command that appears to
       * have done nothing.
       */
      { id: 'all', label: 'Show All Notes', run: () => goToScope({ kind: 'all' }) },
      { id: 'tasks', label: 'Show Tasks', run: () => goToScope({ kind: 'tasks' }) },
      { id: 'trash', label: 'Show Deleted', run: () => goToScope({ kind: 'trash' }) },
      { id: 'files', label: 'Show all files', run: () => goToScope({ kind: 'files' }) },
    ],
    [
      settings.value,
      day,
      notes.value,
      scope.value,
      // Read at build time, not inside a `run` — the list has to change when
      // the open note does, or "Ask about this note" names the last one.
      activePath.value,
      editorMaximized.value,
      layoutMode.value,
      // Both panel rows are labelled from what is on screen, so they have to
      // be rebuilt when that changes and not only when the settings do.
      sidebarState.value,
      railState.value,
      folderConnected.value,
      folderNeedsPermission.value,
      folderName.value,
      vaults.value,
      activeVaultId.value,
    ],
  )

  /**
   * The open note's headings, read once per note rather than per keystroke.
   *
   * Scanning is a pass over one note's text, which is nothing — but it happens
   * on every render of a box being typed into, and `outline.length` is what
   * the empty message needs even when the filter has cut every row.
   */
  const outline = useMemo<Heading[]>(() => {
    const path = activePath.value
    const text = path ? getText(path) : undefined
    return text ? scanHeadings(text) : []
  }, [activePath.value, notes.value])

  const results = useMemo((): {
    matchedCommands: Cmd[]
    places: Place[]
    noteHits: SearchHit[]
    headings: Heading[]
    /** Set when the collection list is a sample rather than the whole answer. */
    capped?: string
  } => {
    const { mode, term } = parsePaletteQuery(q)
    const matching = (list: Cmd[]) =>
      term ? list.filter((c) => c.label.toLowerCase().includes(term.toLowerCase())) : list
    const none = { matchedCommands: [], places: [], noteHits: [], headings: [] }

    /*
     * `>` is the whole list, which is the only way to read it: a palette that
     * shows four of twenty commands until you already know the name of the one
     * you want is a palette you cannot learn anything from. Nothing is capped
     * and nothing else shares the list.
     */
    if (mode === 'commands') return { ...none, matchedCommands: matching(commands) }

    /*
     * `@` is the open note read as a table of contents, so nothing else shares
     * the list either — and `@` on its own is the whole outline, for the same
     * reason a bare `>` is the whole command list. Matched on the words with
     * the same every-term-has-to-land rule the rest of the app uses, so
     * "cost fl" finds "Flight costs".
     */
    if (mode === 'headings') {
      const terms = searchTerms(term)
      return { ...none, headings: outline.filter((h) => matchesAll(h.text, terms)) }
    }

    /*
     * `#` and `/` likewise say a collection is what's wanted, so notes and
     * commands stand aside — otherwise typing `/Work` would search every note
     * for the literal string and bury the folder it named.
     */
    const found = matchPlaces(q)
    const places = found.places
    if (mode === 'places') {
      return { ...none, places, capped: cappedPaletteNote(q, found) }
    }

    /*
     * Unprefixed, the commands stay a handful: this is the "find me a note"
     * box, and twenty commands above the notes would be the browsing list
     * turning up where nobody asked for it.
     */
    const matchedCommands = term ? matching(commands) : commands.slice(0, 4)
    const noteHits = term
      ? search(term, 30)
      : notes.value.slice(0, 12).map((entry) => ({ entry, score: 0, snippet: '' }))
    return { matchedCommands, places, noteHits, headings: [] }
  }, [q, commands, outline, notes.value, folderTree.value, smartFolders.value, allTags.value])

  const flat: Row[] = [
    ...results.matchedCommands.map((cmd) => ({ kind: 'cmd' as const, cmd })),
    /*
     * Above the notes, because a collection is the more precise answer to the
     * same word: with a folder called Work and thirty notes that say "work",
     * the folder is nearly always what was meant, and there are never enough
     * collections to push the notes off the screen.
     */
    ...results.places.map((place) => ({ kind: 'place' as const, place })),
    ...results.noteHits.map((h) => ({
      kind: 'note' as const,
      path: h.entry.path,
      title: h.entry.title,
      sub: h.snippet || h.entry.folder || relativeTime(h.entry.mtime),
    })),
    ...results.headings.map((heading) => ({ kind: 'heading' as const, heading })),
  ]

  if (!open) return null

  const choose = async (i: number) => {
    const item = flat[i]
    if (!item) return
    paletteOpen.value = false
    if (item.kind === 'cmd') await item.cmd.run()
    else if (item.kind === 'place') goToScope(item.place.target)
    /*
     * The note is already open — that is what made the outline — so this is
     * navigation within it. `align: 'start'` puts the heading at the top of
     * the pane, because the section it names is below it.
     */
    else if (item.kind === 'heading') {
      if (activePath.value) {
        openNote(activePath.value, { line: item.heading.line, align: 'start' })
      }
    } else openNote(item.path)
  }

  return (
    <div class="scrim" ref={root} onClick={() => (paletteOpen.value = false)}>
      <div class="palette" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <input
          ref={inputRef}
          value={q}
          /*
           * The placeholder is where the prefixes are taught, since there is
           * nowhere else they could be and they are no use unguessed.
           */
          placeholder="Search notes, #tags, /folders, @headings — or > for every command"
          aria-label="Search notes, tags, folders and this note's headings, or type a chevron for every command"
          onInput={(e) => {
            byKey.current = false
            setQ((e.target as HTMLInputElement).value)
            setSel(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              byKey.current = true
              setSel((s) => Math.min(flat.length - 1, s + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              byKey.current = true
              setSel((s) => Math.max(0, s - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              void choose(sel)
            } else if (e.key === 'Escape' && claimEscape(e)) {
              paletteOpen.value = false
            }
          }}
        />
        <div
          class="palette-list"
          ref={listRef}
          /*
           * One listener for the whole list rather than a hover on every row:
           * movement is the thing that selects, so the event that reports
           * movement is the one to read. `mouseenter` fires when the list
           * moves under a still pointer as readily as when the pointer moves
           * over the list, and cannot tell you which happened.
           */
          onMouseMove={(e) => {
            byKey.current = false
            const row = (e.target as HTMLElement).closest?.('.palette-row')
            const i = row ? Number((row as HTMLElement).dataset.i) : -1
            if (i >= 0 && i !== sel) setSel(i)
          }}
        >
          {flat.length === 0 && (
            <div class="empty" style={{ padding: '24px' }}>
              {emptyPaletteMessage(q, {
                noteOpen: !!activePath.value,
                total: outline.length,
              })}
            </div>
          )}
          {flat.map((item, i) => (
            <button
              key={rowKey(item)}
              class="palette-row"
              data-sel={i === sel ? '1' : '0'}
              data-i={i}
              /*
               * A heading's level, for the indent. On the row rather than on
               * the label so the whole row reads as nested — an indent that
               * starts after the glyph is a ragged left edge with a column of
               * hashes down it.
               */
              data-level={item.kind === 'heading' ? item.heading.level : undefined}
              /* Takes its own index, so a click is never about what is selected. */
              onClick={() => void choose(i)}
            >
              <span
                class="palette-glyph"
                style={{
                  // An emoji dimmed to 55% reads as a rendering fault rather
                  // than as a quieter glyph, so only the typographic ones dim.
                  opacity: item.kind === 'place' && item.place.kind === 'smart' ? 1 : 0.55,
                }}
              >
                {rowGlyph(item)}
              </span>
              {/*
                * A note stacks; a command and a collection do not.
                *
                * Their subtitles are short and fixed — a shortcut, "Folder ·
                * 12 notes" — and belong at the right-hand end where the eye
                * can run down them. A note's is a line lifted out of the note
                * itself, which is as long as it happens to be: sharing the row
                * with it truncated the title to a few characters, so the one
                * thing you were reading the row for was the one thing not on
                * it. Stacked, the title gets the full width and the line that
                * matched sits under it, where it confirms the title rather
                * than competing with it.
                */}
              {item.kind === 'note' ? (
                <span class="palette-stack">
                  <span class="palette-title">{rowLabel(item)}</span>
                  {rowSub(item) && <small class="palette-preview">{rowSub(item)}</small>}
                </span>
              ) : (
                <>
                  <span class="palette-label">{rowLabel(item)}</span>
                  <small>{rowSub(item)}</small>
                </>
              )}
            </button>
          ))}
          {/*
           * Below the rows and outside `flat`, so the arrows step past it and
           * Enter can never land on it: it is something the list is saying
           * about itself, not another thing to open.
           */}
          {results.capped && <div class="palette-note">{results.capped}</div>}
        </div>
      </div>
    </div>
  )
}
