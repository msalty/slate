/**
 * The widget that shows a drawn fence — a diagram where its source would be.
 *
 * Which renderer draws it is the registry's business (fences.ts); this is the
 * part that is the same for all of them: waiting for the renderer to load,
 * keeping the drawing while its source is edited, and putting the caret into
 * the source when the picture is clicked.
 */

import { type EditorView, WidgetType } from '@codemirror/view'
import { type FenceMount, type FenceRenderer, type FenceView, loadFence, loadedFence } from './fences'

/** What a widget's DOM is currently showing, kept beside the DOM itself. */
interface Slot {
  source: string
  drawing: FenceView | null
  gone: boolean
}

const slots = new WeakMap<HTMLElement, Slot>()

export class FenceWidget extends WidgetType {
  constructor(
    readonly renderer: FenceRenderer,
    readonly source: string,
    /**
     * Shown under the source rather than in place of it, while the caret is in
     * the block: a diagram is written by watching it change.
     */
    readonly beside: boolean,
  ) {
    super()
  }

  /*
   * Deliberately not the block's position: that moves with every character
   * typed above it, and a widget that compared unequal each time would redraw
   * every diagram in the note on every keystroke.
   */
  eq(other: FenceWidget) {
    return (
      other.renderer === this.renderer &&
      other.source === this.source &&
      other.beside === this.beside
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = this.beside ? 'cm-fence cm-fence-beside' : 'cm-fence'
    wrap.dataset.fence = this.renderer.name
    wrap.setAttribute('contenteditable', 'false')

    const slot: Slot = { source: this.source, drawing: null, gone: false }
    slots.set(wrap, slot)
    const resized = () => view.requestMeasure()

    const ready = loadedFence(this.renderer)
    if (ready) {
      slot.drawing = ready(wrap, slot.source, resized)
    } else {
      wrap.classList.add('cm-fence-loading')
      loadFence(this.renderer).then(
        (mount: FenceMount) => {
          if (slot.gone) return
          wrap.classList.remove('cm-fence-loading')
          // Whatever the source is by now, not what it was when loading began.
          slot.drawing = mount(wrap, slot.source, resized)
          resized()
        },
        () => {
          if (slot.gone) return
          wrap.classList.remove('cm-fence-loading')
          // Offline before the renderer was ever fetched. Show the source
          // rather than eat it: the note is still all there.
          const pre = document.createElement('pre')
          pre.className = 'cm-fence-source'
          pre.textContent = slot.source
          const note = document.createElement('div')
          note.className = 'cm-fence-error'
          note.textContent = `The ${this.renderer.name} renderer could not be loaded.`
          wrap.replaceChildren(pre, note)
          resized()
        },
      )
    }

    if (!this.beside) wrap.addEventListener('mousedown', (e) => caretIntoSource(view, wrap, e))
    return wrap
  }

  /**
   * Take over the DOM of the widget this one replaces.
   *
   * Every character typed into a diagram makes a new widget. Building new DOM
   * for each would blank the picture between keystrokes and throw away the
   * last drawing that worked, which is the one worth looking at while the
   * source is mid-edit.
   */
  updateDOM(dom: HTMLElement): boolean {
    const slot = slots.get(dom)
    if (!slot || slot.gone) return false
    if (dom.dataset.fence !== this.renderer.name) return false
    // The click-to-edit listener belongs to one of the two forms only.
    if (dom.classList.contains('cm-fence-beside') !== this.beside) return false
    if (slot.source !== this.source) {
      slot.source = this.source
      // Still loading: the drawing, when it comes, reads the slot.
      slot.drawing?.update(this.source)
    }
    return true
  }

  destroy(dom: HTMLElement) {
    const slot = slots.get(dom)
    if (!slot) return
    slot.gone = true
    slot.drawing?.destroy()
    slot.drawing = null
  }
}

/**
 * A click on the picture is a request to edit it.
 *
 * The caret goes to the first line of the body — under the opening fence —
 * which reveals the source with the drawing beneath it.
 */
function caretIntoSource(view: EditorView, wrap: HTMLElement, e: MouseEvent) {
  if (e.button !== 0) return
  e.preventDefault()
  const { doc } = view.state
  const open = doc.lineAt(Math.min(view.posAtDOM(wrap), doc.length))
  const pos = open.number < doc.lines ? doc.line(open.number + 1).from : open.to
  // Tagged as a pointer selection so live preview counts it as the user
  // choosing to edit — see `interactedField`.
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: false, userEvent: 'select.pointer' })
  view.focus()
}
