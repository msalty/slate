import { useEffect } from 'preact/hooks'
import { Sidebar } from './Sidebar'
import { NoteList } from './NoteList'
import { EditorPane, newNoteInFolder } from './EditorPane'
import { RightRail } from './RightRail'
import { CommandPalette } from './CommandPalette'
import { Settings } from './Settings'
import { VersionHistory } from './VersionHistory'
import { Lightbox } from './Lightbox'
import { ContextMenu } from './Menu'
import { TagFolderDialog } from './TagFolderDialog'
import { LinkDialog } from './LinkDialog'
import { FilePicker } from './FilePicker'
import { NotePicker } from './NotePicker'
import { PromptDialog } from './PromptDialog'
import { ConfirmDialog } from './ConfirmDialog'
import { TranscribeDialog } from './TranscribeDialog'
import { TransformDialog, canTransform, openTransform } from './TransformDialog'
import { SummaryDialog } from './SummaryDialog'
import { AskDialog } from './AskDialog'
import { PaneResizer } from './PaneResizer'
import { editLinkAtCaret, handleUriClick } from './linkActions'
import { openDueMenu } from './DueMenu'
import { onTableBandRequest } from './tableMenu'
import { applyDue } from '../editor/due'
import { MobileCalendar, MobileMore, MobileNav, MobileTasks } from './Mobile'
import { QuickAdd, closeQuickAdd, openQuickAdd, quickAddOpen } from './QuickAdd'
import { clearedSearch, parseLaunchIntent } from '../core/capture'
import { settings, update } from '../core/settings'
import { connectBackend } from '../app/backend'
import { recentConflicts, recentFailures, status, sync } from '../core/sync'
import {
  folderConnected,
  folderName,
  folderNeedsPermission,
  folderStatus,
  folderSync,
  reconnectFolder,
} from '../core/foldersync'
import { ready, resolveLink } from '../core/vault'
import {
  activePath,
  closeMobileEditor,
  editorMaximized,
  historyOpen,
  lightboxPath,
  mobileEditorOpen,
  mobileTab,
  nextEditorMode,
  notify,
  openDailyNote,
  openNote,
  paletteOpen,
  propertiesOpen,
  scope,
  setScope,
  settingsOpen,
  visibleNotes,
} from './state'
import { Toaster } from './Toast'
import { installMirror, resumePopouts } from './popout'
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
import { relativeTime, startOfDay } from '../core/util'
import { IconFolder, IconSettings, IconSync, IconWarn } from './Icons'

export function App() {
  const s = settings.value
  const mode = layoutMode.value
  /*
   * Focus mode: the note takes the window and every panel stands down. A phone
   * has nothing to hide — its editor is already the whole screen — so the flag
   * is only ever read outside compact, which is also why crossing a breakpoint
   * with it set restores the panels rather than losing the mode.
   */
  const zen = mode !== 'compact' && editorMaximized.value

  /* ---- layout ------------------------------------------------------ */
  useEffect(() => installLayoutWatcher(), [])
  useEffect(() => installKeyboardWatcher(), [])

  /*
   * Two ordinary tabs of the vault are the same arrangement as a popout and the
   * window that opened it: two copies of the app over one IndexedDB, each with
   * its own in-memory picture of every file. Without a word between them, a save
   * in one is invisible to the other, and the other's next write is made from
   * what it was holding before — so the mirror goes in wherever the app boots,
   * not only where a note has been popped out.
   *
   * Notes that were popped out before this window was reloaded are still out
   * there too, and this window has forgotten them; asking is a no-op in a
   * session that has never popped anything out.
   */
  useEffect(() => {
    installMirror()
    resumePopouts()
  }, [])

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
    s.folder.enabled,
    s.folder.pollSec,
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
        await newNoteInFolder('', target, { fallback: `# ${target}\n\n` })
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
    const onDue = (e: Event) => {
      const { x, y, pos, current } = (
        e as CustomEvent<{ x: number; y: number; pos: number; current?: number }>
      ).detail
      openDueMenu({ clientX: x, clientY: y }, current, (date) => applyDue(pos, date))
    }
    const onTag = (e: Event) => {
      setScope({ kind: 'tag', tag: (e as CustomEvent<{ tag: string }>).detail.tag })
      if (layoutMode.value === 'compact') {
        mobileTab.value = 'notes'
        closeMobileEditor()
      }
    }
    // Clicking a `$(property)` in the body: the same form the note's date
    // opens, asked for from the value that needs changing.
    const onProperties = () => (propertiesOpen.value = true)
    addEventListener('slate:properties', onProperties)
    addEventListener('slate:open-link', onLink)
    addEventListener('slate:lightbox', onLightbox)
    addEventListener('slate:open-tag', onTag)
    addEventListener('slate:uri', onUri)
    addEventListener('slate:link-dialog', onLinkDialog)
    addEventListener('slate:due', onDue)
    addEventListener('slate:table-band', onTableBandRequest)
    return () => {
      removeEventListener('slate:properties', onProperties)
      removeEventListener('slate:open-link', onLink)
      removeEventListener('slate:lightbox', onLightbox)
      removeEventListener('slate:open-tag', onTag)
      removeEventListener('slate:uri', onUri)
      removeEventListener('slate:link-dialog', onLinkDialog)
      removeEventListener('slate:due', onDue)
      removeEventListener('slate:table-band', onTableBandRequest)
    }
  }, [])

  /* ---- keyboard ----------------------------------------------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) {
        if (e.key !== 'Escape') return
        if (drawer.value) {
          closeDrawer()
          return
        }
        /*
         * Escape leaves focus mode — but only once the note has stopped being
         * written in. The editor answers Escape first by handing the caret
         * back (see EditorPane), and that same keypress must not also throw
         * the panels back up: one Escape puts the pen down, the next one
         * leaves. Anything with its own Escape — a dialog, the palette, the
         * lightbox — is likewise still busy with this one.
         */
        const inEditor = !!(e.target as HTMLElement | null)?.closest?.('.cm-editor')
        const dialog =
          paletteOpen.value || settingsOpen.value || historyOpen.value || !!lightboxPath.value
        if (editorMaximized.value && !inEditor && !dialog) editorMaximized.value = false
        return
      }
      const k = e.key.toLowerCase()

      if (k === 'k' && !e.shiftKey) {
        /*
         * From inside the editor too, which it did not used to be.
         *
         * ⌘K was the wikilink while writing and the palette everywhere else, so
         * the one shortcut for reaching anything in the app was the one
         * shortcut that did not work where people actually are. The wikilink
         * moved to ⌘⇧K; this is now unconditional.
         */
        e.preventDefault()
        paletteOpen.value = !paletteOpen.value
      } else if (k === 'n' && !e.shiftKey) {
        e.preventDefault()
        void newNoteInFolder(scope.value.kind === 'folder' ? scope.value.path : '')
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
      } else if (k === 'f' && e.shiftKey) {
        // Nothing to maximise on a phone, where the editor is the screen.
        if (layoutMode.value === 'compact') return
        e.preventDefault()
        editorMaximized.value = !editorMaximized.value
      } else if (k === 'u' && e.shiftKey) {
        /*
         * Reached from inside the editor, unlike ⌘K — which is the point. It
         * acts on the selection, so the caret is necessarily in the text and
         * the hand is on the keyboard that just made it.
         */
        if (!canTransform()) return
        e.preventDefault()
        openTransform()
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])

  /* ---- what the URL asked for on the way in ------------------------- */
  /*
   * A launcher shortcut, the Android share sheet, or an iOS Shortcut pointed
   * at the same URL. The parameters are cleared before anything is written, so
   * a reload — or a tab the browser restores tomorrow — cannot capture the
   * same line twice; that also makes this effect a no-op on every run after
   * the first, since there is then nothing left in the URL to parse.
   */
  useEffect(() => {
    if (!ready.value) return
    const intent = parseLaunchIntent(location.search)
    if (!intent) return
    history.replaceState(
      null,
      '',
      `${location.pathname}${clearedSearch(location.search)}${location.hash}`,
    )
    if (intent.kind === 'daily') void openDailyNote(startOfDay(Date.now()))
    else openQuickAdd({ mode: intent.mode, text: intent.text })
  }, [ready.value])

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
      // Innermost first: the capture sheet is over everything else, so Back
      // puts it away rather than leaving the app from underneath it.
      if (quickAddOpen.value) closeQuickAdd()
      else if (lightboxPath.value) lightboxPath.value = undefined
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
        data-zen={zen ? '1' : '0'}
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

      {/*
       * Files the last run could not carry. A sync that quietly gives up on
       * some of the vault while reporting success is worse than one that
       * fails outright, because nothing ever prompts anyone to look. They are
       * still pending and the next run retries them; this is so the retry is
       * not the only thing that knows.
       */}
      {recentFailures.value.length > 0 && (
        <div class="conflict-banner">
          <IconWarn size={14} />
          <span style={{ flex: 1 }}>
            {recentFailures.value.length} file
            {recentFailures.value.length === 1 ? '' : 's'} could not sync (
            {recentFailures.value[0].path}
            {recentFailures.value.length > 1 ? ' and others' : ''}). They are still saved here and
            will be tried again.
          </span>
          <button class="status-btn" onClick={() => void sync()}>
            Retry now
          </button>
          <button class="status-btn" onClick={() => (recentFailures.value = [])}>
            Dismiss
          </button>
        </div>
      )}

      {mode !== 'compact' && !zen && <StatusBar />}
      <CommandPalette />
      <Settings />
      <VersionHistory />
      <TagFolderDialog />
      <LinkDialog />
      <FilePicker />
      <NotePicker />
      <PromptDialog />
      <ConfirmDialog />
      <Lightbox />
      <TranscribeDialog />
      <TransformDialog />
      <SummaryDialog />
      <AskDialog />
      <ContextMenu />
      <QuickAdd />
      <Toaster />
    </>
  )
}

/**
 * The connected folder's corner of the status bar.
 *
 * Only ever one of three things: nothing at all, the folder's name, or a button
 * — because the one state a folder can get into that the app cannot fix for
 * itself is a lost permission, and the only way out of it is a click. Leaving
 * that to be discovered in Settings would mean a folder that has quietly
 * stopped keeping up with the vault and says so nowhere anybody is looking.
 */
function FolderStatus() {
  if (folderNeedsPermission.value) {
    return (
      <button
        class="status-btn"
        onClick={() => void reconnectFolder()}
        title={`Slate needs permission to use “${folderName.value}” again`}
      >
        <IconWarn size={11} style={{ verticalAlign: '-1px', marginRight: 4 }} />
        Reconnect “{folderName.value}”
      </button>
    )
  }
  if (!folderConnected.value) return null
  const fs = folderStatus.value
  return (
    <button
      class="status-btn"
      onClick={() => void folderSync()}
      title={fs.detail ?? `Connected to ${folderName.value}`}
    >
      <IconFolder size={11} style={{ verticalAlign: '-1px', marginRight: 4 }} />
      {folderName.value}
      {fs.pendingCount > 0 ? ` · ${fs.pendingCount}` : ''}
    </button>
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
      <FolderStatus />
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
