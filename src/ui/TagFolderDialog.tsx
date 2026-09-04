/**
 * Create or edit a Tag Folder.
 *
 * The rule is a text expression, with the vault's own tags offered as chips to
 * tap in — which is what makes it workable on a phone, where typing `#` and a
 * tag name is genuinely tedious. Everything validates live: an invalid rule
 * names the problem and points at it, and a valid one shows how many notes it
 * currently matches before you commit.
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { signal } from '@preact/signals'
import { allTags } from '../core/vault'
import {
  allFolderPaths,
  effectiveNode,
  notesForSmartFolder,
  notesMatching,
  tasksMatching,
  saveSmartFolder,
  smartFolderAncestors,
  smartFolderById,
  smartFolderList,
  type SmartFolder,
} from '../core/folders'
import { describeQuery, parseQuery, type QueryNode } from '../core/tagquery'
import { notify, scope } from './state'
import { IconClose } from './Icons'

const editing = signal<Partial<SmartFolder> | null>(null)

export function openTagFolderDialog(existing?: SmartFolder, parentId?: string) {
  editing.value = existing ?? { name: '', query: '', icon: '🏷️', parentId, inherit: true }
}

/*
 * The tick is here for a folder that gathers tasks. It is a choice, not a
 * statement — the row draws its own tick from what the folder actually does,
 * because an icon anyone can put on anything cannot be trusted to say so.
 */
const ICONS = ['🏷️', '✅', '☑️', '⭐️', '🔥', '📌', '💼', '🏠', '🧠', '📚', '🧾', '🌱', '⚡️', '🎯']

export function TagFolderDialog() {
  const draft = editing.value
  const [name, setName] = useState('')
  const [query, setQuery] = useState('')
  const [icon, setIcon] = useState('🏷️')
  const [parentId, setParentId] = useState<string>('')
  const [inherit, setInherit] = useState(true)
  const [shows, setShows] = useState<'notes' | 'tasks'>('notes')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!draft) return
    setName(draft.name ?? '')
    setQuery(draft.query ?? '')
    setIcon(draft.icon ?? '🏷️')
    setParentId(draft.parentId ?? '')
    setInherit(draft.inherit ?? true)
    setShows(draft.shows === 'tasks' ? 'tasks' : 'notes')
    requestAnimationFrame(() => (draft.id ? inputRef : nameRef).current?.focus())
  }, [draft])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') editing.value = null
    }
    if (draft) addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [draft])

  const parsed = useMemo(() => parseQuery(query), [query])

  /**
   * What the parent contributes, so the dialog can show the rule that will
   * actually be applied rather than only the part being typed. Computed from
   * the saved tree, which is why a folder can't be its own ancestor here.
   */
  const inheritedNode = useMemo<QueryNode | undefined>(() => {
    if (!parentId || !inherit) return undefined
    return effectiveNode(parentId)
  }, [parentId, inherit, draft])

  const combined = useMemo<QueryNode | undefined>(() => {
    const own = parsed.node && parsed.node.t !== 'all' ? parsed.node : undefined
    if (own && inheritedNode) return { t: 'and', l: inheritedNode, r: own }
    return own ?? inheritedNode
  }, [parsed.node, inheritedNode])

  const matches = useMemo(
    () => (combined ? notesMatching(combined) : []),
    [combined, query],
  )
  const taskMatches = useMemo(
    () => (combined && shows === 'tasks' ? tasksMatching(combined) : []),
    [combined, query, shows],
  )
  const hits = shows === 'tasks' ? taskMatches.length : matches.length

  if (!draft) return null

  // A folder can't be moved inside itself or anything nested beneath it.
  const parentOptions = smartFolderList.value.filter(
    (n) =>
      n.folder.id !== draft.id &&
      !(draft.id && smartFolderAncestors(n.folder.id).some((a) => a.id === draft.id)),
  )
  const parentName = parentId ? smartFolderById(parentId)?.name : undefined
  const isGroup = !query.trim() && !inheritedNode

  /** Insert a token at the caret, keeping spacing sane. */
  const insert = (token: string) => {
    const el = inputRef.current
    const start = el?.selectionStart ?? query.length
    const end = el?.selectionEnd ?? query.length
    const before = query.slice(0, start)
    const after = query.slice(end)
    const needsSpace = before.length > 0 && !/\s$/.test(before)
    const text = `${before}${needsSpace ? ' ' : ''}${token}${after.startsWith(' ') || !after ? '' : ' '}${after}`
    setQuery(text)
    requestAnimationFrame(() => {
      el?.focus()
      const at = before.length + (needsSpace ? 1 : 0) + token.length
      el?.setSelectionRange(at, at)
    })
  }

  // A rule is optional: a folder with none is a grouping folder that gathers
  // whatever its children match. What can't be saved is a rule that is present
  // but doesn't parse.
  const canSave = !!parsed.node && name.trim().length > 0

  const submit = async () => {
    if (!canSave) return
    const saved = await saveSmartFolder({
      id: draft.id,
      name,
      query,
      icon,
      parentId: parentId || undefined,
      inherit,
      shows,
    })
    editing.value = null
    scope.value = { kind: 'smart', id: saved.id }
    notify(draft.id ? 'Tag Folder updated' : 'Tag Folder created')
  }

  return (
    <div class="scrim" onClick={() => (editing.value = null)}>
      <div class="dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div class="dialog-head">
          <h2>{draft.id ? 'Edit Tag Folder' : 'New Tag Folder'}</h2>
          <span style={{ flex: 1 }} />
          <button class="icon-btn" onClick={() => (editing.value = null)} aria-label="Close">
            <IconClose />
          </button>
        </div>

        <div class="dialog-body">
          <div class="field-row">
            <label class="field" style={{ flex: '0 0 auto', width: 78 }}>
              <span>Icon</span>
              <select value={icon} onChange={(e) => setIcon((e.target as HTMLSelectElement).value)}>
                {ICONS.map((i) => (
                  <option key={i} value={i}>
                    {i}
                  </option>
                ))}
              </select>
            </label>
            <label class="field">
              <span>Name</span>
              <input
                ref={nameRef}
                type="text"
                placeholder="Active work"
                value={name}
                onInput={(e) => setName((e.target as HTMLInputElement).value)}
              />
            </label>
          </div>

          {parentOptions.length > 0 && (
            <label class="field">
              <span>Inside</span>
              <select
                value={parentId}
                onChange={(e) => setParentId((e.target as HTMLSelectElement).value)}
              >
                <option value="">Top level</option>
                {parentOptions.map((n) => (
                  <option key={n.folder.id} value={n.folder.id}>
                    {'— '.repeat(n.depth)}
                    {n.folder.icon ?? '🏷️'} {n.folder.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {parentId && (
            <label class="check">
              <input
                type="checkbox"
                checked={inherit}
                onChange={(e) => setInherit((e.target as HTMLInputElement).checked)}
              />
              <span>
                Narrow “{parentName}”
                <small>
                  {inherit
                    ? 'This folder shows only notes that also match its parent, so the hierarchy reads like folders — a child is always a subset of its parent.'
                    : 'This folder is only grouped under its parent visually. Its rule stands on its own.'}
                </small>
              </span>
            </label>
          )}

          {/*
            * Notes or tasks, on the same rule language and the same folder.
            * A second tree beside the first would have meant learning "a saved
            * rule" twice; this way `#home` gathers the notes about home or the
            * jobs on them, and the only difference is what it hands back.
            */}
          <div class="field">
            <span>Gathers</span>
            <div class="seg" role="radiogroup" aria-label="What this folder gathers">
              {(['notes', 'tasks'] as const).map((k) => (
                <button
                  key={k}
                  class="seg-btn"
                  role="radio"
                  aria-checked={shows === k}
                  onClick={() => setShows(k)}
                >
                  {k === 'notes' ? 'Notes' : 'Tasks'}
                </button>
              ))}
            </div>
            <small>
              {shows === 'tasks'
                ? 'Every task on a matching note, plus any tagged on its own line — so tagging a note #home gathers the jobs on it without tagging each one.'
                : 'Notes matching the rule, the way Tag Folders have always worked.'}
            </small>
          </div>

          <label class="field">
            <span>Rule</span>
            <textarea
              ref={inputRef}
              class="rule-input"
              rows={3}
              spellcheck={false}
              autocapitalize="none"
              autocorrect="off"
              placeholder={
                parentId
                  ? 'Leave empty to group other folders, or narrow further…'
                  : '#work AND #active NOT #archived'
              }
              value={query}
              onInput={(e) => setQuery((e.target as HTMLTextAreaElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
              }}
            />
          </label>

          <div class="rule-status" data-error={parsed.error ? '1' : '0'}>
            {parsed.error ? (
              <>
                <strong>{parsed.error}</strong>
                {parsed.at !== undefined && query && (
                  <pre class="rule-caret">
                    {query.slice(0, parsed.at).replace(/[^\t]/g, ' ')}▲
                  </pre>
                )}
              </>
            ) : isGroup ? (
              <>
                No rule of its own — this will be a <strong>grouping folder</strong>, showing
                everything its nested folders match
                {draft.id ? ` (${notesForSmartFolder(draft.id).length} right now)` : ''}.
              </>
            ) : (
              <>
                Matches <strong>{hits}</strong>{' '}
                {shows === 'tasks' ? (hits === 1 ? 'task' : 'tasks') : hits === 1 ? 'note' : 'notes'} —{' '}
                {describeQuery(combined!)}
                {inheritedNode && (
                  <em class="rule-inherited">
                    inherited from {parentName}: {describeQuery(inheritedNode)}
                  </em>
                )}
              </>
            )}
          </div>

          {shows === 'tasks' && (
            <div class="chip-group">
              <div class="chip-group-label">Only these tasks</div>
              <div class="chips">
                {[
                  ['is:open', 'still to do'],
                  ['is:done', 'finished'],
                  ['due:overdue', 'past its date'],
                  ['due:today', 'today'],
                  ['due:soon', 'this week'],
                  ['due:none', 'no date'],
                ].map(([token, gloss]) => (
                  <button key={token} class="chip" onClick={() => insert(token)}>
                    {token}
                    <small>{gloss}</small>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div class="chip-group">
            <div class="chip-group-label">Operators</div>
            <div class="chips">
              {['AND', 'OR', 'NOT', '(', ')'].map((op) => (
                <button key={op} class="chip chip-op" onClick={() => insert(op)}>
                  {op}
                </button>
              ))}
            </div>
          </div>

          {allTags.value.length > 0 && (
            <div class="chip-group">
              <div class="chip-group-label">Tags</div>
              <div class="chips">
                {allTags.value.map((t) => (
                  <button key={t.tag} class="chip" onClick={() => insert(`#${t.tag}`)}>
                    #{t.tag}
                    <small>{t.count}</small>
                  </button>
                ))}
              </div>
            </div>
          )}

          {allFolderPaths.value.length > 0 && (
            <div class="chip-group">
              <div class="chip-group-label">Limit to a folder</div>
              <div class="chips">
                {allFolderPaths.value.slice(0, 30).map((f) => (
                  <button
                    key={f}
                    class="chip"
                    onClick={() => insert(f.includes(' ') ? `folder:"${f}"` : `folder:${f}`)}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div class="callout">
            Tags nest: <code>#work</code> also matches <code>#work/active</code>. Two terms side by
            side mean AND, so <code>#work #urgent</code> and <code>#work AND #urgent</code> are the
            same rule. <code>-#tag</code> and <code>!#tag</code> are shorthand for NOT. You can also
            use <code>has:tasks</code>, <code>has:images</code>, <code>has:links</code> and{' '}
            <code>has:attachments</code>.
          </div>

          {matches.length > 0 && (
            <div class="chip-group">
              <div class="chip-group-label">Preview</div>
              <div class="rule-preview">
                {shows === 'tasks'
                  ? taskMatches.slice(0, 8).map((t) => (
                      <div key={t.id} class="rule-preview-row">
                        <strong>{t.text || 'Untitled task'}</strong>
                        <small>{t.noteTitle}</small>
                      </div>
                    ))
                  : matches.slice(0, 8).map((m) => (
                      <div key={m.path} class="rule-preview-row">
                        <strong>{m.title}</strong>
                        <small>{m.tags.map((t) => `#${t}`).join(' ')}</small>
                      </div>
                    ))}
                {hits > 8 && <div class="rule-preview-more">+{hits - 8} more</div>}
              </div>
            </div>
          )}
        </div>

        <div class="dialog-foot">
          <button class="btn" onClick={() => (editing.value = null)}>
            Cancel
          </button>
          <button class="btn btn-primary" disabled={!canSave} onClick={submit}>
            {draft.id ? 'Save changes' : 'Create folder'}
          </button>
        </div>
      </div>
    </div>
  )
}
