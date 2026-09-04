/**
 * The phone shell.
 *
 * One tab visible at a time with a bottom pill bar, and the editor pushed over
 * the top of whichever tab you came from. Opening a note from Tasks and backing
 * out returns you to Tasks, not to the note list — the tab is the place you
 * were, and the editor is a layer above it.
 */

import { attachments, contentNotes, tasks, trashItems, unresolvedLinks } from '../core/vault'
import {
  smartFolderById,
  smartFolderList,
  smartFolderCounts,
  folderTree,
  type FolderNode,
} from '../core/folders'
import { settings } from '../core/settings'
import { status, sync } from '../core/sync'
import {
  activePath,
  mobileEditorOpen,
  mobileTab,
  scope,
  scopeLabel,
  setScope,
  settingsOpen,
  type MobileTab,
  type Scope,
} from './state'
import { CalendarPanel, DayNotesPanel, TasksPanel } from './RightRail'
import { openTagFolderDialog } from './TagFolderDialog'
import {
  IconCalendar,
  IconCheck,
  IconChevron,
  IconDots,
  IconFolder,
  IconLink,
  IconNewNote,
  IconNotes,
  IconPaperclip,
  IconPlus,
  IconSettings,
  IconSync,
  IconTag,
  IconTrash,
} from './Icons'
import { newNoteInFolder } from './EditorPane'

const TABS: Array<{ id: MobileTab; label: string; icon: preact.ComponentChildren }> = [
  { id: 'notes', label: 'Notes', icon: <IconNotes size={21} /> },
  { id: 'tasks', label: 'Tasks', icon: <IconCheck size={21} /> },
  { id: 'calendar', label: 'Calendar', icon: <IconCalendar size={21} /> },
  { id: 'more', label: 'More', icon: <IconDots size={21} /> },
]

export function MobileNav() {
  const openTasks = tasks.value.filter((t) => !t.done).length
  return (
    <nav class="tabbar" role="tablist" aria-label="Sections">
      {TABS.map((t) => (
        <button
          key={t.id}
          class="tabbar-item"
          role="tab"
          aria-selected={mobileTab.value === t.id}
          onClick={() => {
            // Tapping the current tab scrolls its list back to the top.
            if (mobileTab.value === t.id) {
              document.querySelector('.mobile-view .list-scroll, .mobile-view .rail-scroll')?.scrollTo({ top: 0, behavior: 'smooth' })
            }
            mobileTab.value = t.id
            if (t.id === 'notes' && scope.value.kind === 'day') setScope({ kind: 'all' })
          }}
        >
          <span class="tabbar-icon">
            {t.icon}
            {t.id === 'tasks' && openTasks > 0 && <span class="tabbar-badge">{openTasks > 99 ? '99+' : openTasks}</span>}
          </span>
          <span class="tabbar-label">{t.label}</span>
        </button>
      ))}
    </nav>
  )
}

/* ------------------------------------------------------------ tasks screen */

export function MobileTasks() {
  return (
    <div class="mobile-view">
      <div class="mobile-head">
        <h1>Tasks</h1>
        <span class="spacer" />
        <button
          class="icon-btn"
          onClick={() => void newNoteInFolder('', 'Untitled', { seed: '- [ ] ' })}
          aria-label="New task note"
        >
          <IconNewNote size={19} />
        </button>
      </div>
      <div class="rail-scroll">
        <TasksPanel />
      </div>
    </div>
  )
}

/* --------------------------------------------------------- calendar screen */

export function MobileCalendar() {
  return (
    <div class="mobile-view">
      <div class="mobile-head">
        <h1>Calendar</h1>
      </div>
      <div class="rail-scroll">
        <CalendarPanel big />
        <DayNotesPanel />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------- more screen */

function MoreRow({
  icon,
  label,
  count,
  onClick,
  indent = 0,
}: {
  icon: preact.ComponentChildren
  label: preact.ComponentChildren
  count?: number
  onClick: () => void
  indent?: number
}) {
  return (
    <button class="more-row" style={{ paddingLeft: `${16 + indent * 16}px` }} onClick={onClick}>
      <span class="more-icon">{icon}</span>
      <span class="more-label">{label}</span>
      {count !== undefined && count > 0 && <span class="more-count">{count}</span>}
      <IconChevron size={13} />
    </button>
  )
}

function flattenFolders(node: FolderNode, depth = 0): Array<{ node: FolderNode; depth: number }> {
  const out: Array<{ node: FolderNode; depth: number }> = []
  for (const c of node.children) {
    out.push({ node: c, depth })
    out.push(...flattenFolders(c, depth + 1))
  }
  return out
}

export function MobileMore() {
  const go = (s: Scope) => {
    setScope(s)
    mobileTab.value = 'notes'
  }
  const st = status.value
  const folders = flattenFolders(folderTree.value)
  const counts = smartFolderCounts.value

  return (
    <div class="mobile-view">
      <div class="mobile-head">
        <h1>More</h1>
        <span class="spacer" />
        <button class="icon-btn" onClick={() => (settingsOpen.value = true)} aria-label="Settings">
          <IconSettings size={19} />
        </button>
      </div>

      <div class="more-scroll">
        <div class="more-group">
          <MoreRow
            icon={<IconNotes size={17} />}
            label="All Notes"
            count={contentNotes.value.length}
            onClick={() => go({ kind: 'all' })}
          />
          <MoreRow
            icon={<IconPaperclip size={17} />}
            label="Files"
            count={attachments.value.length}
            onClick={() => go({ kind: 'files' })}
          />
          {unresolvedLinks.value.size > 0 && (
            <MoreRow
              icon={<IconLink size={17} />}
              label="Unlinked mentions"
              count={unresolvedLinks.value.size}
              onClick={() => go({ kind: 'unlinked' })}
            />
          )}
          <MoreRow
            icon={<IconTrash size={17} />}
            label="Deleted"
            count={trashItems().length}
            onClick={() => go({ kind: 'trash' })}
          />
        </div>

        <div class="more-group">
          <div class="more-group-label">Tag Folders</div>
          {smartFolderList.value.map((n) => (
            <MoreRow
              key={n.folder.id}
              icon={<span class="side-emoji">{n.folder.icon ?? '🏷️'}</span>}
              label={n.folder.name}
              count={counts.get(n.folder.id)}
              indent={n.depth}
              onClick={() => go({ kind: 'smart', id: n.folder.id })}
            />
          ))}
          <MoreRow
            icon={<IconPlus size={17} />}
            label="New Tag Folder…"
            onClick={() => openTagFolderDialog()}
          />
        </div>

        {folders.length > 0 && (
          <div class="more-group">
            <div class="more-group-label">Folders</div>
            {folders.map(({ node, depth }) => (
              <MoreRow
                key={node.path}
                icon={<IconFolder size={17} />}
                label={node.name}
                count={node.count}
                indent={depth}
                onClick={() => go({ kind: 'folder', path: node.path })}
              />
            ))}
          </div>
        )}

        {tasks.value.length > 0 && (
          <div class="more-group">
            <div class="more-group-label">Tags</div>
            <div class="tag-cloud" style={{ padding: '4px 14px 10px' }}>
              {[...new Set(contentNotes.value.flatMap((n) => n.tags))].sort().map((t) => (
                <button key={t} class="tag-chip" onClick={() => go({ kind: 'tag', tag: t })}>
                  <IconTag size={11} />
                  {t}
                </button>
              ))}
            </div>
          </div>
        )}

        <div class="more-group">
          <div class="more-group-label">Sync</div>
          <button class="more-row" onClick={() => void sync()}>
            <span class="more-icon">
              <IconSync size={17} />
            </span>
            <span class="more-label">
              {settings.value.backend === 'none' ? 'Set up sync' : 'Sync now'}
              <small>{st.detail ?? 'Saved on this device'}</small>
            </span>
          </button>
          <MoreRow
            icon={<IconSettings size={17} />}
            label="Settings"
            onClick={() => (settingsOpen.value = true)}
          />
        </div>

        <p class="more-footer">Slate · {contentNotes.value.length} notes</p>
      </div>
    </div>
  )
}

/** Shown above the note list on a phone so the current filter is obvious. */
export function MobileScopeBar() {
  const s = scope.value
  if (s.kind === 'all') return null
  // A Tag Folder is a saved rule, and the phone had nowhere to see or change
  // that rule: the sidebar it lives in on a desktop isn't on screen here.
  const folder = s.kind === 'smart' ? smartFolderById(s.id) : undefined
  return (
    <div class="scope-bar">
      <span>{scopeLabel(s)}</span>
      {folder && (
        <button onClick={() => openTagFolderDialog(folder)} aria-label={`Edit ${folder.name}`}>
          Edit
        </button>
      )}
      <button
        onClick={() => {
          setScope({ kind: 'all' })
        }}
        aria-label={`Close ${scopeLabel(s)}`}
      >
        Close
      </button>
    </div>
  )
}

export function isEditorFullScreen(): boolean {
  return mobileEditorOpen.value && !!activePath.value
}
