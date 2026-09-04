/**
 * ⌘K — jump to a note or run a command.
 *
 * One box for both, because in practice "open the note about X" and "sync now"
 * are the same reflex, and a second shortcut to remember is a shortcut nobody
 * uses.
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { notes, search } from '../core/vault'
import { dailyNoteFor } from '../core/daily'
import { sync } from '../core/sync'
import { settings, update } from '../core/settings'
import {
  activePath,
  editorModeLabel,
  nextEditorMode,
  notify,
  openDailyNote,
  openNote,
  paletteOpen,
  scope,
  settingsOpen,
} from './state'
import { relativeTime, startOfDay } from '../core/util'
import { newNoteInFolder } from './EditorPane'
import { canShareFiles, shareNote } from './shareNote'

interface Cmd {
  id: string
  label: string
  hint?: string
  run: () => void | Promise<void>
}

export function CommandPalette() {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const open = paletteOpen.value

  useEffect(() => {
    if (open) {
      setQ('')
      setSel(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // The day the calendar is filtered to, if it is filtered to one at all.
  const day = scope.value.kind === 'day' ? startOfDay(scope.value.date) : undefined

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
      { id: 'settings', label: 'Open settings', hint: '⌘,', run: () => (settingsOpen.value = true) },
      {
        id: 'mode',
        label: `Editor mode: ${editorModeLabel(settings.value.editorMode)} — switch to ${editorModeLabel(
          nextEditorMode(settings.value.editorMode),
        ).toLowerCase()}`,
        hint: '⌘⇧M',
        run: () => update({ editorMode: nextEditorMode(settings.value.editorMode) }),
      },
      {
        id: 'rail',
        label: settings.value.showRightRail ? 'Hide calendar' : 'Show calendar',
        hint: '⌘⇧R',
        run: () => update({ showRightRail: !settings.value.showRightRail }),
      },
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
      { id: 'trash', label: 'Show Recently Deleted', run: () => (scope.value = { kind: 'trash' }) },
      { id: 'files', label: 'Show all files', run: () => (scope.value = { kind: 'files' }) },
    ],
    [settings.value, day, notes.value],
  )

  const results = useMemo(() => {
    const term = q.trim()
    const matchedCommands = commands.filter((c) =>
      c.label.toLowerCase().includes(term.toLowerCase()),
    )
    const noteHits = term
      ? search(term, 30)
      : notes.value.slice(0, 12).map((entry) => ({ entry, score: 0, snippet: '' }))
    return { matchedCommands: term ? matchedCommands : commands.slice(0, 4), noteHits }
  }, [q, commands, notes.value])

  const flat: Array<{ kind: 'cmd'; cmd: Cmd } | { kind: 'note'; path: string; title: string; sub: string }> =
    [
      ...results.matchedCommands.map((cmd) => ({ kind: 'cmd' as const, cmd })),
      ...results.noteHits.map((h) => ({
        kind: 'note' as const,
        path: h.entry.path,
        title: h.entry.title,
        sub: h.snippet || h.entry.folder || relativeTime(h.entry.mtime),
      })),
    ]

  if (!open) return null

  const choose = async (i: number) => {
    const item = flat[i]
    if (!item) return
    paletteOpen.value = false
    if (item.kind === 'cmd') await item.cmd.run()
    else {
      openNote(item.path)
    }
  }

  return (
    <div class="scrim" onClick={() => (paletteOpen.value = false)}>
      <div class="palette" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <input
          ref={inputRef}
          value={q}
          placeholder="Search notes or run a command…"
          aria-label="Search notes or run a command"
          onInput={(e) => {
            setQ((e.target as HTMLInputElement).value)
            setSel(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSel((s) => Math.min(flat.length - 1, s + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSel((s) => Math.max(0, s - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              void choose(sel)
            } else if (e.key === 'Escape') {
              paletteOpen.value = false
            }
          }}
        />
        <div class="palette-list">
          {flat.length === 0 && (
            <div class="empty" style={{ padding: '24px' }}>
              Nothing matches. Press Enter on “New note” to start one.
            </div>
          )}
          {flat.map((item, i) => (
            <button
              key={item.kind === 'cmd' ? item.cmd.id : item.path}
              class="palette-row"
              data-sel={i === sel ? '1' : '0'}
              onMouseEnter={() => setSel(i)}
              onClick={() => void choose(i)}
            >
              <span style={{ opacity: 0.55, width: 16, flex: '0 0 auto' }}>
                {item.kind === 'cmd' ? '⌘' : '›'}
              </span>
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  minWidth: 0,
                }}
              >
                {item.kind === 'cmd' ? item.cmd.label : item.title}
              </span>
              <small>{item.kind === 'cmd' ? (item.cmd.hint ?? '') : item.sub}</small>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
