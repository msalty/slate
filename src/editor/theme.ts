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
    padding: '8px 0 45vh 0',
    caretColor: 'var(--accent)',
    maxWidth: 'var(--editor-measure)',
    margin: '0 auto',
    width: '100%',
  },
  '.cm-line': { padding: '0 4px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--selection)',
  },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-gutters': { display: 'none' },
  '.cm-placeholder': { color: 'var(--text-faint)', fontStyle: 'normal' },

  /* --- block-level live preview ------------------------------------- */
  '.cm-line.cm-h1': { fontSize: '1.75em', fontWeight: '700', lineHeight: '1.25', margin: '0.7em 0 0.1em' },
  '.cm-line.cm-h2': { fontSize: '1.4em', fontWeight: '700', lineHeight: '1.3', margin: '0.7em 0 0.1em' },
  '.cm-line.cm-h3': { fontSize: '1.18em', fontWeight: '650', lineHeight: '1.35', margin: '0.6em 0 0.1em' },
  '.cm-line.cm-h4': { fontSize: '1.05em', fontWeight: '650', margin: '0.5em 0 0.1em' },
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
  '.cm-line.cm-codeblock': {
    backgroundColor: 'var(--code-bg)',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.9em',
    padding: '0 12px',
  },
  '.cm-line.cm-codeblock-first': {
    borderRadius: '8px 8px 0 0',
    paddingTop: '8px',
    marginTop: '6px',
  },
  '.cm-line.cm-codeblock-last': {
    borderRadius: '0 0 8px 8px',
    paddingBottom: '8px',
    marginBottom: '6px',
  },
  '.cm-line.cm-table': { fontFamily: 'var(--font-mono)', fontSize: '0.88em' },
  '.cm-table-wrap': {
    overflowX: 'auto',
    margin: '10px 0',
    maxWidth: '100%',
  },
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
  },
  '.cm-table-render th': {
    fontWeight: '650',
    backgroundColor: 'var(--surface-2)',
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
    marginBottom: '14px',
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
   * ever on screen the text can breathe like a document rather than a source
   * file: a little more air between paragraphs, and a first line that sits at
   * the top of the note instead of under a phantom margin.
   */
  '&.cm-rich .cm-line': { paddingTop: '1px', paddingBottom: '1px' },
  '&.cm-rich .cm-line.cm-h1': { margin: '0.8em 0 0.15em' },
  '&.cm-rich .cm-line.cm-h2': { margin: '0.8em 0 0.15em' },
  '&.cm-rich .cm-content > .cm-line:first-child': { marginTop: '0' },

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

  '.cm-embed': {
    display: 'block',
    position: 'relative',
    margin: '10px 0',
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
