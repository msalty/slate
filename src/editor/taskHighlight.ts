import { forceParsing } from '@codemirror/language'
import { StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'

/** A visual navigation target only; never part of the document or undo history. */
export const setTaskHighlight = StateEffect.define<number>()
export const taskHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    if (tr.docChanged || tr.selection) value = Decoration.none
    for (const effect of tr.effects) {
      if (effect.is(setTaskHighlight)) {
        value = Decoration.set([
          Decoration.line({ class: 'cm-task-target' }).range(effect.value),
        ])
      }
    }
    return value
  },
  provide: (field) => EditorView.decorations.from(field),
})

export const taskHighlightExtension = [
  taskHighlightField,
  EditorView.baseTheme({
    '.cm-line.cm-task-target': {
      backgroundColor: 'color-mix(in srgb, #e9b949 28%, transparent)',
      borderRadius: '4px',
    },
  }),
]

/** Task indexes are zero-based; CodeMirror line numbers are one-based. */
export function highlightTask(view: EditorView, line: number) {
  if (!Number.isInteger(line) || line < 0 || line >= view.state.doc.lines) return
  const target = view.state.doc.line(line + 1)
  // Centering the task exposes the lines below it too. Parse a generous
  // viewport buffer before the jump, so those lines don't appear as markdown
  // and then change height as rich text catches up. Count logical lines: wrapped
  // lines only make this an overestimate. Keep the time budget bounded.
  const screenLines = Math.ceil((view.scrollDOM.clientHeight || 800) / Math.max(view.defaultLineHeight, 1))
  const throughLine = Math.min(view.state.doc.lines, target.number + Math.max(100, screenLines * 2))
  forceParsing(view, view.state.doc.line(throughLine).to, 100)
  view.dispatch({
    effects: [setTaskHighlight.of(target.from), EditorView.scrollIntoView(target.from, { y: 'center' })],
  })
}
