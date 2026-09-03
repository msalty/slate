/**
 * Reading a fenced code block back out of the document.
 *
 * The copy button needs the code *without* its fences, and it needs it at the
 * moment it is clicked rather than at the moment it was drawn — so the widget
 * stays comparable (`eq()` is always true, no rebuild on every keystroke) and
 * always copies what is on screen now.
 *
 * Line-based, and deliberately not the syntax tree: the same reasoning as
 * `findTables` in livePreview.ts. A block being typed into has no closing fence
 * yet, and this still has to return the lines above the caret rather than
 * nothing.
 */

/**
 * The body of the fence that opens at `openIndex` (0-based), fences excluded.
 *
 * Returns undefined when that line is not an opening fence. An unclosed block
 * runs to the end of the document, which is what it looks like on screen.
 *
 * The opening fence's own indentation is stripped from every line, so a block
 * nested in a list item copies as code rather than as code plus three spaces.
 */
export function fencedBody(lines: string[], openIndex: number): string | undefined {
  const open = /^(\s*)(`{3,}|~{3,})/.exec(lines[openIndex] ?? '')
  if (!open) return undefined
  const [, indent, fence] = open
  // A fence is closed by one of its own kind, at least as long as the opener.
  const close = new RegExp(`^\\s*${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`)

  const body: string[] = []
  for (let i = openIndex + 1; i < lines.length; i++) {
    const line = lines[i]
    if (close.test(line)) break
    body.push(indent && line.startsWith(indent) ? line.slice(indent.length) : line)
  }
  return body.join('\n')
}
