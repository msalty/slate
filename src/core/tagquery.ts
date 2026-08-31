/**
 * The boolean rule language behind Tag Folders.
 *
 *   #work AND #active NOT #archived
 *   #work AND (#urgent OR #blocked)
 *   folder:Work #network -#done
 *
 * Grammar, lowest precedence first:
 *
 *   expr    := or
 *   or      := and (OR and)*
 *   and     := unary (AND? unary)*        // adjacency means AND
 *   unary   := (NOT | '-') unary | '(' expr ')' | term
 *   term    := '#'? word | key ':' value
 *
 * Adjacency binding as AND is what makes `#work #active` do the obvious thing,
 * and it is why `and` has to stop at a token it cannot start a term with —
 * otherwise `#a OR #b` would parse as `#a AND (OR ...)` and fail.
 *
 * Tags match hierarchically: `#work` matches a note tagged `#work/active`, the
 * same way the tag sidebar treats nested tags.
 */

export type QueryNode =
  | { t: 'tag'; name: string }
  | { t: 'folder'; path: string }
  | { t: 'has'; what: 'tasks' | 'images' | 'attachments' | 'links' }
  | { t: 'and'; l: QueryNode; r: QueryNode }
  | { t: 'or'; l: QueryNode; r: QueryNode }
  | { t: 'not'; n: QueryNode }
  | { t: 'all' }

export interface ParseResult {
  node?: QueryNode
  /** Human-readable problem, suitable for showing under the input. */
  error?: string
  /** Character offset the error points at. */
  at?: number
}

/** Everything a rule can be evaluated against. */
export interface QueryContext {
  tags: string[]
  folder: string
  hasTasks: boolean
  hasImages: boolean
  hasAttachments: boolean
  hasLinks: boolean
}

/* ---------------------------------------------------------------- tokenize */

type Tok =
  | { k: 'lparen'; at: number }
  | { k: 'rparen'; at: number }
  | { k: 'and'; at: number }
  | { k: 'or'; at: number }
  | { k: 'not'; at: number }
  | { k: 'tag'; v: string; at: number }
  | { k: 'key'; key: string; v: string; at: number }

const WORD = /[A-Za-z0-9_/\-.]/

function tokenize(src: string): { toks: Tok[]; error?: string; at?: number } {
  const toks: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '(') {
      toks.push({ k: 'lparen', at: i++ })
      continue
    }
    if (c === ')') {
      toks.push({ k: 'rparen', at: i++ })
      continue
    }
    // "-" negates only when it leads a term; inside a word it is a literal.
    if (c === '-' && (i === 0 || /[\s(]/.test(src[i - 1]))) {
      toks.push({ k: 'not', at: i++ })
      continue
    }
    if (c === '!') {
      toks.push({ k: 'not', at: i++ })
      continue
    }

    const start = i
    let hadHash = false
    if (c === '#') {
      hadHash = true
      i++
    }
    let word = ''
    while (i < src.length && WORD.test(src[i])) word += src[i++]

    if (!word) {
      return { toks, error: `Unexpected "${c}"`, at: start }
    }

    // A bare AND/OR/NOT is an operator; "#and" is a tag called "and".
    if (!hadHash) {
      const upper = word.toUpperCase()
      if (upper === 'AND') {
        toks.push({ k: 'and', at: start })
        continue
      }
      if (upper === 'OR') {
        toks.push({ k: 'or', at: start })
        continue
      }
      if (upper === 'NOT') {
        toks.push({ k: 'not', at: start })
        continue
      }
    }

    // key:value — only when a colon follows immediately and the word is a
    // recognized key, so "#a:b" stays one odd-looking tag rather than erroring.
    if (!hadHash && src[i] === ':') {
      const key = word.toLowerCase()
      if (key === 'folder' || key === 'in' || key === 'has' || key === 'tag') {
        i++
        let val = ''
        if (src[i] === '"') {
          i++
          while (i < src.length && src[i] !== '"') val += src[i++]
          i++
        } else {
          while (i < src.length && WORD.test(src[i])) val += src[i++]
        }
        if (!val) return { toks, error: `"${key}:" needs a value`, at: start }
        toks.push({ k: 'key', key, v: val, at: start })
        continue
      }
    }

    toks.push({ k: 'tag', v: word, at: start })
  }
  return { toks }
}

/* ------------------------------------------------------------------- parse */

const HAS_VALUES = ['tasks', 'images', 'attachments', 'links'] as const

export function parseQuery(src: string): ParseResult {
  const { toks, error, at } = tokenize(src)
  if (error) return { error, at }
  if (!toks.length) return { node: { t: 'all' } }

  let p = 0
  const peek = () => toks[p]
  let failure: ParseResult | undefined

  const fail = (msg: string, pos?: number): undefined => {
    failure ??= { error: msg, at: pos ?? peek()?.at ?? src.length }
    return undefined
  }

  /** Can this token begin a term? Drives where implicit AND stops. */
  const startsTerm = (t: Tok | undefined) =>
    !!t && (t.k === 'tag' || t.k === 'key' || t.k === 'lparen' || t.k === 'not')

  function parseUnary(): QueryNode | undefined {
    const t = peek()
    if (!t) return fail('Rule ends unexpectedly')
    if (t.k === 'not') {
      p++
      const n = parseUnary()
      return n && { t: 'not', n }
    }
    if (t.k === 'lparen') {
      p++
      const inner = parseOr()
      if (!inner) return undefined
      if (peek()?.k !== 'rparen') return fail('Missing ")"')
      p++
      return inner
    }
    if (t.k === 'tag') {
      p++
      return { t: 'tag', name: t.v.toLowerCase() }
    }
    if (t.k === 'key') {
      p++
      if (t.key === 'tag') return { t: 'tag', name: t.v.toLowerCase() }
      if (t.key === 'folder' || t.key === 'in') return { t: 'folder', path: t.v }
      const what = t.v.toLowerCase()
      if (!(HAS_VALUES as readonly string[]).includes(what))
        return fail(`has: expects one of ${HAS_VALUES.join(', ')}`, t.at)
      return { t: 'has', what: what as 'tasks' }
    }
    if (t.k === 'rparen') return fail('Unexpected ")"', t.at)
    return fail('Expected a tag', t.at)
  }

  function parseAnd(): QueryNode | undefined {
    let left = parseUnary()
    if (!left) return undefined
    for (;;) {
      const t = peek()
      if (t?.k === 'and') {
        p++
        const right = parseUnary()
        if (!right) return undefined
        left = { t: 'and', l: left, r: right }
        continue
      }
      // Adjacency: two terms in a row mean AND.
      if (startsTerm(t)) {
        const right = parseUnary()
        if (!right) return undefined
        left = { t: 'and', l: left, r: right }
        continue
      }
      return left
    }
  }

  function parseOr(): QueryNode | undefined {
    let left = parseAnd()
    if (!left) return undefined
    while (peek()?.k === 'or') {
      p++
      const right = parseAnd()
      if (!right) return undefined
      left = { t: 'or', l: left, r: right }
    }
    return left
  }

  const node = parseOr()
  if (!node) return failure ?? { error: 'Could not read that rule' }
  if (p < toks.length) return { error: 'Unexpected extra text', at: toks[p].at }
  return { node }
}

/* ---------------------------------------------------------------- evaluate */

/** `#work` matches `work` and `work/active`, but not `workshop`. */
function tagMatches(query: string, tag: string): boolean {
  const t = tag.toLowerCase()
  return t === query || t.startsWith(`${query}/`)
}

export function evaluateQuery(node: QueryNode, ctx: QueryContext): boolean {
  switch (node.t) {
    case 'all':
      return true
    case 'tag':
      return ctx.tags.some((t) => tagMatches(node.name, t))
    case 'folder': {
      const want = node.path.replace(/^\/+|\/+$/g, '').toLowerCase()
      const have = ctx.folder.toLowerCase()
      if (!want) return have === ''
      return have === want || have.startsWith(`${want}/`)
    }
    case 'has':
      return node.what === 'tasks'
        ? ctx.hasTasks
        : node.what === 'images'
          ? ctx.hasImages
          : node.what === 'attachments'
            ? ctx.hasAttachments
            : ctx.hasLinks
    case 'not':
      return !evaluateQuery(node.n, ctx)
    case 'and':
      return evaluateQuery(node.l, ctx) && evaluateQuery(node.r, ctx)
    case 'or':
      return evaluateQuery(node.l, ctx) || evaluateQuery(node.r, ctx)
  }
}

/** Every tag named anywhere in a rule — used to seed a new note's frontmatter. */
export function tagsInQuery(node: QueryNode, negated = false): string[] {
  switch (node.t) {
    case 'tag':
      return negated ? [] : [node.name]
    case 'not':
      return tagsInQuery(node.n, !negated)
    case 'and':
    case 'or':
      return [...tagsInQuery(node.l, negated), ...tagsInQuery(node.r, negated)]
    default:
      return []
  }
}

/** The folder a rule pins to, if it names exactly one. */
export function folderInQuery(node: QueryNode): string | undefined {
  const found: string[] = []
  const walk = (n: QueryNode, neg: boolean) => {
    if (n.t === 'folder' && !neg) found.push(n.path)
    else if (n.t === 'not') walk(n.n, !neg)
    else if (n.t === 'and' || n.t === 'or') {
      walk(n.l, neg)
      walk(n.r, neg)
    }
  }
  walk(node, false)
  return found.length === 1 ? found[0] : undefined
}

/** One-line plain-English gloss, shown under the rule field. */
export function describeQuery(node: QueryNode): string {
  const render = (n: QueryNode, depth: number): string => {
    switch (n.t) {
      case 'all':
        return 'every note'
      case 'tag':
        return `#${n.name}`
      case 'folder':
        return `in ${n.path}`
      case 'has':
        return `has ${n.what}`
      case 'not':
        return `not ${render(n.n, depth + 1)}`
      case 'and': {
        const s = `${render(n.l, depth + 1)} and ${render(n.r, depth + 1)}`
        return depth > 0 ? `(${s})` : s
      }
      case 'or': {
        const s = `${render(n.l, depth + 1)} or ${render(n.r, depth + 1)}`
        return depth > 0 ? `(${s})` : s
      }
    }
  }
  return render(node, 0)
}
