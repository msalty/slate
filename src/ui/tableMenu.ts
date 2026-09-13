/**
 * What a table offers, as menus.
 *
 * There are two ways in and they have to agree. The toolbar's ⊞ opens the
 * whole table — every row and column operation, aimed at the cell you are in.
 * A "⋯" handle on the table itself opens one band of it, already picked out, so
 * that menu is the same operations narrowed to the row or column in hand and
 * named after it: *Delete row* rather than "delete the row I hope you mean".
 *
 * Both live here rather than in the toolbar, because the handles are drawn by
 * the editor and the editor imports no UI — it asks the shell for the menu (see
 * `requestTableBandMenu`), and the shell has to be able to build the same one
 * the toolbar would.
 */

import type { EditorView } from '@codemirror/view'
import {
  applyTableOp,
  tableContext,
  type Align,
  type TableAxis,
  type TableOp,
} from '../editor/table'
import { copyTable } from '../editor/paste'
import { activeEditor } from '../editor/context'
import { menuAnchor, openMenu, type MenuItem } from './Menu'
import { layoutMode } from './layout'
import { notify } from './state'

/** Where the buttons would act: row and column, and the table's shape. */
export type TableCtx = NonNullable<typeof tableContext.value>

type At = { clientX: number; clientY: number }

/** What a menu calls each alignment, so the item names the current one. */
const ALIGN_NAMES: Record<Align, string> = {
  '': 'default',
  left: 'left',
  center: 'centre',
  right: 'right',
}

/**
 * Whether to put focus back in the cell afterwards.
 *
 * A phone says no: every one of these edits rebuilds the table, and focusing a
 * cell in the new one raises the keyboard over the sheet or the menu the user
 * is still working in. The cell stays marked instead, which is what the next
 * operation acts on.
 */
const opts = () => ({ refocus: layoutMode.value !== 'compact' })

const run = (getView: () => EditorView | null, op: TableOp) => () => {
  const view = getView()
  if (view) applyTableOp(view, op, opts())
}

const item = (
  getView: () => EditorView | null,
  label: string,
  op: TableOp,
  extra: Partial<MenuItem> = {},
): MenuItem => ({ label, onSelect: run(getView, op), ...extra })

/**
 * Alignment, as a menu of its own rather than four more rows.
 *
 * It is the one property of a column rather than of the table, it is set far
 * less often than a row or column is added, and it is the only thing here with
 * a *current value* worth showing — so it gets a tick against what the column
 * is doing now.
 */
function alignMenu(getView: () => EditorView | null, current: Align): MenuItem[] {
  return (
    [
      ['Default', 'align-default', ''],
      ['Left', 'align-left', 'left'],
      ['Centre', 'align-center', 'center'],
      ['Right', 'align-right', 'right'],
    ] as Array<[string, TableOp, Align]>
  ).map(([label, op, value], i) => ({
    ...item(getView, label, op),
    separated: i === 1,
    checked: current === value,
  }))
}

/** The whole table: what the toolbar's ⊞ opens when the caret is in one. */
export function openTableMenu(at: At, getView: () => EditorView | null, table: TableCtx) {
  const op = (label: string, id: TableOp, danger = false) => item(getView, label, id, { danger })
  openMenu(
    at,
    [
      /*
       * First, because it is the only item here that is not an edit — and
       * because dragging across a table to copy it is a gesture with no edges,
       * especially on a phone and in the rendered modes where the table is one
       * widget. From here the caret is the aim.
       */
      {
        label: 'Copy table',
        onSelect: async () => {
          const view = getView()
          const ok = !!view && (await copyTable(view))
          notify(
            ok ? 'Table copied — paste it into a spreadsheet' : 'Could not reach the clipboard',
            ok ? 'info' : 'error',
          )
        },
      } as MenuItem,
      op('Insert row above', 'row-above'),
      op('Insert row below', 'row-below'),
      op('Insert column left', 'col-left'),
      op('Insert column right', 'col-right'),
      {
        label: `Align column: ${ALIGN_NAMES[table.align]}…`,
        onSelect: () =>
          openMenu(menuAnchor(), alignMenu(getView, table.align), `Align column ${table.col + 1}`),
      } as MenuItem,
      op('Delete row', 'row-delete', true),
      op('Delete column', 'col-delete', true),
      op('Delete table', 'delete', true),
    ].map((it, i) => (i === 1 || i === 5 || i === 6 ? { ...it, separated: true } : it)),
    `Table · row ${table.row + 1} of ${table.rows}, column ${table.col + 1} of ${table.cols}`,
  )
}

/**
 * One band of it: what the second press on a handle opens.
 *
 * Narrower than the table menu on purpose. The band is already outlined on
 * screen, so nothing here has to say which row it means — and the operations
 * that belong to the other axis would only be four more rows to read past.
 */
export function openTableBandMenu(
  at: At,
  kind: TableAxis,
  index: number,
  getView: () => EditorView | null = () => activeEditor.value,
) {
  const table = tableContext.value
  // The operations act on the cell being worked in, which is the cell the
  // handle belongs to. If the two have come apart — an edit landing between the
  // press and the menu — the safe answer is no menu rather than one aimed at a
  // row nobody pointed at.
  if (!table || (kind === 'row' ? table.row : table.col) !== index) return
  const op = (label: string, id: TableOp, extra: Partial<MenuItem> = {}) =>
    item(getView, label, id, extra)

  if (kind === 'row') {
    const header = table.row === 0
    openMenu(
      at,
      [
        // Nothing goes above the header: a GFM table without one is not a
        // table, so the menu does not offer what the grid would refuse.
        ...(header ? [] : [op('Insert row above', 'row-above')]),
        op('Insert row below', 'row-below'),
        op('Move row up', 'row-move-up', { separated: true, disabled: header || table.row <= 1 }),
        op('Move row down', 'row-move-down', { disabled: header || table.row >= table.rows - 1 }),
        ...(header ? [] : [op('Delete row', 'row-delete', { separated: true, danger: true })]),
      ],
      header ? 'Header row' : `Row ${table.row + 1} of ${table.rows}`,
    )
    return
  }

  openMenu(
    at,
    [
      op('Insert column left', 'col-left'),
      op('Insert column right', 'col-right'),
      op('Move column left', 'col-move-left', { separated: true, disabled: table.col <= 0 }),
      op('Move column right', 'col-move-right', { disabled: table.col >= table.cols - 1 }),
      {
        label: `Align column: ${ALIGN_NAMES[table.align]}…`,
        separated: true,
        onSelect: () =>
          openMenu(menuAnchor(), alignMenu(getView, table.align), `Align column ${table.col + 1}`),
      } as MenuItem,
      op('Delete column', 'col-delete', {
        separated: true,
        danger: true,
        disabled: table.cols <= 1,
      }),
    ],
    `Column ${table.col + 1} of ${table.cols}`,
  )
}

/**
 * The shell's answer to a handle asking for its menu.
 *
 * Both windows wire this to `slate:table-band`: a popped-out note is a whole
 * second copy of the app, and a table in it is edited exactly like a table in
 * the main one.
 */
export function onTableBandRequest(e: Event) {
  const { x, y, kind, index } = (
    e as CustomEvent<{ x: number; y: number; kind: TableAxis; index: number }>
  ).detail
  openTableBandMenu({ clientX: x, clientY: y }, kind, index)
}
