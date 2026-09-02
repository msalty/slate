/**
 * What a link does when you touch it, and how you change one.
 *
 * The editor recognises links and reports clicks; deciding what a click *means*
 * belongs here, because it depends on the shape of the device. With a pointer,
 * a click opens — right-click is right there when you want the link's own text.
 * On a phone there is no right-click and no hover, so a tap offers the choice
 * rather than guessing, exactly as the address bar's own long-press does.
 */

import type { EditorView } from '@codemirror/view'
import { applyLink, linkAt, linkTarget, openUri } from '../editor/links'
import { activeEditor } from '../editor/context'
import { openMenu, type MenuItem } from './Menu'
import { openLinkDialog } from './LinkDialog'
import { layoutMode } from './layout'
import { notify } from './state'

/** Open the add/edit dialog for whatever the caret is on. */
export function editLinkAtCaret(view: EditorView | null = activeEditor.value) {
  if (!view) return
  const t = linkTarget(view.state)
  openLinkDialog({
    text: t.text,
    url: t.url,
    existing: !!t.url,
    onSubmit: (text, url) => applyLink(view, t.from, t.to, text, url),
  })
}

/** Open the dialog on the link that covers a document position. */
function editLinkAt(view: EditorView, pos: number) {
  const span = linkAt(view.state, pos)
  if (span) {
    openLinkDialog({
      text: span.text,
      url: span.url,
      existing: true,
      onSubmit: (text, url) => applyLink(view, span.from, span.to, text, url),
    })
    return
  }
  // A bare URL: put the caret on it first so the dialog picks it up.
  view.dispatch({ selection: { anchor: pos }, userEvent: 'select.pointer' })
  editLinkAtCaret(view)
}

async function copyLink(url: string) {
  try {
    await navigator.clipboard.writeText(url)
    notify('Link copied')
  } catch {
    notify('Could not copy the link', 'error')
  }
}

/**
 * Handle a click or a right-click on a link in the editor.
 *
 * A plain click with a pointer opens, because that is what a link does
 * everywhere else. Everything else — a right-click, or any tap on a touch
 * layout — offers the menu.
 */
export function handleUriClick(detail: {
  url: string
  x: number
  y: number
  pos: number
  via: 'click' | 'menu'
}) {
  const view = activeEditor.value
  const compact = layoutMode.value === 'compact'
  if (detail.via === 'click' && !compact) {
    openUri(detail.url)
    return
  }

  const items: MenuItem[] = [
    { label: 'Open link', onSelect: () => openUri(detail.url) },
    { label: 'Copy link', onSelect: () => copyLink(detail.url) },
  ]
  if (view) {
    items.push({
      label: 'Edit link…',
      separated: true,
      onSelect: () => editLinkAt(view, detail.pos),
    })
  }
  openMenu({ clientX: detail.x, clientY: detail.y }, items, truncate(detail.url))
}

function truncate(url: string, max = 42): string {
  return url.length > max ? `${url.slice(0, max - 1)}…` : url
}
