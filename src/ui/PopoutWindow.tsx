/**
 * The window a popped-out note lives in.
 *
 * One note, the editor around it, and nothing else — no list, no sidebar, no
 * calendar, no command palette. Everything it does have is the same component
 * the app uses, so a note written here behaves exactly as it does in the pane
 * it came from: the same editor, the same menus, the same autosave.
 *
 * What it deliberately does *not* do is sync. The window that opened this one
 * has the backend connected and hears about every write through the mirror in
 * popout.ts; two sync engines reconciling one vault against one remote would be
 * a race with nothing to gain. A popout with no main window left open is still
 * safe — it saves to the same IndexedDB, and those writes go up the next time
 * the app itself is open.
 */

import { useEffect } from 'preact/hooks'
import { EditorPane, newNoteInFolder } from './EditorPane'
import { ContextMenu } from './Menu'
import { LinkDialog } from './LinkDialog'
import { PromptDialog } from './PromptDialog'
import { Lightbox } from './Lightbox'
import { VersionHistory } from './VersionHistory'
import { Toaster } from './Toast'
import { editLinkAtCaret, handleUriClick } from './linkActions'
import { openDueMenu } from './DueMenu'
import { applyDue } from '../editor/due'
import { adoptFromStorage, getEntry, ready, resolveLink, revision } from '../core/vault'
import { settings } from '../core/settings'
import { activePath, lightboxPath, notify, openNote } from './state'
import { compactAllowed, installLayoutWatcher, layoutMode } from './layout'
import { installMirror, reportHolding } from './popout'

/**
 * Everything that has to be true before the first paint, so the window opens on
 * the note rather than flashing an empty pane on the way to it. Called from
 * main.tsx, between loading the vault and rendering.
 */
export function preparePopout(path: string): void {
  // A window holding one note is a desktop window however narrow it is dragged.
  compactAllowed.value = false
  // Before anything is rendered: the first write here must not be the first
  // the other windows hear of this one.
  installMirror()
  activePath.value = path
}

export function PopoutWindow() {
  const path = activePath.value
  // Renames and edits landing from elsewhere both move this.
  const rev = revision.value
  const entry = path ? getEntry(path) : undefined

  /* ---- the window itself ------------------------------------------- */

  useEffect(() => installLayoutWatcher(), [])

  useEffect(() => {
    const root = document.documentElement
    if (settings.value.theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', settings.value.theme)
  }, [settings.value.theme])

  // The note's name on the window, where the app's name would tell you nothing:
  // three popped-out notes are three identical taskbar entries otherwise.
  useEffect(() => {
    document.title = entry ? `${entry.title} — Slate` : 'Slate'
  }, [entry?.title, rev])

  /* ---- keeping the window that opened this one in the picture ------- */

  /*
   * Which note this window is holding, so the pane it came from knows what it
   * is not allowed to open — and, following a link out of here, which note it
   * can have back.
   */
  useEffect(() => {
    reportHolding(path)
  }, [path])

  useEffect(() => {
    // Letting go as the window closes is what puts the note back in the pane.
    const bye = () => reportHolding(undefined)
    addEventListener('pagehide', bye)
    return () => removeEventListener('pagehide', bye)
  }, [])

  /*
   * Read the note back out of IndexedDB a moment after it appears.
   *
   * The pane that handed it over flushes its buffer as this window opens, and
   * those are two different windows racing over an asynchronous write. Losing
   * the race would mean opening on text a keystroke or two old and then saving
   * over the newer copy. Two reads of a single row settle it; the editor folds
   * whatever they bring in the way it folds a change arriving from a sync.
   */
  useEffect(() => {
    if (!path) return
    const soon = setTimeout(() => void adoptFromStorage([path]), 150)
    const later = setTimeout(() => void adoptFromStorage([path]), 700)
    return () => {
      clearTimeout(soon)
      clearTimeout(later)
    }
  }, [path])

  /* ---- what the editor asks the shell for --------------------------- */

  /*
   * The same events App.tsx answers, with one difference: a tag is a way of
   * filtering a list, and this window has no list. Everything else — links,
   * embeds, external URIs, the link dialog, a task's due date — means the same
   * thing here as it does there.
   */
  useEffect(() => {
    const onLink = async (e: Event) => {
      const { target, exists } = (e as CustomEvent<{ target: string; exists: boolean }>).detail
      const resolved = resolveLink(target)
      if (resolved) {
        openNote(resolved)
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
      handleUriClick((e as CustomEvent<Parameters<typeof handleUriClick>[0]>).detail)
    }
    const onLinkDialog = () => editLinkAtCaret()
    const onDue = (e: Event) => {
      const { x, y, pos, current } = (
        e as CustomEvent<{ x: number; y: number; pos: number; current?: number }>
      ).detail
      openDueMenu({ clientX: x, clientY: y }, current, (date) => applyDue(pos, date))
    }
    const onTag = (e: Event) => {
      const { tag } = (e as CustomEvent<{ tag: string }>).detail
      notify(`#${tag} — open the main window to browse tags`)
    }
    addEventListener('slate:open-link', onLink)
    addEventListener('slate:lightbox', onLightbox)
    addEventListener('slate:open-tag', onTag)
    addEventListener('slate:uri', onUri)
    addEventListener('slate:link-dialog', onLinkDialog)
    addEventListener('slate:due', onDue)
    return () => {
      removeEventListener('slate:open-link', onLink)
      removeEventListener('slate:lightbox', onLightbox)
      removeEventListener('slate:open-tag', onTag)
      removeEventListener('slate:uri', onUri)
      removeEventListener('slate:link-dialog', onLinkDialog)
      removeEventListener('slate:due', onDue)
    }
  }, [])

  if (!ready.value) {
    return (
      <div class="empty" style={{ marginTop: '30vh' }}>
        Opening your vault…
      </div>
    )
  }

  return (
    <>
      <div class="popout-shell" data-mode={layoutMode.value}>
        <EditorPane />
      </div>
      <VersionHistory />
      <LinkDialog />
      <PromptDialog />
      <Lightbox />
      <ContextMenu />
      <Toaster />
    </>
  )
}
