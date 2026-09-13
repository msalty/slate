/**
 * Editor chrome and syntax colours.
 *
 * All colours resolve from CSS custom properties defined in styles/app.css, so
 * the editor follows the app's light/dark theme without a second palette to
 * keep in sync.
 */

import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { wikiEmbedTag, wikiLinkTag } from './wikilink-syntax'

export const editorTheme = EditorView.theme({
  '&': {
    color: 'var(--text)',
    backgroundColor: 'transparent',
    height: '100%',
    fontSize: 'var(--editor-font-size)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-body)',
    lineHeight: '1.62',
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    padding: '0',
  },
  '.cm-content': {
    /*
     * The horizontal padding is what keeps the note off the edge of its pane.
     * It belongs here rather than on `.cm-line`, because a code block, a table
     * or an image bleeds to the full width of the content box and would
     * otherwise sit flush against the pane. 12px here plus the 4px on a line
     * puts body text exactly under the title in the header above it.
     * The phone overrides this in app.css, where the pane is the whole screen.
     *
     * No measure cap and no auto margins: the note runs flush with the left
     * edge of the pane and takes whatever width the pane has, so widening the
     * window widens the text rather than growing two gutters around it.
     */
    padding: '8px 12px 45vh',
    caretColor: 'var(--accent)',
    width: '100%',
  },
  '.cm-line': { padding: '0 4px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  /*
   * The selection, in the app's own accent rather than CodeMirror's grey.
   *
   * `!important` is load-bearing, and was missing: the base theme dresses a
   * *focused* editor's selection with a selector four classes deeper than
   * this one — `&light.cm-focused > .cm-scroller > .cm-selectionLayer
   * .cm-selectionBackground` — so an opaque `#d7d4f0` quietly won every time
   * the editor had focus, which is every time anybody selects anything.
   * Translucency is what the rule below then depends on.
   */
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--selection) !important',
  },
  /*
   * The selection is drawn rather than native, and CodeMirror draws it in a
   * layer *under* the content — where anything with a background of its own
   * hides it. A code block has one, so does the frontmatter block, so does a
   * callout: selecting inside any of them showed no selection at all, which
   * looks like the highlight going missing behind the block.
   *
   * So the layer is painted over the content instead. It can be, because the
   * colour is translucent: the words stay readable through it the way they do
   * under a highlighter, which is also what the browser does to a selected
   * picture. `!important` because CodeMirror writes its `-1` as an inline
   * style, and `pointer-events` because a layer lying over the text would
   * otherwise swallow every click meant for the text.
   */
  '.cm-selectionLayer': { zIndex: '1 !important', pointerEvents: 'none' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-gutters': { display: 'none' },
  '.cm-placeholder': { color: 'var(--text-faint)', fontStyle: 'normal' },

  /* --- block-level live preview ------------------------------------- */
  /*
   * Vertical space around a block is PADDING (or a transparent border), never
   * margin — anywhere in this file that touches a `.cm-line` or the root of a
   * widget.
   *
   * CodeMirror keeps its own height map of the document and measures each line
   * box to build it. `getBoundingClientRect()` includes padding and border but
   * not margin, so a margin here makes the editor believe every line below it
   * sits higher on screen than it really does — and since a click is turned
   * into a document position by looking up that height map, the caret lands on
   * the wrong line. One heading with `margin: 0.7em 0` was enough to put every
   * click below it a line out.
   */
  '.cm-line.cm-h1': {
    fontSize: '1.75em',
    fontWeight: '700',
    lineHeight: '1.25',
    paddingTop: '0.7em',
    paddingBottom: '0.1em',
  },
  '.cm-line.cm-h2': {
    fontSize: '1.4em',
    fontWeight: '700',
    lineHeight: '1.3',
    paddingTop: '0.7em',
    paddingBottom: '0.1em',
  },
  '.cm-line.cm-h3': {
    fontSize: '1.18em',
    fontWeight: '650',
    lineHeight: '1.35',
    paddingTop: '0.6em',
    paddingBottom: '0.1em',
  },
  '.cm-line.cm-h4': {
    fontSize: '1.05em',
    fontWeight: '650',
    paddingTop: '0.5em',
    paddingBottom: '0.1em',
  },
  '.cm-line.cm-h5, .cm-line.cm-h6': {
    fontSize: '1em',
    fontWeight: '650',
    color: 'var(--text-muted)',
  },
  '.cm-line.cm-quote': {
    borderLeft: '3px solid var(--border-strong)',
    paddingLeft: '14px',
    color: 'var(--text-muted)',
  },
  /*
   * Callouts.
   *
   * A callout is a blockquote, so it is built the same way — a coloured left
   * edge and a tint, both painted with padding rather than margin, per the note
   * at the top of this section. Only the ends are rounded, so a run of lines
   * reads as one box.
   *
   * The body text stays `--text-muted` and that is deliberate: everything
   * inside is tagged `t.quote` by the highlighter, which paints the spans
   * directly, and the only way to override it from a line class would be a
   * descendant rule broad enough to flatten link, tag and code colours inside
   * the callout too. It is a quote; it is allowed to read like one.
   */
  '.cm-line.cm-callout': {
    borderLeft: '3px solid var(--callout-accent)',
    paddingLeft: '14px',
    paddingRight: '12px',
    color: 'var(--text-muted)',
    backgroundColor: 'color-mix(in srgb, var(--callout-accent) 8%, transparent)',
    backgroundClip: 'padding-box',
  },
  '.cm-line.cm-callout-first': {
    borderRadius: '0 8px 0 0',
    paddingTop: '7px',
    borderTop: '5px solid transparent',
  },
  '.cm-line.cm-callout-last': {
    borderRadius: '0 0 8px 0',
    paddingBottom: '7px',
    borderBottom: '5px solid transparent',
  },
  '.cm-line.cm-callout-note': { '--callout-accent': 'var(--callout-note)' },
  '.cm-line.cm-callout-tip': { '--callout-accent': 'var(--callout-tip)' },
  '.cm-line.cm-callout-important': { '--callout-accent': 'var(--callout-important)' },
  '.cm-line.cm-callout-warning': { '--callout-accent': 'var(--callout-warning)' },
  '.cm-line.cm-callout-caution': { '--callout-accent': 'var(--callout-caution)' },

  /* The icon that replaced the `[!warning]`, plus its fallback label. */
  '.cm-callout-mark': {
    display: 'inline-flex',
    alignItems: 'center',
    color: 'var(--callout-accent)',
    fontWeight: '650',
    verticalAlign: '-0.15em',
  },
  /*
   * The gap belongs to the icon, not to the row: the title is only sometimes
   * the widget's own label — when the author wrote one it is ordinary document
   * text that starts immediately after the widget ends, and a `gap` here would
   * space the first case and not the second.
   */
  '.cm-callout-mark svg': {
    width: '1.15em',
    height: '1.15em',
    flex: '0 0 auto',
    marginRight: '0.4em',
  },
  '.cm-callout-label': { fontFamily: 'var(--font-body)' },
  /* An author's own title takes the type's colour, like the label would. */
  '.cm-callout-title': { color: 'var(--callout-accent)', fontWeight: '650' },

  /*
   * The fold chevron, at the head of the icon.
   *
   * Out of the way until it is wanted: with a pointer, a note full of callouts
   * should not be a note full of buttons, so it appears on hover — except when
   * the callout is folded. See the media query below.
   */
  '.cm-callout-fold': {
    display: 'inline-flex',
    alignItems: 'center',
    marginRight: '0.35em',
    cursor: 'pointer',
    opacity: '0.75',
    transition: 'opacity var(--dur), transform var(--dur)',
    // Down when the callout is open, right when it is folded — the direction
    // every disclosure triangle in the app points.
    transform: 'rotate(90deg)',
  },
  '.cm-callout-fold[data-folded="1"]': { transform: 'none' },
  '.cm-callout-fold svg': { width: '0.85em', height: '0.85em' },
  /*
   * With a pointer it is hidden until hovered, on the same terms as the code
   * block's copy button — see the one media query further down, which both of
   * them share. A folded callout keeps its chevron everywhere.
   */
  /* What stands in for the body of a folded callout: how much of it there is. */
  '.cm-callout-folded': {
    marginLeft: '0.6em',
    padding: '0 6px',
    borderRadius: '5px',
    fontSize: '0.82em',
    fontFamily: 'var(--font-body)',
    fontWeight: '500',
    color: 'var(--callout-accent)',
    backgroundColor: 'color-mix(in srgb, var(--callout-accent) 14%, transparent)',
    verticalAlign: '0.05em',
  },

  '.cm-line.cm-codeblock': {
    backgroundColor: 'var(--code-bg)',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.9em',
    padding: '0 12px',
    // Keeps the tinted background off the transparent border below.
    backgroundClip: 'padding-box',
  },
  /*
   * One size for everything in a fenced block, whatever drew it.
   *
   * The line above sets the size code is read at. What sat inside it did not
   * agree: the `monospace` tag in the highlight style below shrinks again by
   * 0.9 — right for inline code in a 15px paragraph, a second helping here —
   * and it reaches a block's text only when the markdown parser is the one
   * tokenising it. So a block whose language is loaded came out a step larger
   * than one whose language is not, and a `$(property)` filled into either
   * came out larger still, since a widget is not source and the highlighter
   * never marks it. Three sizes of the same monospace line.
   */
  '.cm-line.cm-codeblock span': { fontSize: 'inherit' },
  '.cm-line.cm-codeblock-first': {
    borderRadius: '8px 8px 0 0',
    paddingTop: '8px',
    borderTop: '6px solid transparent',
    // The containing block for the absolutely positioned copy button above.
    position: 'relative',
  },
  /*
   * The copy button, floated into the top right of a fenced block.
   *
   * Absolutely positioned, and that is load-bearing rather than cosmetic: it
   * takes the button out of flow entirely, so the line box CodeMirror measures
   * for its height map is exactly the height it would have been without it. An
   * in-flow button would move every line below the block a few pixels and put
   * every click below it on the wrong line — the same trap the margin note at
   * the top of this file describes.
   */
  '.cm-code-copy': {
    position: 'absolute',
    top: '2px',
    right: '6px',
    zIndex: '2',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '26px',
    height: '26px',
    padding: '0',
    border: '1px solid var(--border)',
    borderRadius: '7px',
    backgroundColor: 'var(--surface-float)',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    opacity: '0.75',
    transition: 'opacity .12s, color .12s, border-color .12s',
  },
  '.cm-code-copy svg': { width: '15px', height: '15px' },
  '.cm-code-copy:hover': { opacity: '1', color: 'var(--text)', borderColor: 'var(--border-strong)' },
  '.cm-code-copy-done': { display: 'none', color: 'var(--ok)' },
  '.cm-code-copy[data-copied] .cm-code-copy-idle': { display: 'none' },
  '.cm-code-copy[data-copied] .cm-code-copy-done': { display: 'block' },
  '.cm-code-copy[data-copied]': { opacity: '1', color: 'var(--ok)', borderColor: 'var(--ok)' },
  /*
   * Out of the way until asked for — but only where there is a pointer to ask
   * with. On a touch screen there is no hover state to reveal it, so a button
   * that hides until hover is a button that does not exist.
   */
  '@media (hover: hover) and (pointer: fine)': {
    '.cm-code-copy': { opacity: '0' },
    '.cm-line.cm-codeblock-first:hover .cm-code-copy': { opacity: '0.75' },
    '.cm-line.cm-codeblock-first:hover .cm-code-copy:hover': { opacity: '1' },
    '.cm-code-copy[data-copied]': { opacity: '1' },
    // The callout's fold chevron keeps the same bargain, for the same reason.
    '.cm-callout-fold': { opacity: '0' },
    '.cm-line:hover .cm-callout-fold': { opacity: '0.75' },
    '.cm-callout-fold:hover': { opacity: '1' },
    '.cm-callout-fold[data-folded="1"]': { opacity: '0.75' },
  },
  '.cm-line.cm-codeblock-last': {
    borderRadius: '0 0 8px 8px',
    paddingBottom: '8px',
    borderBottom: '6px solid transparent',
  },
  '.cm-line.cm-table': { fontFamily: 'var(--font-mono)', fontSize: '0.88em' },
  '.cm-table-wrap': {
    overflowX: 'auto',
    padding: '10px 0',
    maxWidth: '100%',
  },
  /*
   * Room for the handles, and something for them to be positioned against.
   *
   * Only where cells are typed into: in live preview and reading mode a table
   * has no handles, and a gutter held open for controls that never appear would
   * push every table off the left margin the rest of the note keeps to.
   */
  '.cm-table-editable': { position: 'relative', paddingTop: '24px', paddingLeft: '24px' },
  '.cm-table-handle': {
    position: 'absolute',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '2px',
    margin: '0',
    padding: '0',
    border: 'none',
    borderRadius: '6px',
    background: 'transparent',
    color: 'var(--text-faint)',
    cursor: 'grab',
    // The handles are dragged, so the browser must not read a drag on one as a
    // scroll — on a phone that is the difference between moving a row and
    // moving the page.
    touchAction: 'none',
    /*
     * And a handle is a control, not text. Left as text it is something an
     * iPhone offers to select, magnify and drag a caret through, which is a
     * gesture that takes precedence over anything the page wanted to do with
     * the same finger.
     */
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitTouchCallout: 'none',
    WebkitTapHighlightColor: 'transparent',
    transform: 'translate(-50%, -50%)',
    zIndex: '2',
  },
  /*
   * `hidden` has to be said twice.
   *
   * The attribute's own `display: none` comes from the browser's stylesheet and
   * loses to any rule with a class in it — including the one above. Without
   * this a handle is drawn whether or not anything asked for it, which is how
   * one outlived the cell it belonged to: still on screen, still looking like
   * the row was picked out, and inert, because the cell it spoke for was gone.
   */
  '.cm-table-handle[hidden], .cm-table-band[hidden]': { display: 'none' },
  '.cm-table-handle[data-axis="col"]': { flexDirection: 'row', width: '34px', height: '15px' },
  '.cm-table-handle[data-axis="row"]': { flexDirection: 'column', width: '15px', height: '34px' },
  '.cm-table-handle i': {
    display: 'block',
    width: '3px',
    height: '3px',
    borderRadius: '50%',
    backgroundColor: 'currentColor',
  },
  /*
   * A finger's worth of target around a thumbnail-sized control.
   *
   * The dots are 15px across because that is what reads well beside a table;
   * what you actually hit is this, and it fills the gutter the wrap holds open
   * — exactly, not over: the handle is centred in that gutter, so the reach
   * sideways is half of it, and a pixel more would be clipped by the wrap's own
   * scrolling box at one end and stealing taps from the first cell at the
   * other. Lengthways there is nothing in the way, so it runs long.
   */
  '.cm-table-handle::before': { content: '""', position: 'absolute' },
  '.cm-table-handle[data-axis="col"]::before': { inset: '-4.5px -12px' },
  '.cm-table-handle[data-axis="row"]::before': { inset: '-12px -4.5px' },
  // A thumb needs more of one than a mouse does; see the touch block at the
  // foot of this file, where everything sized for a finger lives.
  '.cm-table-handle:hover': { color: 'var(--text-muted)' },
  '.cm-table-handle[data-on="1"]': {
    backgroundColor: 'var(--accent)',
    color: 'var(--text-on-accent)',
  },
  '.cm-table-wrap[data-dragging] .cm-table-handle': { cursor: 'grabbing' },
  /*
   * The outline round a picked-out row or column.
   *
   * One box over the band rather than a border on each of its cells: a row is
   * selected as one thing, and drawing it cell by cell would put internal lines
   * through it and say the opposite.
   */
  '.cm-table-band': {
    position: 'absolute',
    pointerEvents: 'none',
    border: '2px solid var(--accent)',
    borderRadius: '5px',
    zIndex: '1',
  },
  '&.cm-rich .cm-table-cell[data-band]': { backgroundColor: 'var(--accent-soft)' },
  '.cm-table-render': {
    borderCollapse: 'collapse',
    fontSize: '0.94em',
    minWidth: '50%',
  },
  '.cm-table-render th, .cm-table-render td': {
    border: '1px solid var(--border)',
    padding: '5px 11px',
    textAlign: 'left',
    verticalAlign: 'top',
    /*
     * A cell you have not typed into yet still has to be a target you can hit.
     * Without a floor, a freshly inserted table collapses to a few pixels of
     * grid and there is nowhere to click.
     */
    minWidth: '64px',
    height: '1.9em',
  },
  '.cm-table-render th': {
    fontWeight: '650',
    backgroundColor: 'var(--surface-2)',
  },
  /* Cells you type in — rich text only; live preview edits the pipes. */
  '&.cm-rich .cm-table-cell': {
    cursor: 'text',
    caretColor: 'var(--accent)',
    outline: 'none',
  },
  '&.cm-rich .cm-table-cell:focus': {
    backgroundColor: 'var(--accent-soft)',
    boxShadow: 'inset 0 0 0 1.5px var(--accent)',
  },
  /*
   * The cell the toolbar is aimed at, while nothing is focused.
   *
   * On a phone the Format sheet only opens once the keyboard is down, so the
   * cell being formatted has necessarily lost its focus ring — and a table you
   * are adding a row to with no idea which row you are beside is a guess. The
   * class is only on the editor while a cell really is the target, so this mark
   * disappears the moment the note takes focus back.
   */
  '&.cm-rich.cm-cell-editing .cm-table-cell[data-armed="1"]': {
    backgroundColor: 'var(--accent-soft)',
    boxShadow: 'inset 0 0 0 1.5px var(--accent)',
  },
  /* Inline markdown rendered into cells by the inline renderer. These need
     their own rules: they are widget DOM, so the editor's own syntax
     highlighting never reaches them. */
  '.cm-table-render code': {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.88em',
    color: 'var(--code-text)',
    background: 'var(--code-bg)',
    padding: '1px 5px',
    borderRadius: '5px',
  },
  '.cm-table-render a': {
    color: 'var(--accent)',
    textDecoration: 'none',
    borderBottom: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)',
  },
  '.cm-table-render a:hover': { borderBottomColor: 'var(--accent)' },
  '.cm-table-render del': { color: 'var(--text-muted)' },
  '.cm-table-render .cm-tag': { fontSize: '0.9em' },
  '.cm-inline-img': {
    maxHeight: '90px',
    maxWidth: '100%',
    borderRadius: '6px',
    verticalAlign: 'middle',
    cursor: 'zoom-in',
  },
  '.cm-line.cm-frontmatter': {
    backgroundClip: 'padding-box',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.8em',
    lineHeight: '1.75',
    color: 'var(--text-faint)',
    backgroundColor: 'var(--code-bg)',
    padding: '0 12px',
  },
  '.cm-line.cm-frontmatter-first': {
    borderRadius: '8px 8px 0 0',
    paddingTop: '7px',
  },
  '.cm-line.cm-frontmatter-last': {
    borderRadius: '0 0 8px 8px',
    paddingBottom: '7px',
    borderBottom: '14px solid transparent',
  },

  /* --- inline styles markdown has no node for ------------------------ */
  '.cm-underline': { textDecoration: 'underline', textUnderlineOffset: '2px' },
  '.cm-highlight': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 26%, transparent)',
    borderRadius: '3px',
    padding: '0 2px',
  },

  /*
   * Rich text mode.
   *
   * Nothing structural changes — the same decorations run — but with no syntax
   * ever on screen, a note that opens on a title should start at the top of
   * the page rather than under a phantom indent.
   */
  '&.cm-rich .cm-content > .cm-line:first-child': { paddingTop: '0' },

  /* --- inline widgets ----------------------------------------------- */
  '.cm-hr': {
    display: 'inline-block',
    width: '100%',
    borderTop: '1px solid var(--border-strong)',
    verticalAlign: 'middle',
  },
  '.cm-wikilink': {
    color: 'var(--accent)',
    cursor: 'pointer',
    textDecoration: 'none',
    borderBottom: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)',
  },
  '.cm-wikilink:hover': { borderBottomColor: 'var(--accent)' },
  /* External links — http, mailto, tel, ssh, whatever the machine handles. */
  '.cm-uri': {
    color: 'var(--accent)',
    cursor: 'pointer',
    textDecoration: 'underline',
    textDecorationColor: 'color-mix(in srgb, var(--accent) 40%, transparent)',
    textUnderlineOffset: '2px',
  },
  '.cm-uri:hover': { textDecorationColor: 'var(--accent)' },
  '.cm-wikilink-broken': {
    color: 'var(--text-muted)',
    borderBottom: '1px dashed var(--text-faint)',
    cursor: 'pointer',
  },
  '.cm-tag': {
    color: 'var(--accent)',
    backgroundColor: 'color-mix(in srgb, var(--accent) 12%, transparent)',
    borderRadius: '5px',
    padding: '1px 6px',
  },
  '.cm-bullet': {
    display: 'inline-block',
    color: 'var(--text-faint)',
    transform: 'scale(1.25)',
  },
  '.cm-task-checkbox': {
    appearance: 'none',
    width: '1.02em',
    height: '1.02em',
    margin: '0 0.45em 0 0',
    verticalAlign: '-0.15em',
    border: '1.5px solid var(--border-strong)',
    borderRadius: '4px',
    cursor: 'pointer',
    position: 'relative',
    flex: '0 0 auto',
  },
  '.cm-task-checkbox:checked': {
    backgroundColor: 'var(--accent)',
    borderColor: 'var(--accent)',
  },
  '.cm-task-checkbox:checked::after': {
    content: '""',
    position: 'absolute',
    left: '0.3em',
    top: '0.12em',
    width: '0.24em',
    height: '0.48em',
    border: 'solid #fff',
    borderWidth: '0 2px 2px 0',
    transform: 'rotate(45deg)',
  },
  '.cm-task-done': { color: 'var(--text-faint)', textDecoration: 'line-through' },

  /*
   * The due chip, in the note itself. Same control as the task list's
   * `.due-chip`, sized to sit in a line of prose rather than in a list — so
   * everything is in `em` and it rides the text's own baseline.
   */
  '.cm-due-chip': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: '0.4em',
    padding: '0.05em 0.5em',
    borderRadius: '999px',
    border: '1px solid transparent',
    fontSize: '0.78em',
    fontWeight: '600',
    fontFamily: 'var(--font-body)',
    lineHeight: '1.5',
    whiteSpace: 'nowrap',
    verticalAlign: '0.06em',
    cursor: 'pointer',
    color: 'var(--text-faint)',
    backgroundColor: 'var(--surface-2)',
    textDecoration: 'none',
  },
  /* Unset: an outline the width of a small calendar glyph, on the caret's line only. */
  '.cm-due-chip[data-set="0"]': {
    backgroundColor: 'transparent',
    borderStyle: 'dashed',
    borderColor: 'var(--border-strong)',
    opacity: '0.6',
    minWidth: '1.9em',
    minHeight: '1.35em',
    backgroundImage:
      'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%238e8e93\' stroke-width=\'2\' stroke-linecap=\'round\'><rect x=\'3.5\' y=\'5\' width=\'17\' height=\'15.5\' rx=\'2.5\'/><path d=\'M3.5 9.5h17M8 3v4M16 3v4\'/></svg>")',
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'center',
    backgroundSize: '0.85em',
  },
  '.cm-due-chip[data-set="0"]:hover': { opacity: '1' },
  '.cm-due-chip[data-tone="over"]': {
    color: 'var(--danger)',
    backgroundColor: 'color-mix(in srgb, var(--danger) 14%, transparent)',
  },
  '.cm-due-chip[data-tone="today"], .cm-due-chip[data-tone="soon"]': {
    color: 'var(--accent)',
    backgroundColor: 'color-mix(in srgb, var(--accent) 14%, transparent)',
  },
  '.cm-due-chip:hover': { borderColor: 'var(--border-strong)' },
  /* A finished task's date is history; it shouldn't shout. */
  '.cm-task-done .cm-due-chip': { opacity: '0.55', textDecoration: 'none' },

  '.cm-embed': {
    /*
     * Inline-block, bottom-aligned, and this is the whole reason there is no
     * space around a picture.
     *
     * A `display: block` widget inside CodeMirror's inline wrapper splits the
     * line into anonymous blocks, and the empty inline boxes either side of it
     * — CodeMirror's own widget buffers — each take a full line box. That was
     * a 24px band above the image and another below it, from a rule nobody
     * wrote. As an inline-level box the widget shares the line's box instead,
     * and aligning it to the bottom keeps the line's strut from hanging below
     * it as descender space.
     *
     * So an image sits exactly where its line sits: a line of text immediately
     * above or below it is immediately above or below it, and anyone who wants
     * air around a picture writes a blank line, which is what a blank line is
     * for.
     */
    display: 'inline-block',
    verticalAlign: 'bottom',
    position: 'relative',
    maxWidth: '100%',
  },
  '.cm-embed img, .cm-embed video': {
    display: 'block',
    maxWidth: '100%',
    height: 'auto',
    borderRadius: '10px',
    cursor: 'zoom-in',
    backgroundColor: 'var(--surface-2)',
  },
  /*
   * A player is given a width so it can be dragged to another one. Left to
   * itself an <audio> element is whatever width that browser's controls happen
   * to want, which is a different number on each of them and not a number the
   * resize handle can start from.
   */
  '.cm-embed audio': {
    display: 'block',
    width: '340px',
    maxWidth: '100%',
  },
  '.cm-embed-resize': {
    position: 'absolute',
    right: '-3px',
    top: '0',
    bottom: '0',
    width: '12px',
    cursor: 'ew-resize',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    opacity: '0',
    transition: 'opacity .12s',
  },
  '.cm-embed:hover .cm-embed-resize': { opacity: '1' },
  '.cm-embed-resize::after': {
    content: '""',
    width: '4px',
    height: '38px',
    maxHeight: '60%',
    borderRadius: '3px',
    backgroundColor: 'var(--accent)',
    boxShadow: '0 0 0 2px var(--bg)',
  },
  '.cm-embed-card': {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '10px 14px',
    border: '1px solid var(--border)',
    borderRadius: '10px',
    backgroundColor: 'var(--surface-2)',
    cursor: 'pointer',
    maxWidth: '420px',
    fontSize: '0.92em',
  },
  '.cm-embed-card:hover': { borderColor: 'var(--border-strong)' },
  '.cm-embed-card svg': { flexShrink: '0', color: 'var(--text-muted)' },

  /* --- an embedded PDF: its first page, and what it is ---------------- */
  '.cm-embed-pdf': {
    width: '420px',
    maxWidth: '100%',
    border: '1px solid var(--border)',
    borderRadius: '10px',
    overflow: 'hidden',
    backgroundColor: 'var(--surface-2)',
    cursor: 'zoom-in',
  },
  '.cm-embed-pdf:hover': { borderColor: 'var(--border-strong)' },
  '.cm-embed-pdf-page': {
    display: 'block',
    width: '100%',
    height: 'auto',
    // Paper is white in both themes; a dark card behind a page still loading
    // would flash to white the moment it draws.
    backgroundColor: '#fff',
    // Until the first page has been measured there is nothing to hold the box
    // open, and a note would reflow around it as each PDF arrives.
    minHeight: '120px',
  },
  '.cm-embed-pdf-foot': {
    display: 'flex',
    alignItems: 'center',
    gap: '7px',
    padding: '7px 10px',
    borderTop: '1px solid var(--border)',
    fontSize: '0.82em',
    color: 'var(--text-muted)',
  },
  '.cm-embed-pdf-name': {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'var(--text)',
  },
  '.cm-embed-pdf-meta': { marginLeft: 'auto', flexShrink: '0' },
  /*
   * A property read into the body.
   *
   * No chip, no colour, no border: the point of `$(client)` is a note that
   * reads as though the name had been typed into the sentence, so a filled
   * value is styled as the text around it. What it gets instead is a tooltip,
   * and a hint under the pointer in rich text, where clicking opens the form.
   */
  '.cm-var': { borderRadius: '3px' },
  '.cm-rich .cm-var[data-var]': { cursor: 'pointer' },
  '.cm-rich .cm-var[data-var]:hover': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 12%, transparent)',
  },
  /* An empty one is the other half: a blank wearing its own name. */
  '.cm-var-blank': {
    padding: '0 6px',
    border: '1px dashed var(--border-strong)',
    color: 'var(--text-muted)',
    fontSize: '0.92em',
  },
  '.cm-embed-missing': {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: '6px',
    border: '1px dashed var(--border-strong)',
    color: 'var(--text-muted)',
    fontSize: '0.9em',
  },

  /* --- autocomplete -------------------------------------------------- */
  '.cm-tooltip': {
    backgroundColor: 'var(--surface-float)',
    border: '1px solid var(--border)',
    borderRadius: '10px',
    boxShadow: 'var(--shadow-float)',
    overflow: 'hidden',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--font-body)',
    fontSize: '13px',
    maxHeight: '17em',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '5px 10px' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--accent)',
    color: '#fff',
  },
  '.cm-completionLabel': { fontWeight: '500' },
  '.cm-completionDetail': { color: 'var(--text-faint)', fontStyle: 'normal', marginLeft: '8px' },
  'li[aria-selected] .cm-completionDetail': { color: 'rgba(255,255,255,.75)' },
  /*
   * A suggestion is a tap target on a touch screen, and a 26px row is not one.
   * The rest of the app holds itself to 44px; this list is reached with a
   * thumb like everything else, so it does too.
   */
  '@media (pointer: coarse)': {
    '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontSize: '15px' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
      minHeight: '44px',
      padding: '0 14px',
      display: 'flex',
      alignItems: 'center',
    },
    /*
     * A table's handles, for the same reason and by the same measure.
     *
     * The dots stay the size they are — they sit beside a table and have to
     * look it — and the gutter they live in grows instead, taking the area
     * that answers to them with it. The gutter is also what the handles
     * position themselves against, so they stay centred in it here without
     * being told this number twice.
     */
    '.cm-table-editable': { paddingTop: '30px', paddingLeft: '30px' },
    '.cm-table-handle[data-axis="col"]::before': { inset: '-7.5px -18px' },
    '.cm-table-handle[data-axis="row"]::before': { inset: '-18px -7.5px' },
  },

  /* --- find in note -------------------------------------------------- */
  '.cm-searchMatch': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 25%, transparent)',
    borderRadius: '3px',
  },
  '.cm-searchMatch-selected': { backgroundColor: 'var(--accent)', color: '#fff' },
  '.cm-panels': {
    backgroundColor: 'var(--surface-float)',
    color: 'var(--text)',
    borderBottom: '1px solid var(--border)',
  },
  '.cm-panel input, .cm-panel button': {
    fontFamily: 'var(--font-body)',
    fontSize: '13px',
    borderRadius: '6px',
    border: '1px solid var(--border)',
    background: 'var(--surface-2)',
    color: 'var(--text)',
    padding: '3px 7px',
  },
})

export const markdownHighlight = HighlightStyle.define([
  { tag: t.heading, color: 'var(--text)' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--text-muted)' },
  { tag: t.link, color: 'var(--accent)' },
  { tag: t.url, color: 'var(--text-faint)' },
  { tag: [wikiLinkTag, wikiEmbedTag], color: 'var(--accent)' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)', fontSize: '0.9em', color: 'var(--code-text)' },
  { tag: t.processingInstruction, color: 'var(--text-faint)' },
  { tag: t.contentSeparator, color: 'var(--text-faint)' },
  { tag: t.quote, color: 'var(--text-muted)' },
  // Code-block syntax, via @codemirror/language-data.
  { tag: t.keyword, color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--syn-number)' },
  { tag: t.comment, color: 'var(--text-faint)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.definition(t.variableName)], color: 'var(--syn-fn)' },
  { tag: [t.typeName, t.className], color: 'var(--syn-type)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--syn-prop)' },
  { tag: t.operator, color: 'var(--text-muted)' },
  { tag: t.invalid, color: 'var(--danger)' },
])

export const highlighting = syntaxHighlighting(markdownHighlight, { fallback: true })
