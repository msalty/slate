/**
 * Being taken to a line in a note, from somewhere outside the note.
 *
 * Two things ask for this — a task tapped in the Tasks list or the calendar,
 * and a heading picked from the outline — and they want the same three things:
 * the line found, the line marked briefly so the eye can catch it, and the
 * markdown under it already parsed so the jump does not land somewhere that
 * then moves.
 *
 * It is a *visual* target. Nothing here touches the document, the selection or
 * the undo history: being shown a line is not editing it, and a jump that took
 * the caret would turn a note you were reading into a note you are writing.
 * The mark clears itself on the next edit or click, which is exactly when it
 * has stopped being the answer to anything.
 */

import { forceParsing } from '@codemirror/language'
import { StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'

/** A visual navigation target only; never part of the document or undo history. */
export const setNavTarget = StateEffect.define<number>()
export const navTargetField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    if (tr.docChanged || tr.selection) value = Decoration.none
    for (const effect of tr.effects) {
      if (effect.is(setNavTarget)) {
        value = Decoration.set([
          Decoration.line({ class: 'cm-nav-target' }).range(effect.value),
        ])
      }
    }
    return value
  },
  provide: (field) => EditorView.decorations.from(field),
})

export const navTargetExtension = [
  navTargetField,
  EditorView.baseTheme({
    '.cm-line.cm-nav-target': {
      backgroundColor: 'color-mix(in srgb, #e9b949 28%, transparent)',
      borderRadius: '4px',
    },
  }),
]

/**
 * Where the line ends up on screen.
 *
 * A task is centred: it is one line, and what you want around it is context on
 * both sides. A heading is put at the top, because everything it is about is
 * *below* it — centring one wastes half the screen on the section you just
 * left, and the first thing you asked to read starts halfway down.
 */
export type NavAlign = 'center' | 'start'

/*
 * A margin at the top only. Flush against the edge a heading looks like the
 * note begins there, which is the one thing an outline must not imply about a
 * section in the middle of one.
 */
const scrollTo = (pos: number, align: NavAlign) =>
  EditorView.scrollIntoView(pos, align === 'start' ? { y: 'start', yMargin: 16 } : { y: 'center' })

/**
 * How many frames to keep re-asserting the scroll after the first one.
 *
 * The lines *above* the target decide where it lands, and their heights are
 * estimated until they have been measured — `forceParsing` prepares what is
 * below the jump and can do nothing about what is above it. So the first
 * scroll is made against an estimate, the estimate is corrected a frame or two
 * later, and the target drifts by however much the correction was worth.
 *
 * Centring survived this because half a screen of slack hides a drift of a few
 * lines. Putting a heading at the top has no slack at all: a drift upward of
 * one line puts the heading you asked for off the top of the screen, with its
 * section showing underneath — which reads as the app ignoring you.
 */
const SETTLE_FRAMES = 3

/** Line numbers here are zero-based; CodeMirror's are one-based. */
export function revealLine(view: EditorView, line: number, align: NavAlign = 'center') {
  if (!Number.isInteger(line) || line < 0 || line >= view.state.doc.lines) return
  const target = view.state.doc.line(line + 1)
  // Showing the target exposes the lines below it too. Parse a generous
  // viewport buffer before the jump, so those lines don't appear as markdown
  // and then change height as rich text catches up. Count logical lines: wrapped
  // lines only make this an overestimate. Keep the time budget bounded.
  const screenLines = Math.ceil((view.scrollDOM.clientHeight || 800) / Math.max(view.defaultLineHeight, 1))
  const throughLine = Math.min(view.state.doc.lines, target.number + Math.max(100, screenLines * 2))
  forceParsing(view, view.state.doc.line(throughLine).to, 100)
  view.dispatch({ effects: [setNavTarget.of(target.from), scrollTo(target.from, align)] })

  /*
   * Ask again while the layout settles. Cheap — a scroll effect on a
   * transaction that changes nothing else — and it stops the moment the mark
   * is gone, which is the moment an edit or a click has made this no longer
   * the answer to anything. That is also what keeps it from fighting somebody
   * who scrolled away in the meantime: their click cleared the mark.
   */
  let frames = 0
  const settle = () => {
    if (frames++ >= SETTLE_FRAMES) return
    if (!view.dom.isConnected) return
    const mark = view.state.field(navTargetField, false)
    if (!mark || mark.size === 0) return
    view.dispatch({ effects: scrollTo(mark.iter().from, align) })
    requestAnimationFrame(settle)
  }
  requestAnimationFrame(settle)
}
