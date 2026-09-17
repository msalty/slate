/**
 * A slot at the end of the note, inside the note's own scroll.
 *
 * The shell has one thing to show after a note — what links to it — and the
 * cheap way to show it was a strip under the editor. That is what this
 * replaces: a strip is chrome, and chrome along the bottom of the pane is
 * height the note never gets back, on every note, whether or not anything
 * points at it.
 *
 * Putting it in the document instead costs nothing until somebody reads that
 * far. It is a block widget pinned past the last line, so it scrolls with the
 * text rather than beside it, has no scrollbar of its own, and inherits the
 * content box — the reading measure, the phone's wider gutters — rather than
 * needing a second set of width rules kept in sync with the editor's.
 *
 * The element belongs to the caller. CodeMirror is handed a node and only ever
 * hangs it in and out of the document — what is rendered inside it is the
 * shell's business (ui/LinkedMentions.tsx). An empty node is an empty line at
 * the end of a note, which is to say nothing at all, so a note nothing links to
 * needs no special case here.
 */

import { StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view'

class FooterWidget extends WidgetType {
  constructor(readonly dom: HTMLElement) {
    super()
  }

  /*
   * One footer per editor, and always the same element: equal to itself, so
   * typing at the end of a note — which moves the widget's position with every
   * keystroke — re-anchors the decoration without rebuilding anything inside
   * it. The node is the caller's, so `destroy` deliberately leaves it alone.
   */
  eq(other: FooterWidget) {
    return other.dom === this.dom
  }

  toDOM() {
    return this.dom
  }

  destroy() {}

  /** Nothing in here is the note: a click on it is not a click in the text. */
  ignoreEvent() {
    return true
  }
}

/**
 * Keep the note's height map honest about a footer that changes size — mentions
 * arriving from a sync pull, or the disclosure being opened. CodeMirror
 * measures a block widget once and remembers the number, so without this the
 * lines above it would be positioned against a height that is no longer true.
 */
function watchHeight(dom: HTMLElement) {
  return ViewPlugin.define((view) => {
    // jsdom has no ResizeObserver, and a test has no layout to observe anyway.
    if (typeof ResizeObserver === 'undefined') return {}
    const ro = new ResizeObserver(() => view.requestMeasure())
    ro.observe(dom)
    return { destroy: () => ro.disconnect() }
  })
}

/** Hang `dom` after the last line of the note. */
export function noteFooter(dom: HTMLElement): Extension {
  const deco = Decoration.widget({ widget: new FooterWidget(dom), block: true, side: 1 })
  const at = (length: number) => Decoration.set([deco.range(length)])

  return [
    StateField.define<DecorationSet>({
      create: (state) => at(state.doc.length),
      update: (value, tr) => (tr.docChanged ? at(tr.state.doc.length) : value),
      provide: (f) => EditorView.decorations.from(f),
    }),
    watchHeight(dom),
  ]
}
