import { useEffect } from 'preact/hooks'
import { Sidebar } from './Sidebar'
import { NoteList } from './NoteList'
import { EditorPane } from './EditorPane'
import { RightRail } from './RightRail'
import { CommandPalette } from './CommandPalette'
import { Settings } from './Settings'
import { VersionHistory } from './VersionHistory'
import { Lightbox } from './Lightbox'
import { ContextMenu } from './Menu'
import { TagFolderDialog } from './TagFolderDialog'
import { LinkDialog } from './LinkDialog'
import { PromptDialog } from './PromptDialog'
import { PaneResizer } from './PaneResizer'
import { editLinkAtCaret, handleUriClick } from './linkActions'
import { MobileCalendar, MobileMore, MobileNav, MobileTasks } from './Mobile'
import { settings, update } from '../core/settings'
import { connectBackend } from '../app/backend'
import { recentConflicts, status, sync } from '../core/sync'
import { createNote, ready, resolveLink } from '../core/vault'
import {
  activePath,
  closeMobileEditor,
  lightboxPath,
  mobileEditorOpen,
  mobileTab,
  nextEditorMode,
  notify,
  openNote,
  paletteOpen,
  scope,
  settingsOpen,
  toast,
  visibleNotes,
} from './state'
import {
  closeDrawer,
  drawer,
  installKeyboardWatcher,
  installLayoutWatcher,
  layoutMode,
  listInline,
  railState,
  sidebarState,
  toggleRail,
  toggleSidebar,
} from './layout'
import { relativeTime } from '../core/util'
import { IconSettings, IconSync, IconWarn } from './Icons'

export function App() {
  const s = settings.value
  const mode = layoutMode.value

  /* ---- layout ------------------------------------------------------ */
  useEffect(() => installLayoutWatcher(), [])
  useEffect(() => installKeyboardWatcher(), [])

  /* ---- theme ------------------------------------------------------- */
  useEffect(() => {
    const root = document.documentElement
    if (s.theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', s.theme)
    /*
     * Read the colour off the root element, which is where the theme tokens
     * resolve for the system chrome: Android colours the navigation bar from
     * the root background and the status bar from this meta tag, so taking
     * both from the same element is what keeps the two ends of the screen
     * agreeing with the app between them.
     *
     * Every tag, not the first one: index.html ships a light and a dark
     * theme-color, and the browser honours whichever one's media matches. An
     * in-app override is not a media query and cannot be expressed as one, so
     * the only way to be sure the tag that wins is the one carrying the theme
     * the user actually chose is for all of them to agree.
     */
    const apply = () => {
      const c = getComputedStyle(root).backgroundColor
      for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
        m.setAttribute('content', c)
      }
    }
    apply()
    /*
     * On 'system' the colour is the phone's to decide, and the phone can
     * change its mind while the app is open — sunset, or a scheduled dark
     * mode. The tokens follow that on their own through the media query; the
     * meta tag is a manual copy of them, so it has to be told.
     */
    if (s.theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [s.theme])

  /* ---- backend ----------------------------------------------------- */
  useEffect(() => {
    void connectBackend()
  }, [
    s.backend,
    s.webdav.url,
    s.webdav.username,
    s.webdav.password,
    s.webdav.root,
    s.gdrive.clientId,
    s.gdrive.folderName,
    s.autoSync,
    s.syncIntervalSec,
  ])

  /* ---- links, tags and embeds coming out of the editor -------------- */
  useEffect(() => {
    const onLink = async (e: Event) => {
      const { target, exists } = (e as CustomEvent<{ target: string; exists: boolean }>).detail
      const path = resolveLink(target)
      if (path) {
        openNote(path)
        return
      }
      if (!exists) {
        const p = await createNote('', target, `# ${target}\n\n`)
        openNote(p, { editing: true })
        notify(`Created "${target}"`)
      }
    }
    const onLightbox = (e: Event) => {
      lightboxPath.value = (e as CustomEvent<{ path: string }>).detail.path
    }
    const onUri = (e: Event) => {
      handleUriClick(
        (e as CustomEvent<Parameters<typeof handleUriClick>[0]>).detail,
      )
    }
    const onLinkDialog = () => editLinkAtCaret()
    const onTag = (e: Event) => {
      scope.value = { kind: 'tag', tag: (e as CustomEvent<{ tag: string }>).detail.tag }
      if (layoutMode.value === 'compact') {
        mobileTab.value = 'notes'
        closeMobileEditor()
      }
    }
    addEventListener('slate:open-link', onLink)
    addEventListener('slate:lightbox', onLightbox)
    addEventListener('slate:open-tag', onTag)
    addEventListener('slate:uri', onUri)
    addEventListener('slate:link-dialog', onLinkDialog)
    return () => {
      removeEventListener('slate:open-link', onLink)
      removeEventListener('slate:lightbox', onLightbox)
      removeEventListener('slate:open-tag', onTag)
      removeEventListener('slate:uri', onUri)
      removeEventListener('slate:link-dialog', onLinkDialog)
    }
  }, [])

  /* ---- keyboard ----------------------------------------------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) {
        if (e.key === 'Escape' && drawer.value) closeDrawer()
        return
      }
      const k = e.key.toLowerCase()

      if (k === 'k' && !e.shiftKey) {
        if ((e.target as HTMLElement)?.closest?.('.cm-editor')) return
        e.preventDefault()
        paletteOpen.value = !paletteOpen.value
      } else if (k === 'n' && !e.shiftKey) {
        e.preventDefault()
        void createNote(scope.value.kind === 'folder' ? scope.value.path : '').then((p) =>
          openNote(p, { editing: true }),
        )
      } else if (k === 's' && !e.shiftKey) {
        e.preventDefault()
        void sync()
      } else if (k === ',') {
        e.preventDefault()
        settingsOpen.value = true
      } else if (k === '\\') {
        e.preventDefault()
        toggleSidebar()
      } else if (k === 'r' && e.shiftKey) {
        e.preventDefault()
        toggleRail()
      } else if (k === 'm' && e.shiftKey) {
        e.preventDefault()
        update({ editorMode: nextEditorMode(settings.value.editorMode) })
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])

  /* ---- select something sensible on first load ---------------------- */
  useEffect(() => {
    if (!ready.value || activePath.value) return
    // Never auto-open a note on a phone: it would land the user in the editor
    // instead of their list.
    if (layoutMode.value !== 'compact') {
      const first = visibleNotes.value[0]
      if (first) activePath.value = first.path
    }
  }, [ready.value])

  /* ---- Android back button closes the editor before leaving the app -- */
  useEffect(() => {
    if (mode !== 'compact') return
    const onPop = () => {
      if (lightboxPath.value) lightboxPath.value = undefined
      else if (mobileEditorOpen.value) closeMobileEditor()
      history.pushState(null, '')
    }
    history.pushState(null, '')
    addEventListener('popstate', onPop)
    return () => removeEventListener('popstate', onPop)
  }, [mode])

  if (!ready.value) {
    return (
      <div class="empty" style={{ marginTop: '30vh' }}>
        Opening your vault…
      </div>
    )
  }

  const editorOverlay = mode === 'compact' && mobileEditorOpen.value && !!activePath.value

  return (
    <>
      <div
        class="shell"
        data-mode={mode}
        data-sidebar={sidebarState.value}
        data-rail={railState.value}
        data-list={listInline.value ? '1' : '0'}
        /*
         * The grid reads these; the resizers write them straight to the DOM
         * while dragging, so a resize costs one custom property, not a render.
         */
        style={{ '--sidebar-w': `${s.sidebarWidth}px`, '--list-w': `${s.listWidth}px` }}
      >
        {/* --- sidebar: inline on wide, a drawer otherwise --- */}
        {sidebarState.value !== 'hidden' && (
          <div class="pane sidebar" data-floating={sidebarState.value === 'floating' ? '1' : '0'}>
            <div class="pane-head">
              <span class="pane-title">Slate</span>
              <span class="spacer" />
              <button
                class="icon-btn"
                onClick={() => (settingsOpen.value = true)}
                title="Settings (⌘,)"
              >
                <IconSettings />
              </button>
            </div>
            <Sidebar />
            {sidebarState.value === 'inline' && (
              <PaneResizer
                variable="--sidebar-w"
                setting="sidebarWidth"
                min={170}
                max={420}
                fallback={232}
                label="Resize the sidebar"
              />
            )}
          </div>
        )}

        {/* --- the main columns --- */}
        {mode === 'compact' ? (
          <div class="mobile-stack">
            {mobileTab.value === 'notes' && <NoteList />}
            {mobileTab.value === 'tasks' && <MobileTasks />}
            {mobileTab.value === 'calendar' && <MobileCalendar />}
            {mobileTab.value === 'more' && <MobileMore />}
            <MobileNav />
            {editorOverlay && (
              <div class="editor-overlay">
                <EditorPane />
              </div>
            )}
          </div>
        ) : (
          <>
            <NoteList>
              <PaneResizer
                variable="--list-w"
                setting="listWidth"
                min={240}
                max={560}
                fallback={320}
                label="Resize the note list"
              />
            </NoteList>
            <EditorPane />
          </>
        )}

        {/* --- calendar rail: inline when there's room, a drawer otherwise --- */}
        {railState.value !== 'hidden' && mode !== 'compact' && (
          <div class="rail-host" data-floating={railState.value === 'floating' ? '1' : '0'}>
            <RightRail />
          </div>
        )}

        {/* --- one scrim for whichever drawer is open --- */}
        {drawer.value && mode !== 'compact' && (
          <div class="drawer-scrim" onClick={closeDrawer} aria-hidden="true" />
        )}
      </div>

      {recentConflicts.value.length > 0 && (
        <div class="conflict-banner">
          <IconWarn size={14} />
          <span style={{ flex: 1 }}>
            {recentConflicts.value.length} note
            {recentConflicts.value.length === 1 ? ' was' : 's were'} edited in two places. Both
            versions were kept.
          </span>
          <button
            class="status-btn"
            onClick={() => {
              openNote(recentConflicts.value[0])
              recentConflicts.value = []
            }}
          >
            Review
          </button>
          <button class="status-btn" onClick={() => (recentConflicts.value = [])}>
            Dismiss
          </button>
        </div>
      )}

      {mode !== 'compact' && <StatusBar />}
      <CommandPalette />
      <Settings />
      <VersionHistory />
      <TagFolderDialog />
      <LinkDialog />
      <PromptDialog />
      <Lightbox />
      <ContextMenu />
      {toast.value && (
        <div class="toast" data-kind={toast.value.kind} role="status">
          {toast.value.text}
        </div>
      )}
    </>
  )
}

function StatusBar() {
  const st = status.value
  const s = settings.value
  return (
    <div class="statusbar">
      <span class="status-dot" data-phase={st.phase} />
      <span class="status-text">
        {st.detail ?? (s.backend === 'none' ? 'Saved on this device' : 'Ready')}
        {st.lastSyncAt && st.phase === 'idle' ? ` · ${relativeTime(st.lastSyncAt)}` : ''}
      </span>
      {st.pendingCount > 0 && <span style={{ color: 'var(--accent)' }}>{st.pendingCount} pending</span>}
      <span style={{ flex: 1 }} />
      {s.backend === 'none' ? (
        <button class="status-btn" onClick={() => (settingsOpen.value = true)}>
          Set up sync
        </button>
      ) : (
        <button
          class="status-btn"
          onClick={() => void sync()}
          disabled={st.phase !== 'idle' && st.phase !== 'error' && st.phase !== 'offline'}
          title="Sync now (⌘S)"
        >
          <IconSync size={12} style={{ verticalAlign: '-2px', marginRight: 4 }} />
          {st.phase === 'idle' || st.phase === 'error' || st.phase === 'offline'
            ? 'Sync now'
            : `${Math.round((st.progress ?? 0) * 100)}%`}
        </button>
      )}
    </div>
  )
}
