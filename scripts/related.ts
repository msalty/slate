/**
 * The related-notes prototype: run the scoring over a real vault and look at it.
 *
 * A ranking cannot be unit-tested into being *good*. `src/core/related.test.ts`
 * pins down everything that would make a good ranking impossible — a note
 * related to itself, a tag on half the vault counting for as much as one on
 * three notes — and none of that tells you whether the answers are ones you
 * would have given. Only reading them does, for notes whose answer you already
 * know, which means your notes and not a fixture written to agree with itself.
 *
 * So this prints the answers, and *why* each one is there. The "why" is what
 * makes it falsifiable: a bad row you can attribute to a signal is a bug
 * report, and a bad row you cannot is just a feeling about the whole feature.
 *
 * Run it over a folder of markdown — a connected folder, an Obsidian vault, an
 * export, anything with `.md` files in it:
 *
 *   npx vite-node scripts/related.ts ~/Notes
 *   npx vite-node scripts/related.ts ~/Notes --note "Roof repairs"
 *   npx vite-node scripts/related.ts ~/Notes --sample 30 --floor 0.6
 *
 * It reads and writes nothing. The three numbers at the end are the ones that
 * say whether the floor is set right — see `summarise`.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { parseFrontmatter, scanTags, scanWikiLinks } from '../src/core/markdown'
import { relatedNotes, type RelatedInput } from '../src/core/related'

/* ------------------------------------------------------------------ input */

const argv = process.argv.slice(2)
const flags = new Map<string, string>()
const positional: string[] = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) flags.set(a.slice(2), argv[++i] ?? '')
  else positional.push(a)
}
const flag = (name: string) => flags.get(name)
const root = positional[0]

if (!root) {
  console.error('Usage: npx vite-node scripts/related.ts <folder> [--note "Title"] [--sample N] [--limit N] [--floor X]')
  process.exit(1)
}

const sampleSize = Number(flag('sample') ?? 12)
const limit = Number(flag('limit') ?? 8)
const floor = flag('floor') === undefined ? undefined : Number(flag('floor'))
const only = flag('note')

/* ------------------------------------------------------- read the folder */

/**
 * The same files the app would index: `.md`, no dotfiles, no `backstage/`
 * (trash, conversations and the vault's own bookkeeping), no `Templates/`.
 * Anything else and the prototype is answering about a different vault than
 * the one the feature would run in.
 */
async function walk(dir: string, base = dir, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    const rel = relative(base, full).split(sep).join('/')
    if (rel === 'backstage' || rel.startsWith('backstage/')) continue
    if (rel === 'Templates' || rel.startsWith('Templates/')) continue
    if (e.isDirectory()) await walk(full, base, out)
    else if (e.name.endsWith('.md')) out.push(rel)
  }
  return out
}

/** Exactly what `buildEntry` in core/vault.ts makes of a note. */
function entryOf(path: string, text: string): RelatedInput {
  const fm = parseFrontmatter(text)
  const tags = new Set(scanTags(text))
  const fmTags = fm.data.tags
  if (Array.isArray(fmTags)) for (const t of fmTags) tags.add(String(t).replace(/^#/, ''))
  else if (typeof fmTags === 'string' && fmTags) tags.add(fmTags.replace(/^#/, ''))

  const links: string[] = []
  for (const l of scanWikiLinks(text)) if (!l.embed && l.target) links.push(l.target)

  const slash = path.lastIndexOf('/')
  return {
    path,
    title: (slash < 0 ? path : path.slice(slash + 1)).replace(/\.md$/, ''),
    folder: slash < 0 ? '' : path.slice(0, slash),
    tags: [...tags],
    links,
  }
}

const paths = await walk(root)
const notes = await Promise.all(
  paths.map(async (p) => entryOf(p, await readFile(join(root, p), 'utf8'))),
)

if (!notes.length) {
  console.error(`No .md files under ${root}`)
  process.exit(1)
}

/* ------------------------------------------------------------- reporting */

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`

function report(n: RelatedInput) {
  const hits = relatedNotes(notes, n.path, { limit, floor })
  console.log(`\n${bold(n.title)} ${dim(`${n.folder || '/'} · ${n.tags.map((t) => `#${t}`).join(' ') || 'no tags'}`)}`)
  if (!hits.length) {
    console.log(dim('   (nothing related)'))
    return
  }
  for (const h of hits) {
    console.log(`   ${h.score.toFixed(2).padStart(5)}  ${h.note.title.padEnd(38).slice(0, 38)} ${dim(h.why.slice(0, 4).join(', '))}`)
  }
}

/**
 * The three numbers that say whether the floor is set right.
 *
 * **How many notes get nothing** should be a large fraction. Most notes in most
 * vaults have nothing much to do with each other, and a prototype where every
 * note finds eight friends has found noise, not relations.
 *
 * **The median list length** should be short — two or three. Eight is the cap,
 * and hitting it routinely means the tail is padding.
 *
 * **The median top score** says how far above the floor the good answers sit.
 * Bunched just above it, the floor is doing all the work and a small change to
 * it would change every answer.
 */
function summarise() {
  const lengths: number[] = []
  const tops: number[] = []
  for (const n of notes) {
    const hits = relatedNotes(notes, n.path, { limit, floor })
    lengths.push(hits.length)
    if (hits.length) tops.push(hits[0].score)
  }
  const median = (xs: number[]) =>
    xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0
  const empty = lengths.filter((l) => l === 0).length
  const full = lengths.filter((l) => l >= limit).length

  console.log(`\n${bold('Across the whole vault')} ${dim(`(${notes.length} notes)`)}`)
  console.log(`   nothing related    ${((empty / notes.length) * 100).toFixed(0)}%  ${dim('want this high — most notes are unrelated')}`)
  console.log(`   hit the cap of ${limit}   ${((full / notes.length) * 100).toFixed(0)}%  ${dim('want this low — a full list is usually padding')}`)
  console.log(`   median list        ${median(lengths)}   ${dim('want 1–3')}`)
  console.log(`   median top score   ${median(tops).toFixed(2)}  ${dim(`floor is ${(floor ?? Math.log(3)).toFixed(2)}`)}`)
}

/* ------------------------------------------------------------------- run */

if (only) {
  const found = notes.find((n) => n.title.toLowerCase() === only.toLowerCase())
  if (!found) {
    console.error(`No note called "${only}"`)
    process.exit(1)
  }
  report(found)
} else {
  /*
   * A spread rather than the first N, and deterministic rather than random:
   * the same vault gives the same sample twice running, so a change to the
   * scoring can be compared against the same notes rather than a fresh draw.
   */
  const step = Math.max(1, Math.floor(notes.length / sampleSize))
  for (let i = 0; i < notes.length && i / step < sampleSize; i += step) report(notes[i])
}

summarise()
