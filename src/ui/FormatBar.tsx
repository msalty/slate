/**
 * The formatting controls for Rich Text mode.
 *
 * One component, two presentations, the same as the context menu: a slim bar
 * under the editor head on a pointer device, and a bottom sheet on a phone,
 * where a toolbar of 14 small targets is unusable and the sheet is what the
 * platform's own notes app puts on screen.
 *
 * Every button reads its pressed state from `formatSnapshot`, which the editor
 * republishes on each selection change — so the bar always describes the text
 * the caret is actually in, rather than a mode the user has to remember.
 */

import { useEffect, useState } from 'preact/hooks'
import {
  type BlockStyle,
  type InlineMark,
  type ListKind,
  applyBlockStyle,
  applyIndent,
  applyInline,
  applyList,
  applyQuote,
  formatSnapshot,
} from '../editor/format'
import type { EditorView } from '@codemirror/view'
import {
  IconClose,
  IconCode,
  IconHighlight,
  IconIndent,
  IconListBullet,
  IconListCheck,
  IconListNumber,
  IconOutdent,
  IconQuote,
} from './Icons'

const STYLES: Array<{ id: BlockStyle; label: string; hint: string }> = [
  { id: 'title', label: 'Title', hint: 'Title (⌘⌥1)' },
  { id: 'heading', label: 'Heading', hint: 'Heading (⌘⌥2)' },
  { id: 'subheading', label: 'Subheading', hint: 'Subheading (⌘⌥3)' },
  { id: 'body', label: 'Body', hint: 'Body (⌘⌥0)' },
]

const MARKS: Array<{ id: InlineMark; label: preact.ComponentChildren; hint: string }> = [
  { id: 'bold', label: <b>B</b>, hint: 'Bold (⌘B)' },
  { id: 'italic', label: <i>I</i>, hint: 'Italic (⌘I)' },
  { id: 'underline', label: <u>U</u>, hint: 'Underline (⌘U)' },
  { id: 'strike', label: <s>S</s>, hint: 'Strikethrough (⌘⇧X)' },
  { id: 'highlight', label: <IconHighlight size={17} />, hint: 'Highlight (⌘⇧H)' },
  { id: 'code', label: <IconCode size={17} />, hint: 'Monospaced (⌘E)' },
]

const LISTS: Array<{ id: ListKind; label: preact.ComponentChildren; hint: string }> = [
  { id: 'bullet', label: <IconListBullet size={18} />, hint: 'Bulleted list (⌘⇧8)' },
  { id: 'number', label: <IconListNumber size={18} />, hint: 'Numbered list (⌘⇧0)' },
  { id: 'check', label: <IconListCheck size={18} />, hint: 'Checklist (⌘⇧7)' },
]

export interface FormatBarProps {
  /** Read at click time: the view is rebuilt whenever the open note changes. */
  getView: () => EditorView | null
  variant: 'bar' | 'sheet'
  onClose?: () => void
}

/**
 * How much of the screen the on-screen keyboard is covering.
 *
 * The layout viewport does not shrink when a phone keyboard opens, so anything
 * pinned to the bottom of the page ends up behind it. The visual viewport does
 * shrink, and the difference is the keyboard.
 */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const apply = () =>
      setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)))
    apply()
    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
    return () => {
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
    }
  }, [])
  return inset
}

export function FormatBar({ getView, variant, onClose }: FormatBarProps) {
  const f = formatSnapshot.value
  const keyboard = useKeyboardInset()

  /**
   * Wire a button to a command without stealing the selection.
   *
   * Pressing a button is what moves focus out of the editor, and an editor
   * without focus has no selection to format — so the press default is
   * suppressed and the command runs from the down event instead. Preventing
   * `touchstart` also stops the browser synthesising the mouse events after it,
   * which is what keeps a single tap from running the command twice.
   */
  const act = (cmd: (view: EditorView) => boolean) => {
    const handler = (e: Event) => {
      e.preventDefault()
      const view = getView()
      if (!view) return
      cmd(view)
      view.focus()
    }
    return { onMouseDown: handler, onTouchStart: handler }
  }

  const styleRow = (
    <div class="fmt-row fmt-styles" role="group" aria-label="Paragraph style">
      {STYLES.map((s) => (
        <button
          key={s.id}
          class={`fmt-style fmt-style-${s.id}`}
          title={s.hint}
          aria-label={s.hint}
          aria-pressed={f.block === s.id}
          {...act(applyBlockStyle(s.id))}
        >
          {s.label}
        </button>
      ))}
    </div>
  )

  const markRow = (
    <div class="fmt-row" role="group" aria-label="Text style">
      {MARKS.map((m) => (
        <button
          key={m.id}
          class="fmt-btn"
          title={m.hint}
          aria-label={m.hint}
          aria-pressed={f.marks[m.id]}
          {...act(applyInline(m.id))}
        >
          {m.label}
        </button>
      ))}
    </div>
  )

  const listRow = (
    <div class="fmt-row" role="group" aria-label="Lists and indentation">
      {LISTS.map((l) => (
        <button
          key={l.id}
          class="fmt-btn"
          title={l.hint}
          aria-label={l.hint}
          aria-pressed={f.list === l.id}
          {...act(applyList(l.id))}
        >
          {l.label}
        </button>
      ))}
      <span class="fmt-sep" />
      <button
        class="fmt-btn"
        title="Decrease indent (⌘[)"
        aria-label="Decrease indent"
        disabled={!f.canOutdent}
        {...act(applyIndent(-1))}
      >
        <IconOutdent size={18} />
      </button>
      <button
        class="fmt-btn"
        title="Increase indent (⌘])"
        aria-label="Increase indent"
        disabled={!f.canIndent}
        {...act(applyIndent(1))}
      >
        <IconIndent size={18} />
      </button>
      <span class="fmt-sep" />
      <button
        class="fmt-btn"
        title="Block quote (⌘⇧9)"
        aria-label="Block quote"
        aria-pressed={f.quote}
        {...act(applyQuote)}
      >
        <IconQuote size={18} />
      </button>
    </div>
  )

  if (variant === 'sheet') {
    // No scrim: the sheet sits where the keyboard would, and the note above it
    // stays live. Formatting one line and then tapping the next is the whole
    // point of the panel, and a modal overlay would make that a three-tap trip.
    return (
      <div
        class="fmt-sheet"
        role="group"
        aria-label="Format"
        // Sit on top of the keyboard rather than behind it. The home-indicator
        // padding is only wanted when there is no keyboard to cover it.
        style={keyboard ? { bottom: `${keyboard}px`, paddingBottom: '10px' } : undefined}
      >
        <div class="fmt-sheet-head">
          <h2>Format</h2>
          <button class="icon-btn" aria-label="Close" onClick={onClose}>
            <IconClose size={18} />
          </button>
        </div>
        {styleRow}
        {markRow}
        {listRow}
      </div>
    )
  }

  return (
    <div class="fmt-bar" role="toolbar" aria-label="Formatting">
      {styleRow}
      <span class="fmt-sep" />
      {markRow}
      <span class="fmt-sep" />
      {listRow}
    </div>
  )
}
