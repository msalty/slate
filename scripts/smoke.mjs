/**
 * Browser smoke test.
 *
 * Drives the built app in headless Chromium and exercises the paths that only
 * exist in a real browser: IndexedDB persistence across a reload, CodeMirror
 * live preview, wikilink autocomplete and navigation, clipboard image paste
 * with re-encoding, the lightbox, and the calendar/task rail.
 *
 * Run with:  node scripts/smoke.mjs
 */

import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

const DIST = resolve('dist')
const SHOTS = resolve('screenshots')
const PORT = 4178

/*
 * Deliberately served from a SUBDIRECTORY, not the root.
 *
 * Dropping `dist/` into something like ~/Sites/slate and serving it with Apache
 * is a completely ordinary way to run this, and it is where a root-absolute
 * asset base silently breaks: every `/assets/*.js` 404s, the server answers with
 * an HTML error page, and the browser reports a confusing MIME-type error rather
 * than a missing file. Running the entire suite under a prefix keeps the build
 * honest about being relocatable.
 */
const BASE = '/slate/'

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const path = decodeURIComponent(url.pathname)
  if (!path.startsWith(BASE)) {
    res.writeHead(404, { 'Content-Type': 'text/html' }).end('<html>outside the app</html>')
    return
  }
  const rel = path.slice(BASE.length)
  const file = join(DIST, rel === '' ? 'index.html' : rel)
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    // Answer a miss the way a plain static server does: an HTML error page.
    // That is precisely what turns a wrong asset path into a MIME-type error,
    // so the test sees the same failure a real deployment would.
    res.writeHead(404, { 'Content-Type': 'text/html' }).end('<html>404</html>')
  }
})

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

await mkdir(SHOTS, { recursive: true })
await new Promise((r) => server.listen(PORT, r))

const browser = await chromium.launch({
  // The sandbox image ships a Chromium build; use it rather than downloading one.
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox'],
})
// Touch is enabled for the whole run: the phone section needs real touch
// events, and a desktop page without them silently drops every touchstart,
// which would make the long-press checks pass vacuously or fail confusingly.
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  hasTouch: true,
})

const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

try {
  await page.goto(`http://localhost:${PORT}${BASE}`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.shell', { timeout: 10_000 })
  check('app boots', true)

  /* ---- create a note ------------------------------------------------ */
  await page.click('[title^="New note"]')
  await page.waitForSelector('.cm-editor')
  check('editor mounts', true)

  const title = page.locator('.editor-title-input')
  await title.fill('Lisbon Trip')
  await title.press('Enter')

  const editor = page.locator('.cm-content')
  await editor.click()
  await editor.pressSequentially('# Lisbon Trip\n\nFlights are **booked** and the hotel is *pending*.\n\n', { delay: 4 })
  await page.waitForTimeout(300)

  /* ---- live preview hides syntax ------------------------------------ */
  const h1 = await page.locator('.cm-line.cm-h1').count()
  check('heading gets block styling', h1 > 0, `${h1} heading lines`)

  // Move the caret away so the bold markers hide, then confirm they are gone
  // from the rendered text but still present in the document.
  await editor.press('Control+End')
  await page.waitForTimeout(200)
  const visibleText = await page.locator('.cm-content').innerText()
  check('bold markers hidden in preview', !visibleText.includes('**booked**'), visibleText.slice(0, 60))

  /* ---- tasks --------------------------------------------------------- */
  await editor.pressSequentially('- [ ] Book the tram tickets 📅 2026-09-04\n', { delay: 4 })
  await editor.pressSequentially('Renew passport\n', { delay: 4 })
  await page.waitForTimeout(500)
  const checkboxes = await page.locator('.cm-task-checkbox').count()
  check('task checkbox renders as a widget', checkboxes > 0, `${checkboxes} found`)

  const railTasks = await page.locator('.rail .task-row').count()
  check('task appears in the right rail', railTasks > 0, `${railTasks} in rail`)

  /* ---- second note + wikilink autocomplete --------------------------- */
  await page.click('[title^="New note"]')
  await page.waitForTimeout(200)
  await page.locator('.editor-title-input').fill('Packing List')
  await page.locator('.editor-title-input').press('Enter')
  await page.locator('.cm-content').click()
  await page.locator('.cm-content').pressSequentially('Linked from [[Lisbon', { delay: 25 })
  await page.waitForTimeout(500)
  const acVisible = await page.locator('.cm-tooltip-autocomplete').isVisible().catch(() => false)
  check('wikilink autocomplete opens', acVisible)

  if (acVisible) {
    await page.keyboard.press('Enter')
    await page.waitForTimeout(400)
  } else {
    await page.locator('.cm-content').pressSequentially(' Trip]]', { delay: 10 })
    await page.waitForTimeout(400)
  }

  await page.locator('.cm-content').press('Control+End')
  await page.waitForTimeout(300)
  const linkCount = await page.locator('.cm-wikilink').count()
  const brokenCount = await page.locator('.cm-wikilink-broken').count()
  check('wikilink renders and resolves', linkCount > 0 && brokenCount === 0, `${linkCount} links, ${brokenCount} broken`)

  /* ---- navigate by clicking the link --------------------------------- */
  if (linkCount > 0) {
    await page.locator('.cm-wikilink').first().click()
    await page.waitForTimeout(400)
    const nowTitle = await page.locator('.editor-title-input').inputValue()
    check('clicking a wikilink navigates', nowTitle === 'Lisbon Trip', `landed on "${nowTitle}"`)
  }

  /* ---- backlinks ----------------------------------------------------- */
  const backlinks = await page.locator('.backlinks .backlink-row').count()
  check('backlink is recorded', backlinks > 0, `${backlinks} linked mentions`)

  /* ---- paste an image ------------------------------------------------ */
  await page.locator('.cm-content').click()
  await page.locator('.cm-content').press('Control+End')
  await page.evaluate(async () => {
    // Build a genuine PNG in-page and paste it through a real ClipboardEvent,
    // which is the only way to exercise the app's own paste handler.
    const c = document.createElement('canvas')
    c.width = 1400
    c.height = 900
    const ctx = c.getContext('2d')
    const g = ctx.createLinearGradient(0, 0, 1400, 900)
    g.addColorStop(0, '#e0a80d')
    g.addColorStop(1, '#1c1c1e')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 1400, 900)
    ctx.fillStyle = '#fff'
    ctx.font = 'bold 64px sans-serif'
    ctx.fillText('screenshot', 80, 460)
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
    const file = new File([blob], 'screenshot.png', { type: 'image/png' })
    window.__pastedSize = blob.size
    const dt = new DataTransfer()
    dt.items.add(file)
    document
      .querySelector('.cm-content')
      .dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  await page.waitForTimeout(2500)

  const imgCount = await page.locator('.cm-embed img').count()
  check('pasted image renders inline', imgCount > 0, `${imgCount} embeds`)

  const sizes = await page.evaluate(async () => {
    const dbs = await indexedDB.databases()
    if (!dbs.some((d) => d.name === 'slate')) return null
    return new Promise((resolve) => {
      const req = indexedDB.open('slate')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction('files', 'readonly')
        const all = tx.objectStore('files').getAll()
        all.onsuccess = () => {
          const att = all.result.filter((f) => f.kind === 'attachment')
          resolve({
            original: window.__pastedSize,
            stored: att[0]?.size ?? 0,
            mime: att[0]?.mime ?? '',
            path: att[0]?.path ?? '',
          })
        }
      }
    })
  })
  if (sizes) {
    const ratio = sizes.original / Math.max(1, sizes.stored)
    check(
      'pasted image is optimized',
      sizes.stored > 0 && sizes.stored < sizes.original,
      `${(sizes.original / 1024).toFixed(0)}KB → ${(sizes.stored / 1024).toFixed(0)}KB (${ratio.toFixed(1)}x) as ${sizes.mime}`,
    )
    check('attachment filed under the dated folder', /^attachments\/\d{4}\/\d{2}\//.test(sizes.path), sizes.path)
  } else {
    check('pasted image is optimized', false, 'could not read IndexedDB')
  }

  await page.screenshot({ path: join(SHOTS, '01-editor.png') })

  /* ---- lightbox ------------------------------------------------------ */
  if (imgCount > 0) {
    await page.locator('.cm-embed img').first().click()
    await page.waitForTimeout(400)
    const lb = await page.locator('.lightbox').isVisible()
    check('lightbox opens on image click', lb)
    if (lb) await page.screenshot({ path: join(SHOTS, '02-lightbox.png') })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  }

  /* ---- calendar ------------------------------------------------------ */
  const dots = await page.locator('.cal-dot').count()
  check('calendar marks days that have notes', dots > 0, `${dots} dots`)
  const todayCell = page.locator('.cal-day[data-today="1"]')
  await todayCell.click()
  await page.waitForTimeout(300)
  const filteredHeader = await page.locator('.list-pane .pane-title').innerText()
  check('clicking a day filters the list', /\w+day|,/.test(filteredHeader), filteredHeader)
  await todayCell.click() // toggle back off
  await page.waitForTimeout(200)

  /* ---- command palette ----------------------------------------------- */
  await page.keyboard.press('Control+k')
  await page.waitForTimeout(300)
  const paletteOpen = await page.locator('.palette').isVisible()
  check('command palette opens', paletteOpen)
  if (paletteOpen) {
    await page.keyboard.type('Packing')
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(SHOTS, '03-palette.png') })
    await page.keyboard.press('Escape')
  }

  /* ---- search --------------------------------------------------------- */
  await page.fill('.search-box input', 'tram')
  await page.waitForTimeout(400)
  const found = await page.locator('.note-row').count()
  check('search finds body text', found > 0, `${found} results`)
  await page.fill('.search-box input', '')
  await page.waitForTimeout(200)

  /* ---- source mode ---------------------------------------------------- */
  await page.keyboard.press('Control+Shift+m')
  await page.waitForTimeout(400)
  const sourceText = await page.locator('.cm-content').innerText()
  check('source mode reveals raw markdown', sourceText.includes('![['), sourceText.slice(0, 50))
  await page.keyboard.press('Control+Shift+m')
  await page.waitForTimeout(300)

  /* ---- kitchen sink ----------------------------------------------------
   * Every markdown construct in one note. This exists because a table alone
   * once took the whole editor down (block decorations are illegal from a view
   * plugin) and no other test's content contained one — a rendering bug in any
   * single construct must fail loudly here rather than in daily use.
   */
  const sinkErrorsBefore = consoleErrors.length
  await page.evaluate(async () => {
    const text = [
      '---',
      'title: Kitchen Sink',
      'tags: [demo, test]',
      '---',
      '',
      '# Heading one',
      '## Heading two',
      '',
      'Body with **bold**, *italic*, ~~strike~~, `code`, a #tag,',
      'a [[Wikilink]], an [external](https://example.com) link and an ![[missing.png]] embed.',
      '',
      '> A blockquote',
      '> spanning two lines.',
      '',
      '---',
      '',
      '| Left | Center | Right |',
      '| :--- | :----: | ----: |',
      '| a    | b      | c     |',
      '| d\\|e | f      | g     |',
      '',
      '- bullet one',
      '- bullet two',
      '  - nested',
      '1. numbered',
      '',
      '- [ ] open task',
      '- [x] done task',
      '',
      '```js',
      'const x = { a: 1 } // not a #tag and not a [[link]]',
      '```',
      '',
      'Final paragraph.',
    ].join('\n')
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('slate')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const tx = db.transaction('files', 'readwrite')
    tx.objectStore('files').put({
      path: 'Kitchen Sink.md',
      kind: 'note',
      text,
      mime: 'text/markdown',
      size: text.length,
      hash: 'sink',
      mtime: Date.now() + 60_000,
      ctime: Date.now(),
      dirty: true,
      dirtyFlag: 1,
      sync: {},
    })
    await new Promise((res) => {
      tx.oncomplete = res
    })
  })
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.note-row')
  await page.locator('.note-row', { hasText: 'Kitchen Sink' }).first().click()
  await page.waitForTimeout(900)

  check('kitchen-sink note renders without throwing', consoleErrors.length === sinkErrorsBefore, consoleErrors.slice(sinkErrorsBefore).join(' | '))
  check('editor is alive after the kitchen sink', (await page.locator('.cm-content').count()) === 1)
  check('table renders as a real table', (await page.locator('.cm-table-render td').count()) >= 6)
  check('escaped pipe stays inside its cell', (await page.locator('.cm-table-render').innerText()).includes('d|e'))
  check('frontmatter is not rendered as a heading', (await page.locator('.cm-line.cm-frontmatter').count()) >= 4)
  check('code block gets its own styling', (await page.locator('.cm-line.cm-codeblock').count()) >= 3)
  check('blockquote is styled', (await page.locator('.cm-line.cm-quote').count()) >= 2)
  check('tags in code are not linkified', (await page.locator('.cm-tag').count()) === 1)
  check('a missing embed reports itself', (await page.locator('.cm-embed-missing').count()) === 1)
  await page.screenshot({ path: join(SHOTS, '07-kitchen-sink.png') })

  // Clicking the rendered table must drop the caret into the source.
  await page.locator('.cm-table-render td').first().click()
  await page.waitForTimeout(400)
  check(
    'clicking a table reveals its markdown',
    (await page.locator('.cm-line.cm-table').count()) > 0,
  )


  /* ---- folders and Tag Folders -----------------------------------------
   * Both are new containers with real persistence, so they get exercised end
   * to end: create, populate, filter, and survive a reload.
   */
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForTimeout(300)

  // Seed a few tagged notes so a rule has something to match.
  await page.evaluate(async () => {
    const notes = [
      ['Sprint planning.md', '# Sprint planning\n\n#work #active\n'],
      ['Retro.md', '# Retro\n\n#work #archived\n'],
      ['Groceries.md', '# Groceries\n\n#home #active\n'],
      ['Budget.md', '# Budget\n\n#work #active #urgent\n'],
      // Deliberately urgent but not work: this is what makes the difference
      // between an inherited and a standalone child rule visible.
      ['Roof.md', '# Roof\n\n#home #urgent\n'],
    ]
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('slate')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const tx = db.transaction('files', 'readwrite')
    notes.forEach(([path, text], i) => {
      tx.objectStore('files').put({
        path, kind: 'note', text, mime: 'text/markdown', size: text.length,
        hash: `tag${i}`, mtime: Date.now() - i * 1000, ctime: Date.now() - i * 1000,
        dirty: true, dirtyFlag: 1, sync: {},
      })
    })
    await new Promise((res) => { tx.oncomplete = res })
  })
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.note-row')

  // --- create a nested folder structure via the sidebar -------------------
  let promptReply = 'Clients'
  page.on('dialog', (d) => d.accept(promptReply))

  await page.click('.side-group-label:has-text("Folders") .side-add')
  await page.waitForTimeout(400)
  check('creating a folder works', (await page.locator('.side-row:has-text("Clients")').count()) > 0)

  promptReply = 'Acme'
  await page.locator('.side-row:has-text("Clients")').first().click({ button: 'right' })
  await page.waitForTimeout(250)
  const subMenu = await page.locator('.menu-item:has-text("New subfolder")').count()
  check('right-click opens a real folder menu', subMenu > 0)
  if (subMenu) {
    await page.locator('.menu-item:has-text("New subfolder")').click()
    await page.waitForTimeout(450)
    check('nested folders can be created', (await page.locator('.side-row:has-text("Acme")').count()) > 0)
  }

  // --- create a Tag Folder ------------------------------------------------
  await page.click('.side-group-label:has-text("Tag Folders") .side-add')
  await page.waitForSelector('.rule-input')
  await page.fill('.dialog input[type="text"]', 'Active work')
  await page.fill('.rule-input', '#work AND #active NOT #archived')
  await page.waitForTimeout(400)

  const statusText = await page.locator('.rule-status').innerText()
  check('rule reports a live match count', /matches\s*2\b/i.test(statusText.replace(/\s+/g, ' ')), statusText.slice(0, 80))
  check('rule status is not an error', (await page.getAttribute('.rule-status', 'data-error')) === '0')

  const previewCount = await page.locator('.rule-preview-row').count()
  check('rule previews the notes it matches', previewCount === 2, `${previewCount} shown`)

  await page.click('.dialog-foot .btn-primary')
  await page.waitForTimeout(500)
  check('Tag Folder appears in the sidebar', (await page.locator('.side-row:has-text("Active work")').count()) > 0)

  const filtered = await page.locator('.note-row').count()
  check('Tag Folder filters the note list', filtered === 2, `${filtered} notes listed`)
  const titles = (await page.locator('.note-row-title').allInnerTexts()).sort()
  check('the right notes matched', titles.join(',') === 'Budget,Sprint planning', titles.join(','))

  // --- an invalid rule is reported, not swallowed -------------------------
  await page.locator('.side-row:has-text("Active work")').click({ button: 'right' })
  await page.waitForTimeout(250)
  await page.locator('.menu-item:has-text("Edit rule")').click()
  await page.waitForSelector('.rule-input')
  await page.fill('.rule-input', '#work AND (#active')
  await page.waitForTimeout(300)
  check('an unbalanced rule shows an error', (await page.getAttribute('.rule-status', 'data-error')) === '1')
  check('an invalid rule blocks saving', await page.locator('.dialog-foot .btn-primary').isDisabled())
  await page.click('.dialog-foot .btn:not(.btn-primary)')
  await page.waitForTimeout(300)

  // --- Tag Folders survive a reload (they live in the vault) --------------
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.side-row')
  await page.waitForTimeout(400)
  check('Tag Folders persist across a reload', (await page.locator('.side-row:has-text("Active work")').count()) > 0)
  check('folders persist across a reload', (await page.locator('.side-row:has-text("Clients")').count()) > 0)
  await page.screenshot({ path: join(SHOTS, '08-tag-folders.png') })



  /* ---- tables render properly -------------------------------------------
   * A table's cells are rendered into widget DOM, which CodeMirror's own
   * decorations cannot reach — so inline formatting inside a cell has to be
   * rendered by us, and is checked here element by element rather than by
   * eyeballing text.
   */
  await page.evaluate(async () => {
    const notes = [
      [
        'Table formatting.md',
        '# Tables\n\n| Item | Note |\n| --- | --- |\n| **bold** | *italic* |\n| `code` | ~~struck~~ |\n| [[Lisbon Trip]] | [ext](https://example.com) |\n| a \\| b | #tagged |\n\ntail\n',
      ],
      // A single trailing space on the delimiter row makes @lezer/markdown miss
      // the table entirely; detection must not depend on the parser.
      ['Table trailing space.md', '# T\n\n| A | B |\n| --- | --- | \n| 1 | 2 |\n\ntail\n'],
      // The caret starts at position 0, which is inside this table.
      ['Table at start.md', '| A | B |\n| --- | --- |\n| 1 | 2 |\n\ntail\n'],
    ]
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('slate')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const tx = db.transaction('files', 'readwrite')
    notes.forEach(([path, text], i) => {
      tx.objectStore('files').put({
        path, kind: 'note', text, mime: 'text/markdown', size: text.length,
        hash: `tbl${i}`, mtime: Date.now() + 10_000 - i * 100, ctime: Date.now(),
        dirty: true, dirtyFlag: 1, sync: {},
      })
    })
    await new Promise((res) => { tx.oncomplete = res })
  })
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.note-row')

  await page.locator('.note-row').filter({ hasText: 'Table formatting' }).first().click()
  await page.waitForTimeout(600)

  check('table renders', (await page.locator('.cm-table-render').count()) === 1)
  check('bold renders inside a cell', (await page.locator('.cm-table-render strong').count()) === 1)
  check('italic renders inside a cell', (await page.locator('.cm-table-render em').count()) === 1)
  check('code renders inside a cell', (await page.locator('.cm-table-render code').count()) === 1)
  check('strikethrough renders inside a cell', (await page.locator('.cm-table-render del').count()) === 1)
  check('a wikilink renders inside a cell', (await page.locator('.cm-table-render [data-wikilink]').count()) === 1)
  check('an external link renders inside a cell', (await page.locator('.cm-table-render a[href^="https"]').count()) === 1)
  check('a tag renders inside a cell', (await page.locator('.cm-table-render [data-tag]').count()) === 1)

  await page.screenshot({ path: join(SHOTS, '16-tables.png') })
  const cellText = (await page.locator('.cm-table-render').innerText()).replace(/\s+/g, ' ')
  check('no raw markdown leaks into cells', !/\*\*|~~|`/.test(cellText), cellText.slice(0, 70))
  check('an escaped pipe stays one cell', cellText.includes('a | b'), cellText.slice(0, 70))

  // A wikilink in a cell must navigate, not just look like a link.
  await page.locator('.cm-table-render [data-wikilink]').click()
  await page.waitForTimeout(500)
  check(
    'a wikilink in a cell navigates',
    (await page.locator('.editor-title-input').inputValue()) === 'Lisbon Trip',
  )

  await page.locator('.note-row').filter({ hasText: 'Table trailing space' }).first().click()
  await page.waitForTimeout(500)
  check(
    'a trailing space on the delimiter row does not hide the table',
    (await page.locator('.cm-table-render').count()) === 1,
  )

  await page.locator('.note-row').filter({ hasText: 'Table at start' }).first().click()
  await page.waitForTimeout(500)
  check(
    'a table on the first line renders on open',
    (await page.locator('.cm-table-render').count()) === 1,
  )

  // Clicking it still hands over to the source for editing.
  await page.locator('.cm-table-render td').first().click()
  await page.waitForTimeout(400)
  check(
    'clicking a table reveals its markdown',
    (await page.locator('.cm-line.cm-table').count()) > 0 &&
      (await page.locator('.cm-table-render').count()) === 0,
  )
  await page.screenshot({ path: join(SHOTS, '17-table-source.png') })

  /* ---- insert a photo ---------------------------------------------------- */
  await page.locator('.note-row').filter({ hasText: 'Table formatting' }).first().click()
  await page.waitForTimeout(400)
  await page.locator('[aria-label="Insert photo or file"]').click()
  await page.waitForTimeout(300)
  const insertItems = await page.locator('.menu-item').allInnerTexts()
  check(
    'the insert menu offers a library and a file option',
    insertItems.some((t) => /Photo Library/i.test(t)) && insertItems.some((t) => /Choose File/i.test(t)),
    insertItems.join(' / '),
  )

  // Build a real PNG in-page, then hand it to the native picker.
  const pngBase64 = await page.evaluate(async () => {
    const c = document.createElement('canvas')
    c.width = 1200
    c.height = 800
    const x = c.getContext('2d')
    const g = x.createLinearGradient(0, 0, 1200, 800)
    g.addColorStop(0, '#2b6cb0')
    g.addColorStop(1, '#e0a80d')
    x.fillStyle = g
    x.fillRect(0, 0, 1200, 800)
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
    const buf = await blob.arrayBuffer()
    let s = ''
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
    return btoa(s)
  })

  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.menu-item:has-text("Photo Library")').click(),
  ])
  await chooser.setFiles({
    name: 'IMG_0421.png',
    mimeType: 'image/png',
    buffer: Buffer.from(pngBase64, 'base64'),
  })
  await page.waitForTimeout(2800)

  const embeds = await page.locator('.cm-embed img').count()
  check('the picked photo is inserted as an embed', embeds >= 1, `${embeds} embeds`)

  const inserted = await page.evaluate(async () => {
    const req = indexedDB.open('slate')
    return new Promise((resolve) => {
      req.onsuccess = () => {
        const tx = req.result.transaction('files', 'readonly')
        const all = tx.objectStore('files').getAll()
        all.onsuccess = () => {
          const a = all.result.filter((f) => f.kind === 'attachment')
          const last = a.sort((x, y) => y.mtime - x.mtime)[0]
          resolve(last ? { path: last.path, size: last.size, mime: last.mime } : null)
        }
      }
    })
  })
  check(
    'the picked photo is optimized like a paste',
    !!inserted && inserted.mime === 'image/webp' && inserted.size < 120_000,
    inserted ? `${inserted.path} ${(inserted.size / 1024).toFixed(0)}KB ${inserted.mime}` : 'none',
  )
  check(
    'the picked photo keeps a meaningful filename',
    !!inserted && /IMG_0421/.test(inserted.path),
    inserted?.path ?? '',
  )

  // It must behave like any other image: resize handle and lightbox.
  check(
    'the inserted photo has a resize handle',
    (await page.locator('.cm-embed .cm-embed-resize').count()) >= 1,
  )
  await page.locator('.cm-embed img').last().click()
  await page.waitForTimeout(400)
  check('the inserted photo opens in the lightbox', await page.locator('.lightbox').isVisible())
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  /* ---- nested Tag Folders -----------------------------------------------
   *
   * Rows are looked up inside the Tag Folders group with an exact name match:
   * the sidebar deliberately allows a real folder and a Tag Folder to share a
   * name, and "Work" would otherwise also match the "Active work" folder made
   * earlier.
   */
  const tagFolderGroup = page.locator('.side-group', {
    has: page.locator('.side-group-label', { hasText: 'Tag Folders' }),
  })
  const tagFolderRow = (name) =>
    tagFolderGroup
      .locator('.side-row')
      .filter({ has: page.locator('.side-name', { hasText: new RegExp(`^${name}$`) }) })

  // The hierarchy's whole point is that a child narrows its parent, so the
  // check that matters is that a nested folder shows FEWER notes than its
  // parent and excludes ones the parent alone would match.
  await page.click('.side-group-label:has-text("Tag Folders") .side-add')
  await page.waitForSelector('.rule-input')
  await page.fill('.dialog input[type="text"]', 'Work')
  await page.fill('.rule-input', '#work')
  await page.waitForTimeout(350)
  await page.click('.dialog-foot .btn-primary')
  await page.waitForTimeout(450)
  const workCount = await page.locator('.note-row').count()
  check('parent Tag Folder matches its own rule', workCount === 3, `${workCount} notes`)

  // Create a child from the parent's own menu.
  await tagFolderRow('Work').click({ button: 'right' })
  await page.waitForTimeout(250)
  await page.locator('.menu-item:has-text("New folder inside")').click()
  await page.waitForSelector('.rule-input')

  const parentSelected = await page.locator('.dialog select').nth(1).inputValue()
  check('the new folder is pre-parented', parentSelected !== '', `parent="${parentSelected}"`)
  check('the narrow-parent toggle is on by default', await page.locator('.check input[type="checkbox"]').isChecked())

  await page.fill('.dialog input[type="text"]', 'Urgent')
  await page.fill('.rule-input', '#urgent')
  await page.waitForTimeout(400)

  const nestedStatus = (await page.locator('.rule-status').innerText()).replace(/\s+/g, ' ')
  check('the dialog shows the combined effective rule', /#work and #urgent/i.test(nestedStatus), nestedStatus.slice(0, 90))
  check('the dialog names what is inherited', /inherited from Work/i.test(nestedStatus), nestedStatus.slice(0, 120))
  check('the child matches fewer notes than its parent', /matches 1 note/i.test(nestedStatus), nestedStatus.slice(0, 60))

  await page.click('.dialog-foot .btn-primary')
  await page.waitForTimeout(500)

  const childCount = await page.locator('.note-row').count()
  const childTitles = await page.locator('.note-row-title').allInnerTexts()
  check(
    'the nested folder narrows the parent',
    childCount === 1 && childTitles[0] === 'Budget',
    childTitles.join(','),
  )

  // Indentation is how the hierarchy actually reads in the sidebar.
  const indents = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.side-row')]
    const named = (n) => rows.find((r) => r.querySelector('.side-name')?.textContent.trim() === n)
    const work = named('Work')
    const urgent = named('Urgent')
    if (!work || !urgent) return null
    return {
      work: parseInt(getComputedStyle(work).paddingLeft),
      urgent: parseInt(getComputedStyle(urgent).paddingLeft),
    }
  })
  check('the child is indented under its parent', !!indents && indents.urgent > indents.work, JSON.stringify(indents))

  // Turning inheritance off must widen the child again.
  await tagFolderRow('Urgent').click({ button: 'right' })
  await page.waitForTimeout(250)
  await page.locator('.menu-item:has-text("Edit rule")').click()
  await page.waitForSelector('.rule-input')
  await page.locator('.check input[type="checkbox"]').uncheck()
  await page.waitForTimeout(350)
  const looseStatus = (await page.locator('.rule-status').innerText()).replace(/\s+/g, ' ')
  check('unchecking narrow widens the match', /matches 2 notes/i.test(looseStatus), looseStatus.slice(0, 60))
  await page.locator('.check input[type="checkbox"]').check()
  await page.waitForTimeout(250)
  await page.click('.dialog-foot .btn-primary')
  await page.waitForTimeout(400)

  // Editing the parent must re-narrow the child.
  await tagFolderRow('Work').click({ button: 'right' })
  await page.waitForTimeout(250)
  await page.locator('.menu-item:has-text("Edit rule")').click()
  await page.waitForSelector('.rule-input')
  await page.fill('.rule-input', '#home')
  await page.waitForTimeout(300)
  await page.click('.dialog-foot .btn-primary')
  await page.waitForTimeout(450)
  await tagFolderRow('Urgent').click()
  await page.waitForTimeout(400)
  const afterParentEdit = await page.locator('.note-row-title').allInnerTexts()
  check(
    'editing the parent re-narrows the child',
    afterParentEdit.join(',') === 'Roof',
    afterParentEdit.join(','),
  )

  // A collapsed parent hides its children.
  const beforeCollapse = await tagFolderRow('Urgent').count()
  await tagFolderRow('Work').locator('.disclose').first().click()
  await page.waitForTimeout(300)
  const afterCollapse = await tagFolderRow('Urgent').count()
  check('a parent collapses its children', beforeCollapse === 1 && afterCollapse === 0)
  await tagFolderRow('Work').locator('.disclose').first().click()
  await page.waitForTimeout(300)

  // Deleting a parent must promote, not destroy, what is inside it.
  await tagFolderRow('Work').click({ button: 'right' })
  await page.waitForTimeout(250)
  const keepLabel = await page.locator('.menu-item:has-text("keeping what")').count()
  check('deleting a parent offers to keep what is inside', keepLabel === 1)
  await page.locator('.menu-item:has-text("keeping what")').click()
  await page.waitForTimeout(500)
  check('the child survives its parent being deleted', (await tagFolderRow('Urgent').count()) === 1)

  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.side-row')
  await page.waitForTimeout(400)
  check('the promoted child persists across a reload', (await tagFolderRow('Urgent').count()) === 1)
  await page.screenshot({ path: join(SHOTS, '15-nested-tag-folders.png') })

  /* ---- layout: resizing must not rearrange anything --------------------- */
  const editorWidth = async () => {
    const box = await page.locator('.editor-pane').boundingBox()
    return box ? Math.round(box.width) : 0
  }
  const overflows = () =>
    page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2)

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForTimeout(350)
  check('wide mode shows the sidebar inline', (await page.getAttribute('.shell', 'data-sidebar')) === 'inline')

  const statusVisible = await page.evaluate(() => {
    const el = document.querySelector('.statusbar')
    if (!el) return false
    const r = el.getBoundingClientRect()
    return r.height > 0 && r.bottom <= window.innerHeight + 1
  })
  check('the sync status bar is on screen, not below the fold', statusVisible)

  /* ---- Settings › About: the update controls ------------------------------ */
  // The full stale-build scenario needs two builds and a swappable server, so it
  // is not reproduced here. This just holds the panel itself honest: the buttons
  // exist, and a check against a server that has nothing newer says so rather
  // than reloading or hanging.
  await page.click('.pane-head .icon-btn[title^="Settings"]')
  await page.waitForSelector('.dialog')
  await page.click('.tab:has-text("About")')
  await page.waitForSelector('.callout:has-text("Build")')
  const aboutText = await page.locator('.callout:has-text("Build")').innerText()
  check('About shows which build is running', /Build \d{4}-\d{2}-\d{2}/.test(aboutText), aboutText.split('\n')[1])
  check('About offers an update button', (await page.locator('.dialog .btn:has-text("Check for updates")').count()) === 1)
  check('About offers the reinstall escape hatch', (await page.locator('.dialog .btn:has-text("Reinstall")').count()) === 1)
  await page.click('.dialog .btn:has-text("Check for updates")')
  await page.waitForTimeout(2500)
  const checked = await page.locator('.callout:has-text("Build")').innerText()
  check(
    'checking for updates reports back instead of hanging',
    /newest build|nothing to update|not running Slate/i.test(checked),
    checked.split('\n').slice(1).join(' / ').slice(0, 110),
  )
  await page.click('.dialog-foot .btn-primary')
  await page.waitForTimeout(200)

  let minEditor = Infinity
  let anyOverflow = false
  let strandedDrawer = false
  for (const w of [1400, 1280, 1180, 1080, 980, 880, 800, 764, 700, 600, 480, 390]) {
    await page.setViewportSize({ width: w, height: 900 })
    await page.waitForTimeout(140)
    if (await overflows()) anyOverflow = true
    if (await page.locator('.drawer-scrim').count()) strandedDrawer = true
    if (w >= 764) minEditor = Math.min(minEditor, await editorWidth())
  }
  check('no horizontal overflow at any width', !anyOverflow)
  check('resizing never leaves a drawer open', !strandedDrawer)
  check('the editor keeps a usable width down to 764px', minEditor >= 400, `min ${minEditor}px`)

  await page.setViewportSize({ width: 900, height: 900 })
  await page.waitForTimeout(300)
  check('mid-size drops the sidebar rather than squeezing the editor', (await page.getAttribute('.shell', 'data-mode')) === 'medium')
  check('mid-size keeps the note list and editor', (await page.locator('.list-pane').count()) === 1 && (await page.locator('.editor-pane').count()) === 1)
  await page.screenshot({ path: join(SHOTS, '09-medium.png') })

  // The sidebar is reachable at mid-size, as an overlay.
  await page.click('[title^="Toggle sidebar"]')
  await page.waitForTimeout(350)
  check('mid-size sidebar opens as an overlay', (await page.getAttribute('.shell', 'data-sidebar')) === 'floating')
  check('the overlay has a dismiss scrim', (await page.locator('.drawer-scrim').count()) === 1)
  await page.locator('.drawer-scrim').click()
  await page.waitForTimeout(300)
  check('tapping the scrim closes the drawer', (await page.getAttribute('.shell', 'data-sidebar')) === 'hidden')

  /* ---- phone -------------------------------------------------------------- */
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(400)
  check('phone width enters compact mode', (await page.getAttribute('.shell', 'data-mode')) === 'compact')

  const tabs = await page.locator('.tabbar-item').count()
  check('the bottom pill bar has four tabs', tabs === 4, `${tabs} tabs`)
  const tabLabels = await page.locator('.tabbar-label').allInnerTexts()
  check('tabs are Notes, Tasks, Calendar, More', tabLabels.join(',') === 'Notes,Tasks,Calendar,More', tabLabels.join(','))

  // Every tab target must be comfortably tappable.
  const tabBoxes = await page.locator('.tabbar-item').evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height) }
    }),
  )
  check(
    'tab targets meet the 44px touch minimum',
    tabBoxes.every((b) => b.h >= 44 && b.w >= 44),
    JSON.stringify(tabBoxes[0]),
  )

  check('no horizontal overflow on a phone', !(await overflows()))
  await page.screenshot({ path: join(SHOTS, '10-phone-notes.png') })

  /* ---- notched phone ------------------------------------------------------
   * Headless Chromium reports every safe-area inset as 0, so a notch is
   * simulated by injecting literals where the env() values land. This guards a
   * bug that shipped: with the insets on <body> and a dvh height on #app, the
   * padding pushed the shell down while its height went on measuring a full
   * viewport, so the column overhung the bottom of the screen by the height of
   * the notch and the end of every list was unreachable. On a real iPhone it
   * read as "the app doesn't go all the way to the bottom".
   */
  const NOTCH = { top: 59, bottom: 34 }
  await page.addStyleTag({
    content: `#app{padding-top:${NOTCH.top}px !important}
              .tabbar{bottom:max(12px,${NOTCH.bottom}px) !important}
              :root{--nav-gap:max(12px,${NOTCH.bottom}px) !important}`,
  })
  await page.waitForTimeout(300)
  const notched = await page.evaluate(() => {
    const app = document.getElementById('app').getBoundingClientRect()
    const nav = document.querySelector('.tabbar').getBoundingClientRect()
    const sc = document.querySelector('.mobile-stack .list-scroll').getBoundingClientRect()
    return {
      overhang: Math.round(app.bottom - window.innerHeight),
      contentTop: Math.round(document.querySelector('.shell').getBoundingClientRect().top),
      gapBelowPill: Math.round(window.innerHeight - nav.bottom),
      scrollerShort: Math.round(window.innerHeight - sc.bottom),
    }
  })
  check('notched: the shell ends flush with the bottom edge', notched.overhang === 0, `overhangs ${notched.overhang}px`)
  check('notched: content clears the notch', notched.contentTop === NOTCH.top, `top ${notched.contentTop}`)
  check('notched: the pill clears the home indicator by exactly the inset', notched.gapBelowPill === NOTCH.bottom, `${notched.gapBelowPill}px`)
  check('notched: the list scroller reaches the bottom edge', notched.scrollerShort === 0, `${notched.scrollerShort}px short`)
  await page.evaluate(() => document.head.querySelectorAll('style').forEach((s) => {
    if (s.textContent.includes('--nav-gap')) s.remove()
  }))
  await page.waitForTimeout(200)

  await page.locator('.tabbar-item:has-text("Tasks")').click()
  await page.waitForTimeout(350)
  check('Tasks tab shows tasks', (await page.locator('.task-row').count()) > 0)
  await page.screenshot({ path: join(SHOTS, '11-phone-tasks.png') })

  await page.locator('.tabbar-item:has-text("Calendar")').click()
  await page.waitForTimeout(350)
  check('Calendar tab shows a month grid', (await page.locator('.cal-day').count()) >= 28)
  await page.screenshot({ path: join(SHOTS, '12-phone-calendar.png') })

  await page.locator('.tabbar-item:has-text("More")').click()
  await page.waitForTimeout(350)
  check('More tab lists the secondary destinations', (await page.locator('.more-row').count()) >= 4)
  check('More surfaces Tag Folders', (await page.locator('.more-row:has-text("Active work")').count()) > 0)
  await page.screenshot({ path: join(SHOTS, '13-phone-more.png') })

  // --- open a note and come back -----------------------------------------
  await page.locator('.tabbar-item:has-text("Notes")').click()
  await page.waitForTimeout(300)
  check('opening a tab does not auto-open a note', (await page.locator('.editor-overlay').count()) === 0)

  await page.locator('.note-row').first().click()
  await page.waitForTimeout(450)
  check('tapping a note opens the editor full screen', (await page.locator('.editor-overlay .cm-content').count()) === 1)
  check('no horizontal overflow in the phone editor', !(await overflows()))
  await page.screenshot({ path: join(SHOTS, '14-phone-editor.png') })

  await page.locator('.editor-overlay [aria-label="Back"]').click()
  await page.waitForTimeout(400)
  check('back returns to the list', (await page.locator('.editor-overlay').count()) === 0)

  // --- long-press opens the action sheet ----------------------------------
  // A real touchstart, held long enough for the press timer to fire. Touch
  // objects must be constructed in-page: they require an identifier and a
  // target, which the DevTools protocol can't marshal from Node.
  await page.evaluate(() => {
    const el = document.querySelector('.note-row')
    const r = el.getBoundingClientRect()
    const touch = new Touch({
      identifier: 1,
      target: el,
      clientX: r.left + 40,
      clientY: r.top + 20,
    })
    el.dispatchEvent(
      new TouchEvent('touchstart', {
        touches: [touch],
        targetTouches: [touch],
        changedTouches: [touch],
        bubbles: true,
        cancelable: true,
      }),
    )
  })
  await page.waitForTimeout(700)
  const sheet = await page.locator('.menu-sheet').count()
  check('long-press opens a bottom action sheet', sheet === 1)
  if (sheet) {
    check('the sheet offers Move to…', (await page.locator('.menu-item:has-text("Move to")').count()) > 0)
    await page.locator('.menu-cancel').click()
    await page.waitForTimeout(250)
  }

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForTimeout(350)

  /* ---- persistence across a reload ------------------------------------ */
  const beforeCount = await page.evaluate(
    () => document.querySelectorAll('.note-row').length,
  )
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.note-row', { timeout: 10_000 })
  await page.waitForTimeout(600)
  const afterCount = await page.locator('.note-row').count()
  check('notes survive a reload', afterCount >= beforeCount && afterCount > 0, `${beforeCount} → ${afterCount}`)

  const stillHasImage = await page.evaluate(async () => {
    const req = indexedDB.open('slate')
    return new Promise((resolve) => {
      req.onsuccess = () => {
        const tx = req.result.transaction('files', 'readonly')
        const all = tx.objectStore('files').getAll()
        all.onsuccess = () =>
          resolve(all.result.some((f) => f.kind === 'attachment' && f.blob instanceof Blob))
      }
    })
  })
  check('attachment blob survives a reload', stillHasImage === true)

  /* ---- offline -------------------------------------------------------- */
  await page.context().setOffline(true)
  await page.reload({ waitUntil: 'domcontentloaded' })
  const offlineOk = await page
    .waitForSelector('.note-row', { timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  check('app loads and shows notes with no network', offlineOk)
  if (offlineOk) {
    await page.locator('.note-row').first().click()
    await page.waitForTimeout(400)
    await page.locator('.cm-content').click()
    await page.locator('.cm-content').pressSequentially('\nWritten while offline.', { delay: 5 })
    await page.waitForTimeout(800)
    const offlineText = await page.locator('.cm-content').innerText()
    check('can edit while offline', offlineText.includes('Written while offline'))
    await page.screenshot({ path: join(SHOTS, '04-offline.png') })
  }
  await page.context().setOffline(false)

  /* ---- light theme screenshot ----------------------------------------- */
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.shell')
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(SHOTS, '05-light.png') })

  /* ---- responsive ------------------------------------------------------ */
  await page.setViewportSize({ width: 420, height: 860 })
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'))
  await page.waitForTimeout(500)
  const horizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
  )
  check('no horizontal overflow on a phone viewport', !horizontalOverflow)
  await page.screenshot({ path: join(SHOTS, '06-mobile.png') })

  /* ---- console -------------------------------------------------------- */
  const realErrors = consoleErrors.filter(
    (e) => !/favicon|manifest|Failed to load resource.*404/i.test(e),
  )
  check('no uncaught console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))
} catch (e) {
  check('smoke run completed', false, e.message)
  await page.screenshot({ path: join(SHOTS, 'failure.png') }).catch(() => {})
} finally {
  await browser.close()
  server.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
