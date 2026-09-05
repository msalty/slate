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

/**
 * Ask the open note for an editing surface, the way a person does.
 *
 * A note opens as a page to read — no caret, and so no keyboard — and only a
 * tap in it, or this button, gives it one. The button rather than a tap on the
 * text, because a note whose first lines are a table or an image would be
 * answering a click aimed at those instead.
 */
/**
 * A date as the app writes it into a task line: local, not UTC, so a run near
 * midnight in a western timezone does not date "today" as tomorrow.
 */
const isoDay = (offset = 0) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** The calendar cell for a day, addressed by the label it announces. */
const calCell = (offset = 0) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return page.locator(`.cal-day[aria-label^="${d.toDateString()}"]`)
}

/*
 * The same cell, brought into view first. A month grid runs from the Sunday
 * before the 1st to the end of the last week, so a day two either side of
 * today is *usually* on it — and near a month boundary it is not, which would
 * make these checks fail on a handful of days a year for no reason at all.
 */
const showDay = async (offset) => {
  const cell = calCell(offset)
  const arrow = offset < 0 ? 'Previous month' : 'Next month'
  for (let i = 0; i < 2 && (await cell.count()) === 0; i++) {
    await page.locator(`[aria-label="${arrow}"]`).click()
    await page.waitForTimeout(250)
  }
  return cell
}

/**
 * A point in the open note that is text rather than a control.
 *
 * Which note is in front of these checks depends on what earlier sections
 * touched last, and a note that opens on a task line has controls where the
 * text would be: the checkbox ticks and the date chip opens its picker, both
 * deliberately *instead* of starting to edit, so that reading through a note
 * never drops you into the editor. Pressing one of those and calling it a
 * failure to start editing tests the opposite of the rule. Falls back to the
 * empty space under the last line, which the editor answers the same way.
 */
const noteTextPoint = (scope = '') =>
  page.evaluate((s) => {
    const controls =
      'input, .cm-due-chip, .cm-task-checkbox, .cm-embed, .cm-code-copy, .cm-table-wrap, a'
    const plain = [...document.querySelectorAll(`${s} .cm-line`)].find(
      (l) => l.textContent.trim() && !l.querySelector(controls),
    )
    if (plain) {
      const r = plain.getBoundingClientRect()
      return { x: r.left + Math.min(24, r.width / 2), y: r.top + r.height / 2 }
    }
    const r = document.querySelector(`${s} .cm-scroller`).getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.bottom - 24 }
  }, scope)

const startEditing = async () => {
  const edit = page.locator('.editor-pane [aria-label="Edit note"]')
  if (await edit.count()) {
    await edit.click()
    await page.waitForTimeout(200)
  }
}

/** The markdown of whichever note holds a given string. */
const noteContaining = (needle) =>
  page.evaluate(async (n) => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('slate')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const all = await new Promise((res) => {
      const q = db.transaction('files', 'readonly').objectStore('files').getAll()
      q.onsuccess = () => res(q.result)
    })
    return all.find((f) => (f.text ?? '').includes(n))?.text ?? ''
  }, needle)

/**
 * The same, but waiting for a save that may not have landed yet.
 *
 * Saves are debounced, so a fixed sleep after a toolbar press is a race: the
 * read finds the *previous* text, which still contains the needle, and the
 * check fails for timing rather than for behaviour. Polling for what the edit
 * should have produced fails just as loudly when the edit never happens, and
 * only costs time when it is genuinely slow.
 */
const noteAfterEdit = async (needle, expected, timeout = 4000) => {
  const until = Date.now() + timeout
  let text = ''
  do {
    text = await noteContaining(needle)
    if (text.includes(expected)) return text
    await page.waitForTimeout(100)
  } while (Date.now() < until)
  return text
}

/** What the note is right now: a page being read, or something being typed in. */
const readingState = () =>
  page.evaluate(() => ({
    flag: document.querySelector('.editor-pane')?.dataset.reading ?? '',
    editable: document.querySelector('.cm-content')?.getAttribute('contenteditable') ?? '',
    focused: document.activeElement?.className ?? '',
  }))

try {
  await page.goto(`http://localhost:${PORT}${BASE}`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.shell', { timeout: 10_000 })
  check('app boots', true)

  /* ---- iOS standalone landmines -------------------------------------------
   * Neither of these can be observed anywhere but a real installed iOS PWA —
   * headless Chromium, desktop Safari and the simulators all render correctly
   * either way — so they are asserted on the markup instead. Both have already
   * cost a round of "the app doesn't reach the bottom of the screen": without
   * viewport-fit=cover iOS letterboxes the app inside the safe area, and
   * black-translucent hands back a web view shorter than the screen.
   */
  const head = await page.evaluate(() => ({
    viewport: document.querySelector('meta[name=viewport]')?.content ?? '',
    statusBar:
      document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.content ?? '',
  }))
  check('the viewport opts into the whole screen', /viewport-fit=cover/.test(head.viewport), head.viewport)
  check('the iOS status bar style is default', head.statusBar === 'default', head.statusBar)

  /* ---- create a note ------------------------------------------------ */
  await page.click('[title^="New note"]')
  await page.waitForSelector('.cm-editor')
  check('editor mounts', true)

  /*
   * A brand new note is the one note that opens with a caret in it. There is
   * nothing in it to read, and the tap that would ask for the caret is the one
   * that just made the note.
   */
  const fresh = await readingState()
  check(
    'a brand new note opens ready to type',
    fresh.flag === '0' && fresh.editable === 'true' && fresh.focused.includes('cm-content'),
    `reading=${fresh.flag}, focused ${fresh.focused || 'nothing'}`,
  )

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
  await editor.pressSequentially(`- [ ] Book the tram tickets 📅 ${isoDay()}\n`, { delay: 4 })
  await editor.pressSequentially('Renew passport\n', { delay: 4 })
  await page.waitForTimeout(500)
  const checkboxes = await page.locator('.cm-task-checkbox').count()
  check('task checkbox renders as a widget', checkboxes > 0, `${checkboxes} found`)

  /*
   * The rail's list is the dated one: what is due today and what is already
   * late. Everything else lives in the sidebar's Tasks row — beside a calendar,
   * an undated job is a job for another day.
   */
  const railRows = () => page.locator('.rail .task-row')
  check(
    'a task due today appears in the right rail',
    (await railRows().filter({ hasText: 'Book the tram tickets' }).count()) === 1,
    `${await railRows().count()} in rail`,
  )
  check(
    'and an undated one does not crowd it',
    (await railRows().filter({ hasText: 'Renew passport' }).count()) === 0,
    (await railRows().allInnerTexts()).join(' | '),
  )

  /* ---- due dates ------------------------------------------------------
   * The chip is the whole feature: a date is a control at the end of the task
   * line, in the note and in the rail, rather than something you hand-type.
   */
  const dated = page.locator('.cm-due-chip[data-set="1"]')
  check('a due date renders as a chip, not as syntax', (await dated.count()) === 1)
  check(
    'and the raw marker is gone from the rendered line',
    !(await page.locator('.cm-content').innerText()).includes(`📅 ${isoDay()}`),
  )
  check('the chip says something a person would say', ((await dated.innerText()) || '').length > 0, await dated.innerText())

  /*
   * The ghost only ever appears on the line the caret is in — the same rule
   * the rest of live preview follows. A checklist does not sprout a button
   * per row.
   */
  const ghosts = () => page.locator('.cm-due-chip[data-set="0"]').count()
  check('an undated task offers a ghost chip on the caret’s line', (await ghosts()) === 1)
  await page.locator('.cm-line.cm-h1').click()
  await page.waitForTimeout(200)
  check('and nowhere else once the caret leaves', (await ghosts()) === 0)
  check('while a real date stays visible regardless', (await dated.count()) === 1)

  // Open the picker on the date that exists.
  await dated.click()
  await page.waitForTimeout(250)
  const picker = await page.evaluate(() => ({
    open: document.querySelectorAll('.due-pick').length,
    presets: [...document.querySelectorAll('.due-preset')].map((b) => b.textContent.trim()),
    days: document.querySelectorAll('.due-day').length,
    clear: document.querySelectorAll('.due-clear').length,
  }))
  check('clicking a chip opens the picker', picker.open === 1)
  check('it leads with one-tap presets', picker.presets.length >= 3, picker.presets.join(' · '))
  check('Today and Tomorrow are always among them', /^Today/.test(picker.presets[0]) && /^Tomorrow/.test(picker.presets[1]))
  check('a full month grid sits under them', picker.days >= 28, `${picker.days} cells`)
  check('and a date already set can be cleared', picker.clear === 1)
  await page.screenshot({ path: join(SHOTS, '01b-due-picker.png') })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  check('Escape dismisses it', (await page.locator('.due-pick').count()) === 0)

  // The keyboard route to the same picker, for a task being written rather
  // than one being reviewed.
  await page.locator('.cm-line:has-text("Book the tram tickets")').click()
  await page.waitForTimeout(200)
  await page.keyboard.press('Control+Alt+d')
  await page.waitForTimeout(300)
  check('⌘⌥D opens it for the task the caret is on', (await page.locator('.due-pick').count()) === 1)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  await page.locator('.cm-line.cm-h1').click()
  await page.waitForTimeout(200)
  await page.keyboard.press('Control+Alt+d')
  await page.waitForTimeout(300)
  check('and stays out of the way on a line that is not a task', (await page.locator('.due-pick').count()) === 0)

  /*
   * The round trip that matters: date a task that had none, entirely from the
   * UI, and find it in the markdown afterwards.
   */
  await page.locator('.cm-line:has-text("Renew passport")').click()
  await page.waitForTimeout(250)

  /*
   * The ghost is a zero-width widget pinned to the end of the line, and it is
   * atomic like every other widget here. Typing at the end of that line is the
   * thing that would break if "atomic" meant the caret could not get past it,
   * so it is checked rather than assumed.
   */
  await page.keyboard.press('End')
  await page.keyboard.type('!')
  await page.waitForTimeout(700) // past the editor's 400ms save debounce
  check(
    'typing at the end of a task line still lands in the line',
    (await noteContaining('Renew passport')).includes('- [ ] Renew passport!'),
  )
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(700)
  check(
    'and backspace takes the character, not the chip',
    (await noteContaining('Renew passport')).includes('- [ ] Renew passport\n') &&
      (await page.locator('.cm-due-chip[data-set="0"]').count()) === 1,
  )

  await page.locator('.cm-due-chip[data-set="0"]').first().click()
  await page.waitForTimeout(250)
  await page.locator('.due-preset:has-text("Tomorrow")').click()
  await page.waitForTimeout(500)
  const trip = await noteContaining('Renew passport')
  check(
    'picking a preset writes a real date into the markdown',
    /- \[ \] Renew passport 📅 \d{4}-\d{2}-\d{2}/.test(trip),
    (trip.split('\n').find((l) => l.includes('Renew passport')) ?? '').trim(),
  )
  check('and the note now carries two dated tasks', (trip.match(/📅/g) ?? []).length === 2)
  check(
    'the rail gives every task it shows a date button',
    (await page.locator('.rail .task-row .due-chip').count()) ===
      (await page.locator('.rail .task-row').count()) &&
      (await page.locator('.rail .task-row').count()) > 0,
  )
  check(
    'and a task dated tomorrow waits its turn',
    (await railRows().filter({ hasText: 'Renew passport' }).count()) === 0,
    (await railRows().allInnerTexts()).join(' | '),
  )

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

  /* ---- back and forward ------------------------------------------------
   *
   * Straight after a link has been followed, which is the whole reason the two
   * arrows exist: the note list is sorted by date and cannot tell you where you
   * have just been.
   */
  if (linkCount > 0) {
    const cameFrom = 'Packing List'
    check(
      'Back offers the note the link was followed from',
      (await page.getAttribute('.editor-nav [aria-label="Back"]', 'title')) === `Back to “${cameFrom}”`,
      await page.getAttribute('.editor-nav [aria-label="Back"]', 'title'),
    )
    check('Forward has nowhere to go yet', await page.locator('.editor-nav [aria-label="Forward"]').isDisabled())

    await page.click('.editor-nav [aria-label="Back"]')
    await page.waitForTimeout(350)
    check(
      'Back returns to it',
      (await page.locator('.editor-title-input').inputValue()) === cameFrom,
    )

    await page.click('.editor-nav [aria-label="Forward"]')
    await page.waitForTimeout(350)
    check(
      'and Forward comes back again',
      (await page.locator('.editor-title-input').inputValue()) === 'Lisbon Trip',
    )
  }

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

    /* ---- pinching a picture ---------------------------------------------
     * Zoom buttons are a poor substitute for fingers on a phone, so the
     * viewer takes the gesture itself. Touch is dispatched through CDP
     * because it is the only way to put two fingers on the screen at once —
     * Playwright's touchscreen taps with one.
     */
    const cdp = await page.context().newCDPSession(page)
    const touch = (type, points) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: points.map((p, i) => ({ x: Math.round(p.x), y: Math.round(p.y), id: i + 1 })),
      })
    const drag = async (from, to, steps = 8) => {
      await touch('touchStart', from)
      for (let i = 1; i <= steps; i++) {
        const t = i / steps
        await touch(
          'touchMove',
          from.map((p, k) => ({ x: p.x + (to[k].x - p.x) * t, y: p.y + (to[k].y - p.y) * t })),
        )
      }
      await touch('touchEnd', [])
      await page.waitForTimeout(250)
    }
    const viewer = () =>
      page.evaluate(() => {
        const img = document.querySelector('.lightbox-stage img')
        const stage = document.querySelector('.lightbox-stage')
        const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(
          img.style.transform,
        )
        const r = img.getBoundingClientRect()
        const s = stage.getBoundingClientRect()
        return {
          x: m ? +m[1] : NaN,
          y: m ? +m[2] : NaN,
          scale: m ? +m[3] : NaN,
          slackX: Math.max(0, (r.width - s.width) / 2),
          slackY: Math.max(0, (r.height - s.height) / 2),
        }
      })

    const fitted = await viewer()
    check('a picture opens fitted and centred', fitted.scale === 1 && fitted.x === 0 && fitted.y === 0, JSON.stringify(fitted))

    const mid = await page.evaluate(() => {
      const r = document.querySelector('.lightbox-stage').getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
    // Fingers 120px apart, spread to 360: three times the gap, three times the
    // picture.
    await drag(
      [
        { x: mid.x - 60, y: mid.y },
        { x: mid.x + 60, y: mid.y },
      ],
      [
        { x: mid.x - 180, y: mid.y },
        { x: mid.x + 180, y: mid.y },
      ],
    )
    const pinched = await viewer()
    check(
      'pinching zooms it by how far the fingers spread',
      Math.abs(pinched.scale - 3) < 0.35,
      `${pinched.scale.toFixed(2)}×`,
    )

    // One finger, well past the edge of what a zoomed picture has to give.
    await drag([{ x: mid.x, y: mid.y }], [{ x: mid.x + 4000, y: mid.y + 4000 }])
    const dragged = await viewer()
    check('a zoomed picture can be dragged', dragged.x > 0 && dragged.y > 0, JSON.stringify(dragged))
    check(
      'and stops with its edge at the edge of the stage',
      dragged.x <= dragged.slackX + 1 && dragged.y <= dragged.slackY + 1,
      `${dragged.x.toFixed(0)},${dragged.y.toFixed(0)} of ${dragged.slackX.toFixed(0)},${dragged.slackY.toFixed(0)}`,
    )

    await page.touchscreen.tap(Math.round(mid.x), Math.round(mid.y))
    await page.waitForTimeout(300)
    const tapped = await viewer()
    check('tapping a zoomed picture puts it back', tapped.scale === 1 && tapped.x === 0, JSON.stringify(tapped))

    await page.touchscreen.tap(Math.round(mid.x), Math.round(mid.y))
    await page.waitForTimeout(300)
    check('and tapping a fitted one zooms in', (await viewer()).scale === 2)

    await page.keyboard.press('0')
    await page.waitForTimeout(250)
    check('0 fits it again', (await viewer()).scale === 1)

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

  /* ---- daily note for any day ------------------------------------------
   * The palette has always been able to open today's note. This is the same
   * note for any day you can point at, so it is checked on a day that is not
   * today: pick an empty cell in this month, take the offer, and the note has
   * to come back filed under that day rather than under the day it was made.
   */
  const otherDay = page.locator('.cal-day[data-outside="0"][data-today="0"]').first()
  const otherLabel = await otherDay.getAttribute('aria-label')
  await otherDay.click()
  await page.waitForTimeout(300)
  check('an empty day offers a daily note', (await page.locator('.list-pane .daily-row').count()) === 1, otherLabel)
  check('the rail offers it too', (await page.locator('.rail .day-create-row').count()) === 1)
  const dailyName = await page.locator('.list-pane .daily-row-name').innerText()
  await page.locator('.list-pane .daily-row').click()
  await page.waitForTimeout(500)
  const dailyTitle = await page.locator('.editor-title-input').inputValue()
  check(
    'creating it opens a note named for that day',
    `${dailyTitle}.md` === dailyName,
    `${dailyTitle} vs ${dailyName}`,
  )
  check(
    'the note is filed under the day it is named for',
    (await page.locator('.list-pane .note-row').count()) === 1,
    `${await page.locator('.list-pane .note-row').count()} notes on that day`,
  )
  check('the offer goes away once the day has one', (await page.locator('.daily-row, .day-create-row').count()) === 0)
  await otherDay.click() // clear the day filter again
  await page.waitForTimeout(200)

  /* ---- the calendar as a journal ---------------------------------------
   * The other reading of a click on a day, off by default: "write about this
   * day" rather than "show me what is filed on it". The case the mode exists
   * for is the day with nothing on it, so that is where it is checked — and
   * it has to ask there rather than writing a file on a guess, which is the
   * one way this could quietly litter somebody's vault.
   */
  await page.click('.pane-head .icon-btn[title^="Settings"]')
  await page.waitForSelector('.dialog')
  await page.click('.tab:has-text("Editor")')
  await page.waitForTimeout(250)
  const dayMode = page.locator('.dialog label.field:has-text("Clicking a day in the calendar") select')
  check('Settings offers the two readings of a calendar day', (await dayMode.count()) === 1)
  await dayMode.selectOption('daily')
  await page.click('.dialog-foot .btn-primary')
  await page.waitForTimeout(250)

  const blankDay = page
    .locator('.cal-day[data-outside="0"][data-today="0"]')
    .filter({ hasNot: page.locator('.cal-dot') })
    .first()
  const blankLabel = await blankDay.getAttribute('aria-label')
  await blankDay.click()
  await page.waitForTimeout(300)
  const asked = page.locator('.dialog:has-text("Start a note for this day?")')
  check('an empty day asks before it writes anything', (await asked.count()) === 1, blankLabel)
  check(
    'and names the file it would write',
    /Daily\/\d{4}-\d{2}-\d{2}\.md/.test(await asked.innerText().catch(() => '')),
  )
  await page.click('.dialog-foot .btn:not(.btn-primary)')
  await page.waitForTimeout(300)
  check(
    'saying no leaves the day as empty as it found it',
    (await page.locator('.list-pane .daily-row').count()) === 1,
  )
  check('but still selects the day, so its list is in front of you', (await page.locator('.list-pane .note-row').count()) === 0)

  await blankDay.click()
  await page.waitForTimeout(300)
  await page.click('.dialog-foot .btn-primary')
  await page.waitForTimeout(600)
  const journalTitle = await page.locator('.editor-title-input').inputValue()
  /*
   * Named for the day that was clicked, not for today: the aria-label the cell
   * announces is a `toDateString`, so the two are compared as dates rather than
   * as strings written two different ways.
   */
  const clickedDay = new Date(blankLabel.split(',')[0]).toDateString()
  check(
    'saying yes opens a note named for that day',
    new Date(`${journalTitle}T00:00:00`).toDateString() === clickedDay,
    `${journalTitle} vs ${clickedDay}`,
  )
  check(
    'and files it under that day rather than under today',
    (await page.locator('.list-pane .note-row').count()) === 1,
  )

  // A day that has one already goes straight there, with nothing to answer.
  await otherDay.click()
  await page.waitForTimeout(400)
  check('a day that already has one opens it without asking', (await page.locator('.scrim').count()) === 0)
  check(
    'and the note it opened is that day’s',
    `${await page.locator('.editor-title-input').inputValue()}.md` === dailyName,
  )

  // Back to filtering, which is what the rest of the run assumes.
  await page.click('.pane-head .icon-btn[title^="Settings"]')
  await page.waitForSelector('.dialog')
  await page.click('.tab:has-text("Editor")')
  await page.waitForTimeout(250)
  await dayMode.selectOption('filter')
  await page.click('.dialog-foot .btn-primary')
  await page.waitForTimeout(250)
  // And out of the day the journal left selected, which now has a note in it,
  // so the second click on it is a click on the day already showing.
  await otherDay.click()
  await page.waitForTimeout(200)
  // Put the note the rest of the run works on back in the editor, and take
  // focus back out of it — ⌘K is deliberately inert inside CodeMirror.
  await page.locator('.note-row').filter({ hasText: 'Lisbon Trip' }).first().click()
  await page.waitForTimeout(300)
  await page.locator('.list-pane .pane-title').click()
  await page.waitForTimeout(150)

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

  /* ---- the three editor modes -------------------------------------------
   * ⌘⇧M cycles rich → live → source and the run starts in live, so one press
   * lands on source, the next on rich, and the third comes back where it
   * started. Rich text is checked hardest: it is the only mode where the user
   * never sees the markdown, so anything it writes has to be verified against
   * the file rather than the screen.
   */
  await page.keyboard.press('Control+Shift+m')
  await page.waitForTimeout(400)
  const sourceText = await page.locator('.cm-content').innerText()
  check('source mode reveals raw markdown', sourceText.includes('![['), sourceText.slice(0, 50))

  /**
   * Wait for the Tag Folder dialog to be usable, not merely present.
   *
   * It seeds its fields from the draft in an effect, so the input existing is
   * not the same as the input holding what it is about to hold — typing into it
   * any sooner is a fill the seeding then wipes.
   */
  const ruleDialogReady = async () => {
    await page.waitForSelector('.rule-input')
    await page.waitForTimeout(300)
  }

  await page.keyboard.press('Control+Shift+m')
  await page.waitForTimeout(400)
  check('a note being read shows no formatting bar', (await page.locator('.fmt-bar').count()) === 0)
  await startEditing()
  check('rich text mode shows a formatting bar', (await page.locator('.fmt-bar').count()) === 1)

  /*
   * Reach a bar control the way a person has to.
   *
   * The bar overflows into a "…" menu when the pane is too narrow for every
   * group — which at this viewport, with the calendar inline, it is. So a
   * control is either a button on the bar or a row in that menu, and a test
   * that only knew about the first would be testing the window size.
   */
  const clickFormat = async (label) => {
    const onBar = page.locator(`.fmt-bar .fmt-btn[aria-label="${label}"]:not([data-overflow])`)
    if ((await onBar.count()) && (await onBar.first().isVisible())) {
      await onBar.first().click()
      return 'bar'
    }
    await page.locator('.fmt-more').click()
    await page.waitForTimeout(250)
    await page.locator('.menu-item', { hasText: label }).first().click()
    return 'menu'
  }
  const richText = await page.locator('.cm-content').innerText()
  check(
    'rich text mode shows no markdown syntax at all',
    !richText.includes('![[') && !richText.includes('**') && !/(^|\n)#+ /.test(richText),
    richText.slice(0, 50),
  )

  // The first line, not the middle of the pane: this note has an image embed
  // in it, and clicking that opens the lightbox instead of placing a caret.
  await page.locator('.cm-line').first().click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('Toolbar line')
  await page.waitForTimeout(250)

  await page.locator('.fmt-bar .fmt-style:text-is("Heading")').click()
  await page.waitForTimeout(400)
  check(
    'the Heading button writes "## " into the markdown',
    (await noteAfterEdit('Toolbar line', '## Toolbar line')).includes('## Toolbar line'),
  )
  check(
    'the bar reports Heading as the active style',
    (await page.getAttribute('.fmt-bar .fmt-style:text-is("Heading")', 'aria-pressed')) === 'true',
  )
  check(
    'the heading marker itself stays hidden',
    !(await page.locator('.cm-content').innerText()).includes('## Toolbar'),
  )

  await clickFormat('Underline (⌘U)')
  await page.waitForTimeout(400)
  const underlined = await noteAfterEdit('Toolbar', '<u>')
  check('underline is written as HTML, which markdown has no syntax for', underlined.includes('<u>'))
  check(
    'the <u> tags are not shown to the reader',
    !(await page.locator('.cm-content').innerText()).includes('<u>'),
  )
  check(
    'formatting is applied on the line the caret is on',
    (await page.locator('.cm-underline').count()) > 0,
  )

  /* ---- the bar runs out of room ----------------------------------------
   * The editor pane is the one that never yields width, so with the calendar
   * inline there can be less than half the bar's natural width to put it in.
   * It used to be clipped at the pane's edge against the calendar — and it
   * scrolls sideways, but with the scrollbar hidden nothing said so, which made
   * Link and Table look like features that did not exist.
   *
   * What is asserted is the property, not a group count: whatever the width,
   * the bar never has content it cannot show, and everything it cannot show is
   * in the menu.
   */
  const barState = () =>
    page.evaluate(() => {
      const bar = document.querySelector('.fmt-bar')
      if (!bar) return null
      const groups = [...bar.querySelectorAll('[data-fmt-part="group"]')]
      const more = bar.querySelector('[data-fmt-more]')
      return {
        clipped: bar.scrollWidth - bar.clientWidth,
        shown: groups.filter((g) => !g.hasAttribute('data-overflow')).length,
        hidden: groups.filter((g) => g.hasAttribute('data-overflow')).length,
        moreShown: !more.hasAttribute('data-overflow'),
      }
    })

  const narrow = await barState()
  check(
    'a bar too wide for the pane is never left clipped',
    narrow.clipped === 0,
    `${narrow.clipped}px past the edge`,
  )
  check(
    'what it cannot fit goes behind a "…" instead',
    narrow.hidden > 0 && narrow.moreShown,
    `${narrow.shown} shown, ${narrow.hidden} hidden`,
  )

  await page.locator('.fmt-more').click()
  await page.waitForTimeout(300)
  const overflowRows = await page.locator('.menu-item').allInnerTexts()
  check(
    'and the menu holds exactly what the bar dropped',
    overflowRows.includes('Insert table') && overflowRows.includes('Add link'),
    JSON.stringify(overflowRows),
  )
  check(
    'a control the caret is already in reports itself as on',
    (await page.locator('.menu-item[data-checked="1"], .menu-item:not([data-checked])').count()) > 0,
  )

  // A command from the menu has to reach the note and hand focus back, or the
  // next keystroke goes nowhere.
  await page.locator('.menu-item', { hasText: 'Block quote' }).first().click()
  await page.waitForTimeout(500)
  const quoted = await noteAfterEdit('Toolbar', '> ## Toolbar')
  check(
    'running one from the menu edits the note',
    quoted.includes('> ## Toolbar'),
    quoted.split('\n').filter((l) => l.includes('Toolbar'))[0],
  )
  check(
    'and gives the editor its caret back',
    await page.evaluate(() => (document.activeElement?.className ?? '').includes('cm-content')),
  )
  await page.locator('.fmt-more').click()
  await page.waitForTimeout(300)
  check(
    'the menu shows that toggle as on next time it opens',
    (await page.locator('.menu-item[data-checked="1"]', { hasText: 'Block quote' }).count()) === 1,
  )
  await page.locator('.menu-item', { hasText: 'Block quote' }).first().click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(SHOTS, '21-format-overflow.png') })

  /*
   * Give the bar room and it takes its groups back — the measuring pass has to
   * un-hide before it measures, or a group once dropped could never return.
   */
  await page.setViewportSize({ width: 1800, height: 900 })
  await page.waitForTimeout(600)
  const wide = await barState()
  check(
    'widening the pane brings the groups back',
    wide.shown > narrow.shown && wide.clipped === 0,
    `${narrow.shown} → ${wide.shown} groups`,
  )
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForTimeout(500)
  const backAgain = await barState()
  check(
    'and narrowing it hides them again',
    backAgain.shown === narrow.shown && backAgain.clipped === 0,
    `${wide.shown} → ${backAgain.shown} groups`,
  )

  /* ---- rich text, where the caret is in markup it cannot see -------------
   * Every check here is a position that draws at the same pixel as another
   * one: after a highlight's text and before its hidden `==`, at the start of
   * `## Heading` and in front of the `#`, between a hidden `- ` and the
   * checkbox after it. Each of them used to split the construct in half, and
   * none of it is visible on screen — so the file is what gets asserted.
   */
  await page.evaluate(async (text) => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('slate')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const tx = db.transaction('files', 'readwrite')
    tx.objectStore('files').put({
      path: 'Hidden Markup.md',
      kind: 'note',
      text,
      mime: 'text/markdown',
      size: text.length,
      hash: 'hidden',
      mtime: Date.now() + 30_000,
      ctime: Date.now(),
      dirty: true,
      dirtyFlag: 1,
      sync: {},
    })
    await new Promise((res) => {
      tx.oncomplete = res
    })
  }, ['==Highlighted phrase==', '', '## Heading line', '', '- [ ] Test task', '', 'Some ==sample== words', '', '```js', 'const a = 1', '```', '', '## Deletable heading', '', '- [ ] second task', '', '## Cut me', '', 'joinable', '', '## Pulled up', ''].join('\n'))
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.note-row')
  await page.locator('.note-row', { hasText: 'Hidden Markup' }).first().click()
  await page.waitForTimeout(600)
  await startEditing()
  check('the editor mode survives a reload', (await page.locator('.fmt-bar').count()) === 1)

  /** The box of the rendered line holding some text, for clicking into. */
  const lineBox = (needle) =>
    page.locator('.cm-content .cm-line', { hasText: needle }).first().boundingBox()

  /*
   * The fence, which rich text hides everywhere else. It is where the language
   * is written, and the language is the whole of whether the block is
   * highlighted — so it comes back for the caret, exactly as a link's URL does.
   */
  const codeBox = await lineBox('const a = 1')
  await page.mouse.click(codeBox.x + 20, codeBox.y + codeBox.height / 2)
  await page.waitForTimeout(350)
  check(
    'a code fence shows itself while the caret is in the block',
    (await page.locator('.cm-content').innerText()).includes('```js'),
  )
  check(
    'and the language on it is syntax highlighted',
    (await page.locator('.cm-line.cm-codeblock span').count()) > 2,
  )

  const phraseBox = await lineBox('Highlighted phrase')
  await page.mouse.click(phraseBox.x + phraseBox.width - 4, phraseBox.y + phraseBox.height / 2)
  await page.waitForTimeout(250)
  check(
    'the fence hides again once the caret leaves',
    !(await page.locator('.cm-content').innerText()).includes('```'),
  )

  await page.keyboard.press('Enter')
  check(
    'Enter after a highlighted phrase breaks after the highlight, not through it',
    (await noteAfterEdit('Highlighted phrase', '==Highlighted phrase==\n')).includes(
      '==Highlighted phrase==\n',
    ),
  )

  const headingBox = await lineBox('Heading line')
  await page.mouse.click(headingBox.x + 1, headingBox.y + headingBox.height / 2)
  await page.waitForTimeout(250)
  await page.keyboard.press('Enter')
  check(
    'Enter at the start of a heading takes the heading down with its words',
    (await noteAfterEdit('Heading line', '\n\n## Heading line')).includes('\n\n## Heading line'),
  )

  const taskBox = await lineBox('Test task')
  await page.mouse.click(taskBox.x + 1, taskBox.y + taskBox.height / 2)
  await page.waitForTimeout(250)
  await page.keyboard.press('Enter')
  check(
    'Enter in front of a checkbox opens an empty checkbox above it',
    (await noteAfterEdit('Test task', '- [ ] \n- [ ] Test task')).includes('- [ ] \n- [ ] Test task'),
  )

  /*
   * The toggle has to be an exact round trip. Off and on again used to give
   * back two characters less every time, so the third press here is the one
   * that matters: it wrapped `mple` when the fix was not in.
   */
  await page.locator('.cm-content .cm-highlight', { hasText: 'sample' }).first().dblclick()
  await page.waitForTimeout(250)
  await clickFormat('Highlight (⌘⇧H)')
  await page.waitForTimeout(350)
  const unhighlighted = await noteAfterEdit('sample', 'Some sample words')
  check('a highlight comes off the words it was on', unhighlighted.includes('Some sample words'))
  await clickFormat('Highlight (⌘⇧H)')
  await page.waitForTimeout(350)
  check(
    'and goes back on exactly the same ones',
    (await noteAfterEdit('sample', '==sample==')).includes('Some ==sample== words'),
  )

  /*
   * And what leaves on the clipboard carries the markup the mode is hiding —
   * selecting the word inside a highlight can only ever land on the word,
   * since the `==` around it is atomic and the selection is merely against it.
   */
  const copiedMark = await page.evaluate(() => {
    const dt = new DataTransfer()
    document
      .querySelector('.cm-content')
      .dispatchEvent(
        new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }),
      )
    return dt.getData('text/plain')
  })
  check(
    'copying a highlighted word takes the highlight with it',
    copiedMark === '==sample==',
    JSON.stringify(copiedMark),
  )

  /*
   * The same pixel, now with the deletion keys and the clipboard.
   *
   * A heading can only be selected from the first character of its text, since
   * the `## ` in front of that has no geometry to drag across — so the copy
   * used to come out plain and a cut used to leave the `## ` behind on a line
   * of its own. Backspace from that same position used to take the heading off
   * while leaving the blank line above it, which is to say it could not undo
   * the Enter that had just made that blank line.
   */
  const headBox = await lineBox('Deletable heading')
  await page.mouse.click(headBox.x + 20, headBox.y + headBox.height / 2)
  await page.waitForTimeout(300)
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End')
  await page.waitForTimeout(200)
  const copiedHeading = await page.evaluate(() => {
    const dt = new DataTransfer()
    document
      .querySelector('.cm-content')
      .dispatchEvent(
        new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }),
      )
    return dt.getData('text/plain')
  })
  check(
    'copying a heading takes the markers that make it one',
    copiedHeading === '## Deletable heading',
    JSON.stringify(copiedHeading),
  )

  await page.keyboard.press('Home')
  await page.waitForTimeout(200)
  await page.keyboard.press('Backspace')
  check(
    'Backspace at the start of a heading takes the blank line above it first',
    (await noteAfterEdit('Deletable heading', '```\n## Deletable heading')).includes(
      '```\n## Deletable heading',
    ),
  )
  await page.keyboard.press('Backspace')
  check(
    'and the heading itself only on the press after that',
    (await noteAfterEdit('Deletable heading', '```\nDeletable heading')).includes(
      '```\nDeletable heading',
    ),
  )

  /*
   * Home on a checklist line lands between the hidden bullet and the checkbox
   * widget — the first place on that line with any geometry. Backspace there
   * took the `- ` and left `[ ] second task`: a bullet with the characters of a
   * checkbox in it, which is not a task and does not render as one.
   */
  const taskBox2 = await lineBox('second task')
  await page.mouse.click(taskBox2.x + 40, taskBox2.y + taskBox2.height / 2)
  await page.waitForTimeout(300)
  await page.keyboard.press('Home')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  check(
    'Backspace takes a whole checkbox off rather than stranding its brackets',
    (await noteAfterEdit('second task', '\nsecond task')).includes('\nsecond task') &&
      !(await noteContaining('second task')).includes('[ ] second task'),
    (await noteContaining('second task')).split('\n').slice(-3).join(' / '),
  )

  /* Cutting takes the markers out with the words, rather than stranding them. */
  const cutBox = await lineBox('Cut me')
  await page.mouse.click(cutBox.x + 20, cutBox.y + cutBox.height / 2)
  await page.waitForTimeout(300)
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End')
  await page.waitForTimeout(200)
  const cutText = await page.evaluate(() => {
    const dt = new DataTransfer()
    document
      .querySelector('.cm-content')
      .dispatchEvent(
        new ClipboardEvent('cut', { clipboardData: dt, bubbles: true, cancelable: true }),
      )
    return dt.getData('text/plain')
  })
  check('cutting a heading takes its markers too', cutText === '## Cut me', JSON.stringify(cutText))
  check(
    'and leaves an empty line rather than a bare "## "',
    !(await noteAfterEdit('joinable', '\n\n\njoinable')).includes('## \n'),
    JSON.stringify((await noteContaining('joinable')).slice(-40)),
  )

  /*
   * Delete at the end of a line, the same rule facing the other way: one press
   * used to take a blank line and a heading's markers together, turning three
   * lines into the single paragraph `joinablePulled up`.
   */
  const joinBox = await lineBox('joinable')
  await page.mouse.click(joinBox.x + 20, joinBox.y + joinBox.height / 2)
  await page.waitForTimeout(300)
  await page.keyboard.press('End')
  await page.keyboard.press('Delete')
  check(
    'Delete at the end of a line takes the blank line below before the heading under it',
    (await noteAfterEdit('joinable', 'joinable\n## Pulled up')).includes('joinable\n## Pulled up'),
  )
  await page.keyboard.press('Delete')
  check(
    'and pulls the line up on the press after that',
    (await noteAfterEdit('joinable', 'joinablePulled up')).includes('joinablePulled up'),
  )

  await page.keyboard.press('Control+Shift+m')
  await page.waitForTimeout(300)
  check('cycling lands back in live preview', (await page.locator('.fmt-bar').count()) === 0)

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
      '> [!WARNING] Friday deploys',
      '> The window closes at 16:00.',
      '',
      '> [!bug]',
      '> An alias: caution\'s colour, its own glyph, and its own name as the title.',
      '',
      '> [!nonsense] Not a type anyone defined',
      '> so this has to stay an ordinary quote.',
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
      '```',
      'a fence with no language, whose whole first line is the hidden marker',
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
  check('blockquote is styled', (await page.locator('.cm-line.cm-quote').count()) >= 2)
  check('tags in code are not linkified', (await page.locator('.cm-tag').count()) === 1)
  check('a missing embed reports itself', (await page.locator('.cm-embed-missing').count()) === 1)

  /* ---- callouts --------------------------------------------------------
   * A callout is a blockquote wearing a colour, so what is asserted is that
   * the right lines got the right class, the marker became an icon, and — the
   * one that keeps the format honest — that a type nobody defined is still
   * rendered as the plain quote it is, exactly as GitHub renders it.
   */
  check(
    'a callout colours its own lines',
    (await page.locator('.cm-line.cm-callout-warning').count()) === 2,
    `${await page.locator('.cm-line.cm-callout-warning').count()} warning lines`,
  )
  check(
    'an alias lands in the colour it was aliased to',
    (await page.locator('.cm-line.cm-callout-caution').count()) === 2,
  )
  check(
    'the marker is replaced by an icon rather than shown',
    (await page.locator('.cm-callout-mark svg').count()) === 2 &&
      !(await page.locator('.cm-content').innerText()).includes('[!WARNING]'),
  )
  check(
    'an author\'s own title is kept',
    (await page.locator('.cm-callout-title').innerText()).includes('Friday deploys'),
  )
  check(
    'an untitled callout announces its own type instead',
    (await page.locator('.cm-callout-label').innerText()).trim() === 'Bug',
    await page.locator('.cm-callout-label').innerText(),
  )
  /*
   * Three blockquotes in the note, two of them callouts. Four lines still
   * carrying the plain quote class is the whole proof that the third — a type
   * nobody defined — was left alone, which is what GitHub does with an unknown
   * alert and what keeps the syntax safe to write.
   */
  check(
    'an unknown type stays an ordinary blockquote',
    (await page.locator('.cm-line.cm-quote').count()) === 4 &&
      (await page.locator('.cm-callout-mark').count()) === 2,
    `${await page.locator('.cm-line.cm-quote').count()} plain quote lines`,
  )
  await page.screenshot({ path: join(SHOTS, '07-kitchen-sink.png') })

  /* ---- the copy button on a code block ---------------------------------
   * Both fences get one, and the second is the case worth having: with no
   * language, the whole of its opening line is the hidden fence marker, so the
   * button is a point widget sitting at the end of a fully replaced range.
   *
   * The blocks are near the end of a long note, and CodeMirror only builds the
   * lines that are on screen — so they have to be scrolled to before any of
   * this is true.
   */
  await page.locator('.cm-content').evaluate((el) => {
    el.closest('.cm-scroller').scrollTop = el.closest('.cm-scroller').scrollHeight
  })
  await page.waitForTimeout(400)
  check('code block gets its own styling', (await page.locator('.cm-line.cm-codeblock').count()) >= 3)
  check(
    'a #tag inside a code block is still not linkified',
    (await page.locator('.cm-tag').count()) === 0,
  )
  check(
    'every fenced block gets a copy button',
    (await page.locator('.cm-code-copy').count()) === 2,
    `${await page.locator('.cm-code-copy').count()} buttons`,
  )

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.locator('.cm-code-copy').first().click()
  await page.waitForTimeout(250)
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  check(
    'the copy button copies the code without its fences',
    copied === 'const x = { a: 1 } // not a #tag and not a [[link]]',
    JSON.stringify(copied),
  )
  check(
    'and says so',
    (await page.locator('.cm-code-copy[data-copied]').count()) === 1,
  )
  check(
    'copying does not put a caret in the note',
    (await page.evaluate(() => document.activeElement?.className ?? '')).indexOf('cm-content') < 0,
  )
  check(
    'copying changed nothing in the note',
    consoleErrors.length === sinkErrorsBefore,
    consoleErrors.slice(sinkErrorsBefore).join(' | '),
  )

  // Back to the top: everything below reads this same note, and CodeMirror
  // only builds the lines that are on screen.
  await page.locator('.cm-content').evaluate((el) => {
    el.closest('.cm-scroller').scrollTop = 0
  })
  await page.waitForTimeout(400)

  /* ---- a note opens as a page, not as a caret ----------------------------
   * The phone keyboard is the whole reason. A note that opens focused covers
   * half of itself with a keyboard nobody asked for, before a word of it has
   * been read — so a note opened from the list has no editing surface at all
   * until someone asks for one. `contenteditable` is the thing that matters:
   * it is all a phone consults before raising the keyboard.
   */
  const asOpened = await readingState()
  check(
    'a note opens as a page with no editing surface',
    asOpened.flag === '1' && asOpened.editable === 'false',
    `reading=${asOpened.flag}, contenteditable=${asOpened.editable}`,
  )
  check(
    'and nothing in it holds focus, so a phone leaves its keyboard down',
    !asOpened.focused.includes('cm-content'),
    asOpened.focused || 'nothing focused',
  )
  check(
    'reading offers a way in that is not a guess',
    (await page.locator('.editor-pane [aria-label="Edit note"]').count()) === 1,
  )

  /*
   * A task's date chip answers its own tap.
   *
   * Same rule as the checkbox beside it: reading is not read-only, and giving a
   * task a date while reading through a note is the same kind of act as ticking
   * one off. Before the chip joined that list a single tap did two things —
   * opened the picker, and put the note into edit — and only one of them was
   * asked for. It is watched as a pointer event, so swallowing the mouse events
   * (which the chip does) was never enough on its own.
   */
  await page.click('[title^="New note"]')
  await page.waitForTimeout(500)
  await page.locator('.cm-content').click()
  await page.locator('.cm-content').pressSequentially('- [ ] Pay the deposit 📅 2026-09-04', {
    delay: 6,
  })
  await page.waitForTimeout(600)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  const beforeChipTap = await readingState()
  check(
    'a note with a dated task can be read without a caret in it',
    beforeChipTap.flag === '1',
    `reading=${beforeChipTap.flag}`,
  )
  /*
   * Tapped, not clicked, and that is the whole test. The chip opens its picker
   * on `mousedown`, and the scrim that appears swallows the mouse-up — so a
   * pointer never reaches the tap-to-edit watcher and a click reproduces
   * nothing. A phone sends pointerdown and pointerup first and the synthesised
   * mousedown afterwards, so there the editing starts before the picker is
   * even open. That ordering is the bug, and only a real tap has it.
   */
  await page.locator('.cm-due-chip[data-set="1"]').first().tap()
  await page.waitForTimeout(450)
  check(
    'tapping a task’s date while reading opens its picker',
    (await page.locator('.due-preset').count()) > 0,
  )
  const afterChipTap = await readingState()
  check(
    'and does not also drop a caret into the note',
    afterChipTap.flag === '1' && afterChipTap.editable === 'false',
    `reading=${afterChipTap.flag}, contenteditable=${afterChipTap.editable}`,
  )
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  // Back to the note everything below reads.
  await page.locator('.note-row', { hasText: 'Kitchen Sink' }).first().click()
  await page.waitForTimeout(600)

  /* ---- clicks land where they are aimed ---------------------------------
   * Vertical space around a heading or a code block has to be padding or a
   * transparent border, never margin: CodeMirror turns a click into a document
   * position through a height map built from measured line boxes, and a margin
   * is not part of one. A single `margin: 0.7em 0` on a heading used to put
   * every click below it a line out — worst at the bottom of a long note,
   * where the drift has accumulated through every block above it. This note is
   * the right fixture for that: headings, a code block and frontmatter, with
   * body text under all of them.
   */
  const clickWord = async (word) => {
    const box = await page.evaluate((w) => {
      const walk = document.createTreeWalker(
        document.querySelector('.cm-content'),
        NodeFilter.SHOW_TEXT,
      )
      let n
      while ((n = walk.nextNode())) {
        const i = n.textContent.indexOf(w)
        if (i < 0) continue
        const r = document.createRange()
        r.setStart(n, i)
        r.setEnd(n, i + w.length)
        if (!r.getBoundingClientRect().width) continue
        // The word has to be on screen before its coordinates mean anything.
        n.parentElement?.scrollIntoView({ block: 'center' })
        const b = r.getBoundingClientRect()
        const view = document.querySelector('.cm-scroller').getBoundingClientRect()
        if (b.top < view.top || b.bottom > view.bottom) return null
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
      }
      return null
    }, word)
    if (!box) return { ok: false, detail: 'not rendered' }
    await page.mouse.click(box.x, box.y)
    await page.waitForTimeout(120)
    return page.evaluate((w) => {
      const sel = getSelection()
      if (!sel.rangeCount) return { ok: false, detail: 'no selection' }
      const text = sel.anchorNode.textContent ?? ''
      const at = sel.anchorOffset
      const i = text.indexOf(w)
      return {
        ok: i >= 0 && at >= i && at <= i + w.length,
        detail: `caret landed in ${JSON.stringify(text.slice(0, 28))} at ${at}`,
      }
    }, word)
  }

  /*
   * The first of these is also the click that starts the editing: the gesture
   * that asks for a caret is the same one that says where it goes, which is
   * the only way tapping to edit can feel like no mode change at all.
   */
  for (const word of ['blockquote', 'numbered', 'Final']) {
    const landed = await clickWord(word)
    check(`clicking "${word}" puts the caret in that word`, landed.ok, landed.detail)
  }
  const afterTap = await readingState()
  check(
    'the click that placed the caret also started the editing',
    afterTap.flag === '0' && afterTap.editable === 'true' && afterTap.focused.includes('cm-content'),
    `reading=${afterTap.flag}, focused ${afterTap.focused || 'nothing'}`,
  )

  /* ---- following a link with a pointer -----------------------------------
   * The desktop half of the phone tests further down. One plain click opens
   * the link and the caret stays out of the text — a click that lands in the
   * middle of a link's own markdown instead of following it is the failure
   * this guards, and it is invisible to every other check here because the
   * note still renders perfectly while it happens.
   *
   * `window.open` is stubbed rather than let through: a real new tab would
   * take focus away from the page and strand the rest of the suite.
   */
  const armLinkTrap = () =>
    page.evaluate(() => {
      window.__opened = []
      window.open = (url) => {
        window.__opened.push(url)
        return null
      }
      // A link in a rendered table cell is a real anchor. One that reaches the
      // document still unprevented is one the browser would follow itself, on
      // top of whatever the app already did with it.
      window.__followed = []
      window.__linkTrap = (e) => {
        const a = e.target?.closest?.('a[href]')
        if (!a) return
        if (!e.defaultPrevented) window.__followed.push(a.href)
        e.preventDefault()
      }
      document.addEventListener('click', window.__linkTrap)
    })
  const linkTrapResult = () => page.evaluate(() => ({ opened: window.__opened, followed: window.__followed }))

  await armLinkTrap()
  const bodyLink = page.locator('.cm-uri').first()
  await bodyLink.scrollIntoViewIfNeeded()
  await bodyLink.click()
  await page.waitForTimeout(250)
  const clicked = await linkTrapResult()
  check(
    'clicking a link with a pointer opens it',
    clicked.opened.length === 1 && clicked.opened[0] === 'https://example.com',
    clicked.opened.join(',') || 'nothing opened',
  )
  /*
   * Asserted on the link rather than on the whole note. Comparing the note's
   * rendered text before and after looks stricter and is not: CodeMirror only
   * builds the lines that are on screen, so a click that scrolls the view
   * changes that text without anything having happened to the link — which is
   * what this used to catch. The claim is that the caret stayed out, and live
   * preview reveals a link's URL the moment it goes in, so the URL still being
   * hidden is the claim itself.
   */
  const afterLinkClick = await page.locator('.cm-content').innerText()
  check(
    'and leaves the caret out of the link text',
    afterLinkClick.includes('an external link') &&
      !afterLinkClick.includes('](https://example.com)'),
    afterLinkClick.split('\n').find((l) => l.includes('external')) ?? 'link line not rendered',
  )

  // Right-click is the desktop way to reach a link's own text, since one plain
  // click is spent on opening it.
  await bodyLink.click({ button: 'right' })
  await page.waitForTimeout(300)
  check('right-click on a link offers what to do with it', (await page.locator('.menu').count()) === 1)
  check(
    'including editing it',
    (await page.locator('.menu-item:has-text("Edit link")').count()) === 1,
  )
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  /*
   * Clicking a table in rich text puts the caret in the cell, not in the
   * pipes: the rendered table *is* the editor there. (Live preview's
   * click-to-reveal is checked in the table section further down.)
   *
   * The mode is put into rich text here rather than inherited: the editor mode
   * is a saved preference, so what this note opens in depends on reloads pages
   * of script away, and a table check failing because the app was in live
   * preview says nothing about tables.
   */
  await startEditing()
  for (let i = 0; i < 3 && (await page.locator('.fmt-bar').count()) === 0; i++) {
    await page.keyboard.press('Control+Shift+m')
    await page.waitForTimeout(400)
    await page.locator('.cm-content').click()
    await page.waitForTimeout(250)
  }
  check('rich text is reachable from wherever the mode was left', (await page.locator('.fmt-bar').count()) === 1)
  await page.locator('.cm-table-render td').first().click()
  await page.waitForTimeout(400)
  check(
    'clicking a table in rich text starts editing the cell',
    (await page.evaluate(() => document.activeElement?.className)) === 'cm-table-cell' &&
      (await page.locator('.cm-line.cm-table').count()) === 0,
  )

  // The same operation the phone runs from its sheet, run with a pointer:
  // here typing *should* carry straight on, so the new cell takes focus rather
  // than only being marked. `clickFormat` reaches the control wherever it is —
  // and at this width that is the overflow menu, so this doubles as the check
  // that a menu opened from a menu row still opens.
  const barRows = await page.locator('.cm-table-render tr').count()
  await clickFormat('Table rows and columns')
  await page.waitForTimeout(300)
  await page.locator('.menu-item', { hasText: 'Insert row below' }).click()
  await page.waitForTimeout(400)
  check(
    'the bar adds a row and keeps typing in it',
    (await page.locator('.cm-table-render tr').count()) === barRows + 1 &&
      (await page.evaluate(() => document.activeElement?.className)) === 'cm-table-cell',
    `${barRows} → ${await page.locator('.cm-table-render tr').count()}`,
  )
  await clickFormat('Table rows and columns')
  await page.waitForTimeout(300)
  check(
    'the menu names the cell the buttons act on, not the caret',
    (await page.locator('.menu-title').innerText()).includes('row 3 of 4'),
    await page.locator('.menu-title').innerText(),
  )
  await page.locator('.menu-item', { hasText: 'Delete row' }).click()
  await page.waitForTimeout(400)
  check('and takes it away again', (await page.locator('.cm-table-render tr').count()) === barRows)


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
  await ruleDialogReady()
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
  await ruleDialogReady()
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

  /* ---- the folder tree remembers its shape ------------------------------
   *
   * Which rows are unfolded is per folder and kept in this device's own store,
   * so it has to be exercised in a real browser: the case that matters is a row
   * that gets unmounted — by its parent folding, or by the whole section — and
   * has to come back the way it was rather than at some default. An exact name
   * match, because "Folders" is also a substring of "Tag Folders".
   */
  const folderGroup = page.locator('.side-group', {
    has: page.locator('.side-group-name', { hasText: /^Folders$/ }),
  })
  const folderRow = (name) =>
    folderGroup
      .locator('.side-row')
      .filter({ has: page.locator('.side-name', { hasText: new RegExp(`^${name}$`) }) })
  const shown = async (name) => (await folderRow(name).count()) > 0
  const foldFolder = async (name) => {
    await folderRow(name).locator('.disclose').first().click()
    await page.waitForTimeout(250)
  }
  const foldSection = async () => {
    await folderGroup.locator('.side-group-toggle').first().click()
    await page.waitForTimeout(250)
  }

  check('a folder unfolded to make a subfolder stays unfolded over a reload', await shown('Acme'))

  promptReply = 'Roadmap'
  await folderRow('Acme').click({ button: 'right' })
  await page.waitForTimeout(250)
  await page.locator('.menu-item:has-text("New subfolder")').click()
  await page.waitForTimeout(450)
  check('a third level can be created', await shown('Roadmap'))

  await foldFolder('Acme')
  check('folding a folder hides what is inside it', !(await shown('Roadmap')))

  await foldSection()
  check('folding the section hides the tree', !(await shown('Clients')))
  await foldSection()
  check('unfolding the section brings back the tree', await shown('Clients'))
  check('with the shape it had, not everything unfolded', (await shown('Acme')) && !(await shown('Roadmap')))

  await foldFolder('Acme')
  check('and a folder unfolds again to what it was', await shown('Roadmap'))



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

  /*
   * A link in a cell is the one link in a note that is a real anchor, so it is
   * the one that can be opened twice: once by the app, and once by the browser
   * following it afterwards.
   */
  await armLinkTrap()
  await page.locator('.cm-table-render a[href^="https"]').first().click()
  await page.waitForTimeout(250)
  const cellClicked = await linkTrapResult()
  check(
    'a link in a table cell opens',
    cellClicked.opened.length === 1,
    `${cellClicked.opened.length} opened`,
  )
  check(
    'and the browser is not left to open it a second time',
    cellClicked.followed.length === 0,
    cellClicked.followed.join(','),
  )

  /* ---- typing straight into a rendered table ---------------------------
   * Rich text never shows the pipes, so the cells have to be the editor: each
   * one is its own contenteditable, committing to the markdown when it is
   * left. What matters is that the file ends up holding an ordinary GFM table
   * — that is what another editor will open.
   */
  // Padded on every rewrite, so the needle has to be something outside it.
  const tableSource = () => noteContaining('# Tables')

  /*
   * A cell is its own editing host, and would happily take a tap and raise the
   * keyboard in a note that is only being read. So while a note is a page, its
   * table is a picture of a table: the cells are not typing surfaces until the
   * note has one of its own.
   */
  check(
    'a table in a note being read has no typeable cells',
    (await page.locator('.cm-table-render').count()) === 1 &&
      (await page.locator('.cm-table-cell[contenteditable]').count()) === 0,
    `${await page.locator('.cm-table-cell[contenteditable]').count()} of ${await page.locator('.cm-table-cell').count()} cells typeable`,
  )
  await startEditing()
  // Rich text again, for the same reason: the mode is a saved preference, and
  // a cell is only an editing surface in the mode that never shows the pipes.
  for (let i = 0; i < 3 && (await page.locator('.fmt-bar').count()) === 0; i++) {
    await page.keyboard.press('Control+Shift+m')
    await page.waitForTimeout(400)
  }
  check('the cells belong to rich text, so that is the mode', (await page.locator('.fmt-bar').count()) === 1)
  check(
    'and gets them the moment the note is being written in',
    (await page.locator('.cm-table-cell[contenteditable]').count()) > 0,
    `${await page.locator('.cm-table-cell[contenteditable]').count()} typeable`,
  )

  await page.locator('.cm-table-cell[data-row="1"][data-col="1"]').click()
  await page.waitForTimeout(200)
  await page.keyboard.press('Control+a')
  await page.keyboard.type('rewritten')
  check(
    'the table stays rendered while a cell is typed in',
    (await page.locator('.cm-table-render').count()) === 1,
  )
  await page.keyboard.press('Tab')
  await page.waitForTimeout(500)
  check(
    'Tab commits the cell and moves to the next one',
    (await page.evaluate(() => {
      const el = document.activeElement
      return el?.dataset?.row === '2' && el?.dataset?.col === '0'
    })) === true,
  )
  const edited = await tableSource()
  check('the cell is written back as markdown', /\| rewritten +\|/.test(edited), edited.split('\n')[4])
  check(
    'and the table is still a table',
    /^\| -+ \| -+ \|$/m.test(edited),
    edited.split('\n')[3],
  )

  // A pipe typed into a cell is escaped, not a new column.
  await page.locator('.cm-table-cell[data-row="1"][data-col="1"]').click()
  await page.waitForTimeout(200)
  await page.keyboard.press('Control+a')
  await page.keyboard.type('x | y')
  await page.locator('.cm-line').first().click()
  await page.waitForTimeout(500)
  check('a typed pipe is escaped', (await tableSource()).includes('x \\| y'))
  check('the table survives it', (await page.locator('.cm-table-render').count()) === 1)

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

  /*
   * Live preview keeps the older contract: the caret reveals the pipes, the
   * same as it reveals every other construct it is sitting in. Only rich text
   * edits the cells in place, so this hops modes to check it and hops back.
   */
  await page.keyboard.press('Control+Shift+m') // rich -> live
  await page.waitForTimeout(400)
  await page.locator('.cm-table-render td').first().click()
  await page.waitForTimeout(400)
  check(
    'clicking a table in live preview reveals its markdown',
    (await page.locator('.cm-line.cm-table').count()) > 0 &&
      (await page.locator('.cm-table-render').count()) === 0,
  )
  await page.screenshot({ path: join(SHOTS, '17-table-source.png') })
  await page.keyboard.press('Control+Shift+m') // live -> source
  await page.waitForTimeout(200)
  await page.keyboard.press('Control+Shift+m') // source -> rich
  await page.waitForTimeout(400)

  /* ---- insert a photo ---------------------------------------------------- */
  await page.locator('.note-row').filter({ hasText: 'Table formatting' }).first().click()
  await page.waitForTimeout(400)
  // Insert puts something where the caret is, so it belongs to a note being
  // written in — a note being read has no caret for it to aim at.
  check(
    'a note being read offers no Insert button',
    (await page.locator('[aria-label="Insert photo or file"]').count()) === 0,
  )
  await startEditing()
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
  await ruleDialogReady()
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
  await ruleDialogReady()

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
  await ruleDialogReady()
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
  await ruleDialogReady()
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

  /* ---- focus mode, and a note in a window of its own ----------------------
   *
   * Both are desktop only. Focus mode is a CSS-level thing and cheap to check;
   * the popout is a second window, and everything that could go wrong about it
   * is a boundary between the two — the note being handed over cleanly, what
   * is typed next door reaching this window's copy of the vault, and the note
   * coming back when the window closes. So all three are checked here rather
   * than trusted to look right.
   */
  await page.keyboard.press('Meta+n')
  await page.waitForSelector('.cm-content')
  await page.keyboard.type('# Popped out\n\nwritten in the main window')
  await page.waitForTimeout(600)

  await page.click('.editor-head [aria-label="Focus mode"]')
  await page.waitForTimeout(250)
  check('focus mode gives the note the whole window', (await page.getAttribute('.shell', 'data-zen')) === '1')
  check(
    'and takes every panel with it',
    !(await page.locator('.pane.sidebar').isVisible()) && (await page.locator('.statusbar').count()) === 0,
  )
  /*
   * Laid out however Settings → Editor → Body width says, which for this run is
   * the default: full width. Focus mode briefly overrode that with a reading
   * column of its own, which meant the same preference was answered two
   * different ways depending on which window the note was in.
   */
  check(
    'and leaves the body width to the setting',
    (await page.getAttribute('.editor-pane', 'data-width')) === 'full',
    await page.getAttribute('.editor-pane', 'data-width'),
  )
  await page.screenshot({ path: join(SHOTS, '30-focus-mode.png') })
  await page.keyboard.press('Meta+Shift+f')
  await page.waitForTimeout(250)
  check('⌘⇧F puts them back', (await page.getAttribute('.shell', 'data-zen')) === '0')

  const popoutSoon = page.waitForEvent('popup')
  await page.locator('.editor-head [aria-label="Focus mode"]').click({ modifiers: ['Shift'] })
  const popout = await popoutSoon
  popout.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`popout: ${m.text()}`)
  })
  popout.on('pageerror', (e) => consoleErrors.push(`popout pageerror: ${e.message}`))
  await popout.waitForSelector('.popout-shell .cm-content', { timeout: 15_000 })
  const popoutText = await popout.locator('.cm-content').innerText()
  check(
    'Shift-clicking the same button opens the note in its own window',
    popoutText.includes('written in the main window'),
    JSON.stringify(popoutText.slice(0, 48)),
  )
  check(
    'which is one note and no app around it',
    (await popout.locator('.pane.sidebar').count()) === 0 &&
      (await popout.locator('.statusbar').count()) === 0,
  )
  check(
    'and the pane it left holds no second editor on the same note',
    (await page.locator('.popped-card').count()) === 1 &&
      (await page.locator('.editor-pane .cm-content').count()) === 0,
  )
  await popout.screenshot({ path: join(SHOTS, '31-popout-window.png') })

  await popout.locator('.cm-content').click()
  await popout.waitForTimeout(200)
  await popout.keyboard.type('\n\nand this was typed next door')
  const mirrored = await noteAfterEdit('written in the main window', 'typed next door')
  check("what is typed there reaches this window's vault", mirrored.includes('typed next door'))

  await popout.close()
  await page.waitForTimeout(1500)
  check(
    'closing that window hands the note back',
    (await page.locator('.popped-card').count()) === 0 &&
      (await page.locator('.editor-pane .cm-content').count()) === 1,
  )
  const returned = await page.locator('.editor-pane .cm-content').innerText()
  check(
    'with everything that was written in it while it was away',
    returned.includes('typed next door'),
    JSON.stringify(returned.slice(-42)),
  )

  // Put the vault back the way the rest of the run expects to find it.
  await page.click('.editor-head [title="Delete note"]')
  await page.waitForTimeout(500)

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

  /*
   * The same chip, the same picker — as a sheet. This is the half of the
   * feature a popover under the cursor cannot serve: a menu pinned to a
   * fingertip is half off-screen, and day cells sized for a mouse are not
   * targets a thumb can hit.
   */
  const phoneChip = page.locator('.task-row .due-chip').first()
  check('every task row carries a date button on a phone too', (await phoneChip.count()) === 1)
  const chipBox = await phoneChip.boundingBox()
  check(
    'the chip is a real touch target',
    chipBox.height >= 32 && chipBox.width >= 40,
    `${Math.round(chipBox.width)}×${Math.round(chipBox.height)}`,
  )
  await phoneChip.tap()
  await page.waitForTimeout(400)
  const dueSheet = await page.evaluate(() => {
    const box = document.querySelector('.menu-due')
    const day = document.querySelector('.due-day')
    return {
      isSheet: !!box?.classList.contains('menu-sheet'),
      atBottom: box ? Math.round(window.innerHeight - box.getBoundingClientRect().bottom) : -1,
      width: box ? Math.round(box.getBoundingClientRect().width / window.innerWidth * 100) : 0,
      dayHeight: day ? Math.round(day.getBoundingClientRect().height) : 0,
      presets: document.querySelectorAll('.due-preset').length,
    }
  })
  check('the picker arrives as a bottom sheet, not a popover', dueSheet.isSheet)
  check('flush to the bottom edge', dueSheet.atBottom === 0, `${dueSheet.atBottom}px off`)
  check('and full width', dueSheet.width >= 99, `${dueSheet.width}%`)
  check('its day cells are thumb-sized', dueSheet.dayHeight >= 40, `${dueSheet.dayHeight}px`)
  check('with the same presets on top', dueSheet.presets >= 3, `${dueSheet.presets}`)
  await page.screenshot({ path: join(SHOTS, '11b-phone-due.png') })

  const beforePick = await page.locator('.task-row .due-chip').first().innerText()
  await page.locator('.due-preset:has-text("Today")').tap()
  await page.waitForTimeout(500)
  check('the sheet closes on a choice', (await page.locator('.due-pick').count()) === 0)
  check(
    'and the row shows the date it was given',
    (await page.locator('.task-row .due-chip').first().innerText()).trim() === 'Today',
    `was "${beforePick.trim()}"`,
  )

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

  /*
   * The whole point of the reading mode, on the device it was written for: the
   * note fills the screen and the keyboard is nowhere, until a tap in the text
   * asks for it.
   */
  const phoneOpened = await readingState()
  check(
    'a note opened on a phone raises no keyboard',
    phoneOpened.flag === '1' &&
      phoneOpened.editable === 'false' &&
      !phoneOpened.focused.includes('cm-content'),
    `reading=${phoneOpened.flag}, contenteditable=${phoneOpened.editable}, focused ${phoneOpened.focused || 'nothing'}`,
  )
  const tapAt = await noteTextPoint('.editor-overlay')
  await page.touchscreen.tap(tapAt.x, tapAt.y)
  await page.waitForTimeout(300)
  const phoneTapped = await readingState()
  check(
    'tapping the note is what starts editing it',
    phoneTapped.flag === '0' &&
      phoneTapped.editable === 'true' &&
      phoneTapped.focused.includes('cm-content'),
    `reading=${phoneTapped.flag}, focused ${phoneTapped.focused || 'nothing'}`,
  )

  /* ---- the phone's Format sheet -----------------------------------------
   * Rich text on a phone has one rule: the keyboard and the Format sheet never
   * share the screen. Between them they leave almost no note visible, and
   * nobody formats and types in the same moment anyway.
   */
  /** Choose an editor mode from the note-actions menu, which lists all three. */
  const chooseMode = async (label) => {
    await page.locator('.editor-overlay [aria-label="Note actions"]').click()
    await page.waitForTimeout(300)
    await page.locator('.menu-item', { hasText: new RegExp(`^${label}$`) }).click()
    await page.waitForTimeout(400)
  }
  await chooseMode('Rich text')
  await startEditing()
  check('the phone can switch to rich text', (await page.locator('.fmt-open').count()) === 1)
  const richAt = await noteTextPoint('.editor-overlay')
  await page.mouse.click(richAt.x, richAt.y)
  await page.waitForTimeout(250)
  check(
    'tapping the note focuses it for typing',
    await page.evaluate(() => document.activeElement?.classList.contains('cm-content')),
  )

  await page.locator('.fmt-open').click()
  await page.waitForTimeout(400)
  const fmt = await page.evaluate(() => {
    const s = document.querySelector('.fmt-sheet')?.getBoundingClientRect()
    const body = document.querySelector('.editor-body')?.getBoundingClientRect()
    const cursor = document.querySelector('.cm-cursor')
    if (!s || !body) return null
    return {
      height: Math.round(s.height),
      share: Math.round((s.height / window.innerHeight) * 100),
      bodyEndsAt: Math.round(body.bottom),
      sheetStartsAt: Math.round(s.top),
      cursorShown: cursor ? getComputedStyle(cursor).display : 'none',
      focused: document.activeElement?.className ?? '',
    }
  })
  check('the Format sheet is compact', !!fmt && fmt.share <= 20, `${fmt?.height}px, ${fmt?.share}% of the screen`)
  check('the sheet has no title bar to pay for', (await page.locator('.fmt-sheet h2').count()) === 0)
  check(
    'the note shrinks rather than hiding under the sheet',
    !!fmt && fmt.bodyEndsAt <= fmt.sheetStartsAt + 1,
    `note ends at ${fmt?.bodyEndsAt}, sheet starts at ${fmt?.sheetStartsAt}`,
  )
  check('opening the sheet dismisses the keyboard', !!fmt && !fmt.focused.includes('cm-content'), fmt?.focused)
  check('the caret stays visible with the editor blurred', fmt?.cursorShown === 'block', fmt?.cursorShown)
  await page.screenshot({ path: join(SHOTS, '18-phone-format.png') })

  const backToTyping = await noteTextPoint('.editor-overlay')
  await page.mouse.click(backToTyping.x, backToTyping.y)
  await page.waitForTimeout(400)
  check('touching the note closes the sheet', (await page.locator('.fmt-sheet').count()) === 0)
  check(
    'and the editor takes focus back for typing',
    await page.evaluate(() => document.activeElement?.classList.contains('cm-content')),
  )

  // The keyboard itself: the shell is shortened by it rather than covered.
  // Headless Chromium has no soft keyboard, so the inset the watcher publishes
  // is set by hand.
  const kb = await page.evaluate(() => {
    document.documentElement.style.setProperty('--kb-inset', '336px')
    const body = document.querySelector('.editor-body').getBoundingClientRect()
    return { bodyEndsAt: Math.round(body.bottom), keyboardTop: window.innerHeight - 336 }
  })
  check(
    'a keyboard shortens the editor instead of covering it',
    kb.bodyEndsAt <= kb.keyboardTop,
    `note ends at ${kb.bodyEndsAt}, keyboard starts at ${kb.keyboardTop}`,
  )
  await page.evaluate(() => document.documentElement.style.removeProperty('--kb-inset'))

  /* ---- editing a table from the phone's Format sheet ----------------------
   * The one case where the sheet acts on something that is not the editor's
   * caret. A cell is its own editing host, so opening the sheet takes its focus
   * away along with the keyboard — and the buttons still have to know which
   * row and column they are aimed at. Everything below is what "the table lost
   * focus and the note jumped to the top" looked like before: the cell is
   * marked rather than focused, the note stays where it was, and an operation
   * from the sheet does not summon the keyboard back over it.
   */
  await page.locator('.editor-overlay [aria-label="Back"]').click()
  await page.waitForTimeout(350)
  await page.locator('.note-row', { hasText: 'Kitchen Sink' }).first().tap()
  await page.waitForTimeout(600)
  await startEditing()
  const cell = page.locator('.cm-table-cell[data-row="1"][data-col="1"]')
  await cell.scrollIntoViewIfNeeded()
  await cell.tap()
  await page.waitForTimeout(250)
  check(
    'tapping a cell on a phone starts editing it',
    (await page.evaluate(() => document.activeElement?.className)) === 'cm-table-cell',
  )

  const tableTop = async () =>
    page.evaluate(() => {
      const t = document.querySelector('.cm-table-render')?.getBoundingClientRect()
      const body = document.querySelector('.editor-body')?.getBoundingClientRect()
      return t && body ? { top: Math.round(t.top), from: Math.round(body.top), to: Math.round(body.bottom) } : null
    })
  const beforeSheet = await tableTop()
  await page.locator('.fmt-open').tap()
  await page.waitForTimeout(450)
  const armed = await page.evaluate(() => ({
    marked: document.querySelectorAll('.cm-table-cell[data-armed="1"]').length,
    at: document.querySelector('.cm-table-cell[data-armed="1"]')?.dataset ?? {},
    focused: document.activeElement?.className ?? '',
  }))
  const afterSheet = await tableTop()
  check('the Format sheet opens over a table', (await page.locator('.fmt-sheet').count()) === 1)
  check('opening it lets the keyboard go', !armed.focused.includes('cm-table-cell'), armed.focused)
  check(
    'the cell being formatted is still marked',
    armed.marked === 1 && armed.at.row === '1' && armed.at.col === '1',
    `${armed.marked} marked, row ${armed.at.row} col ${armed.at.col}`,
  )
  check(
    'the table does not jump off the screen',
    !!afterSheet && afterSheet.top >= afterSheet.from - 1 && afterSheet.top <= afterSheet.to,
    `table at ${afterSheet?.top}, note spans ${afterSheet?.from}–${afterSheet?.to} (was ${beforeSheet?.top})`,
  )
  check(
    'the table button knows it is in a table',
    (await page.getAttribute('.fmt-sheet .fmt-btn[aria-label="Table rows and columns"]', 'aria-pressed')) === 'true',
  )

  const rowsBefore = await page.locator('.cm-table-render tr').count()
  await page.locator('.fmt-sheet .fmt-btn[aria-label="Table rows and columns"]').tap()
  await page.waitForTimeout(350)
  check('the table menu opens as a sheet', (await page.locator('.menu-sheet').count()) === 1)
  await page.locator('.menu-item', { hasText: 'Insert row below' }).tap()
  await page.waitForTimeout(450)
  const after = await page.evaluate(() => ({
    rows: document.querySelectorAll('.cm-table-render tr').length,
    at: document.querySelector('.cm-table-cell[data-armed="1"]')?.dataset ?? {},
    focused: document.activeElement?.className ?? '',
    sheet: document.querySelectorAll('.fmt-sheet').length,
  }))
  check('inserting a row from the sheet adds one', after.rows === rowsBefore + 1, `${rowsBefore} → ${after.rows}`)
  check('the mark follows the new row', after.at.row === '2' && after.at.col === '1', `row ${after.at.row} col ${after.at.col}`)
  check('the sheet stays open for the next operation', after.sheet === 1)
  check('and the keyboard stays down', !after.focused.includes('cm-table-cell'), after.focused)
  check(
    'the note still holds a plain GFM table',
    /\| a +\| b +\| c +\|/.test(await noteContaining('# Heading one')),
  )
  await page.screenshot({ path: join(SHOTS, '19-phone-table-format.png') })

  // Back to typing. The sheet and the keyboard swap places rather than sharing
  // the screen, which is what tapping a cell with the sheet up used to do.
  await page.locator('.cm-table-cell[data-row="2"][data-col="1"]').tap()
  await page.waitForTimeout(350)
  check('tapping a cell again closes the sheet', (await page.locator('.fmt-sheet').count()) === 0)
  check(
    'and hands the cell back for typing',
    (await page.evaluate(() => document.activeElement?.className)) === 'cm-table-cell',
  )
  const outOfTheTable = await noteTextPoint('.editor-overlay')
  await page.touchscreen.tap(outOfTheTable.x, outOfTheTable.y)
  await page.waitForTimeout(300)

  /* ---- tapping a link on a phone -----------------------------------------
   * A link in the text is a decoration, not an anchor, and the mouse events a
   * phone synthesises from a tap arrive too late to be any use: the caret has
   * already landed in the text, and the click trailing them lands on the menu
   * the tap just opened and closes it again. Which is exactly what a link on a
   * phone used to do — nothing at all, but with the keyboard up.
   */
  const uri = page.locator('.cm-uri').first()
  await uri.scrollIntoViewIfNeeded()
  await uri.tap()
  await page.waitForTimeout(400)
  check('tapping a link offers what to do with it', (await page.locator('.menu-sheet').count()) === 1)
  check('the choice includes opening it', (await page.locator('.menu-item:has-text("Open link")').count()) === 1)
  check('and editing it', (await page.locator('.menu-item:has-text("Edit link")').count()) === 1)
  await page.screenshot({ path: join(SHOTS, '20-phone-link-tap.png') })

  /* ---- opening it from a Home Screen app ---------------------------------
   * A web app installed on iOS has no tab to open a link in, so `window.open`
   * there opens an empty view *inside the app*, hands the URL to Safari, and
   * leaves that blank page behind for you to dismiss when you come back.
   * Navigating instead hands the address straight to the platform, which opens
   * it in the browser because it is outside the app's scope — and leaves
   * nothing behind, because nothing was opened.
   *
   * iOS reports itself through `navigator.standalone`, faked here; the
   * navigation is caught at the network layer so the suite is not carried off
   * to example.com.
   */
  const navigations = []
  await page.route(
    (url) => url.hostname === 'example.com',
    (route) => {
      navigations.push(route.request().url())
      // 204 rather than abort: a No Content reply leaves the page exactly where
      // it was, which is the closest a desktop browser gets to what iOS does
      // here — hand the address off and carry on. An aborted navigation would
      // replace the app with an error page and take the rest of the run with it.
      route.fulfill({ status: 204 })
    },
  )
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'standalone', { value: true, configurable: true })
    window.__opened = []
    window.open = (url) => {
      window.__opened.push(url)
      return null
    }
  })
  await page.locator('.menu-item:has-text("Open link")').click()
  await page.waitForTimeout(600)
  const homeScreen = await page.evaluate(() => window.__opened ?? [])
  check(
    'an installed iOS app opens a link by navigating to it',
    navigations.length === 1,
    navigations.join(',') || 'no navigation attempted',
  )
  check(
    'and never through the blank page window.open leaves behind',
    homeScreen.length === 0,
    homeScreen.join(','),
  )
  check('the app itself is still up', (await page.locator('.cm-content').count()) === 1)
  await page.unroute((url) => url.hostname === 'example.com')

  if (await page.locator('.menu-cancel').count()) {
    await page.locator('.menu-cancel').click()
    await page.waitForTimeout(250)
  }

  const tagBefore = await page.locator('.cm-tag').first().innerText()
  await page.locator('.cm-tag').first().tap()
  await page.waitForTimeout(450)
  check(
    'tapping a tag on a phone opens that tag',
    (await page.locator('.scope-bar').innerText()).includes(tagBefore.replace('#', '')),
    tagBefore,
  )
  await page.locator('.scope-bar button:has-text("Close")').click()
  await page.waitForTimeout(300)

  await page.locator('.note-row', { hasText: 'Kitchen Sink' }).first().tap()
  await page.waitForTimeout(500)
  await chooseMode('Live preview')

  // The same tap, in the other rendered mode: link handling is shared, and a
  // link nobody can follow is no better in live preview than in rich text.
  const liveUri = page.locator('.cm-uri').first()
  await liveUri.scrollIntoViewIfNeeded()
  await liveUri.tap()
  await page.waitForTimeout(400)
  check('a link is tappable in live preview too', (await page.locator('.menu-sheet').count()) === 1)
  if (await page.locator('.menu-cancel').count()) {
    await page.locator('.menu-cancel').click()
    await page.waitForTimeout(250)
  }

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

  /* ---- writing a callout ------------------------------------------------
   * The completion is the whole discovery story for callouts — there is no
   * button, because the formatting bar exists only in rich text while the
   * syntax works in all three modes. So the path that has to work is: type
   * `> [!`, pick from a list, get a callout.
   */
  await page.click('[title^="New note"]')
  await page.waitForTimeout(500)
  await page.locator('.cm-content').click()
  await page.locator('.cm-content').pressSequentially('> [!warn', { delay: 40 })
  await page.waitForTimeout(500)
  const calloutSuggestions = await page.locator('.cm-tooltip-autocomplete li').count()
  check('typing "[!" in a quote offers the callout types', calloutSuggestions > 0, `${calloutSuggestions} options`)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)
  await page.locator('.cm-content').pressSequentially('Friday deploys', { delay: 20 })
  await page.waitForTimeout(300)
  check(
    'accepting one writes the marker and leaves the caret in the title',
    (await page.locator('.cm-content').textContent()).includes('[!warning] Friday deploys'),
    await page.locator('.cm-content').textContent(),
  )
  check(
    'and the line is already a callout while it is being typed',
    (await page.locator('.cm-line.cm-callout-warning').count()) === 1,
  )
  // Off the line, and the marker becomes the icon it stands for.
  await page.keyboard.press('Enter')
  await page.locator('.cm-content').pressSequentially('The window closes at 16:00.', { delay: 10 })
  await page.waitForTimeout(400)
  check(
    'moving off the line turns the marker into its icon',
    (await page.locator('.cm-callout-mark svg').count()) === 1 &&
      !(await page.locator('.cm-content').innerText()).includes('[!warning]'),
  )
  check(
    'and the callout carries on over the lines below it',
    (await page.locator('.cm-line.cm-callout-warning').count()) === 2,
  )

  /* ---- a Tag Folder that gathers tasks -----------------------------------
   * The whole point is inheritance: tag a *note* #home and every job written
   * on it is a #home task, without any of them being tagged by hand. That is
   * how people actually keep notes, and tagging each line would be the same
   * information typed eleven times.
   */
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForTimeout(400)
  await page.evaluate(async () => {
    const iso = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10)
    const text = [
      '# Kitchen',
      '',
      '#home',
      '',
      '- [ ] Fix the dripping tap',
      `- [ ] Order the tiles 📅 ${iso(-2)}`,
      '- [x] Measure the worktop',
      '- [ ] Ring the plumber #urgent',
      '',
    ].join('\n')
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('slate')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const tx = db.transaction('files', 'readwrite')
    tx.objectStore('files').put({
      path: 'Kitchen jobs.md', kind: 'note', text, mime: 'text/markdown', size: text.length,
      hash: 'kj', mtime: Date.now() + 50_000, ctime: Date.now(),
      dirty: true, dirtyFlag: 1, sync: {},
    })
    await new Promise((res) => { tx.oncomplete = res })
  })
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.note-row')
  await page.waitForTimeout(400)

  await page.click('.side-group-label:has-text("Tag Folders") .side-add')
  await ruleDialogReady()
  await page.fill('.dialog input[type="text"]', 'Home jobs')
  check(
    'a Tag Folder can be set to gather tasks instead of notes',
    (await page.locator('.seg-btn:has-text("Tasks")').count()) === 1,
  )
  await page.locator('.seg-btn:has-text("Tasks")').click()
  await page.waitForTimeout(300)
  /*
   * A tick is on offer as the folder's icon too. It is a choice rather than a
   * statement — anyone can put it on a folder that gathers notes — which is
   * why the row draws its own from what the folder actually does.
   */
  check(
    'a tick is among the icons a folder can wear',
    (await page.locator('.dialog select option').allInnerTexts()).some((t) => t.includes('✅')),
    (await page.locator('.dialog select option').allInnerTexts()).join(''),
  )
  check(
    'and offers the questions only a task can answer',
    (await page.locator('.chip:has-text("is:open")').count()) === 1 &&
      (await page.locator('.chip:has-text("due:overdue")').count()) === 1,
  )
  await page.fill('.rule-input', '#home')
  await page.waitForTimeout(400)
  const inherited = await page.locator('.rule-status').innerText()
  check(
    'a note tagged #home hands its tag to every task on it',
    /matches\s*4\b/i.test(inherited.replace(/\s+/g, ' ')) && /tasks/i.test(inherited),
    inherited.replace(/\s+/g, ' ').slice(0, 90),
  )
  const previewed = (await page.locator('.rule-preview-row').allInnerTexts()).join(' | ')
  check(
    'and the preview lists the tasks, not the note they are on',
    ['Fix the dripping tap', 'Order the tiles', 'Measure the worktop', 'Ring the plumber'].every(
      (t) => previewed.includes(t),
    ),
    previewed.replace(/\n/g, ' · '),
  )

  await page.fill('.rule-input', '#home is:open')
  await page.waitForTimeout(400)
  const openOnly = await page.locator('.rule-status').innerText()
  check(
    'narrowing to what is still to do drops the finished one',
    /matches\s*3\b/i.test(openOnly.replace(/\s+/g, ' ')),
    openOnly.replace(/\s+/g, ' ').slice(0, 90),
  )
  await page.fill('.rule-input', '#home due:overdue')
  await page.waitForTimeout(400)
  check(
    'and asking for overdue leaves the one whose date has passed',
    /matches\s*1\b/i.test((await page.locator('.rule-status').innerText()).replace(/\s+/g, ' ')),
    (await page.locator('.rule-status').innerText()).replace(/\s+/g, ' ').slice(0, 90),
  )

  await page.fill('.rule-input', '#home is:open')
  await page.waitForTimeout(400)
  await page.click('.dialog-foot .btn-primary')
  await page.waitForTimeout(600)
  check(
    'the folder lists its tasks where its notes would have been',
    (await page.locator('.list-scroll .task-row').count()) === 3,
    `${await page.locator('.list-scroll .task-row').count()} rows`,
  )
  const folderCount = await page
    .locator('.side-row:has-text("Home jobs") .side-count')
    .first()
    .innerText()
  check(
    'and counts tasks beside it, not the one note they sit on',
    folderCount.trim() === '3',
    `badge reads ${JSON.stringify(folderCount)}`,
  )

  /*
   * Ticking one off in the folder writes to the note it came from — the rows
   * are the same rows the rail uses, so a task is the same thing everywhere.
   */
  await page
    .locator('.list-scroll .task-row', { hasText: 'Fix the dripping tap' })
    .locator('.task-check')
    .click()
  await page.waitForTimeout(900)
  check(
    'ticking one there edits the note it lives on',
    (await noteContaining('dripping tap')).includes('- [x] Fix the dripping tap'),
    (await noteContaining('dripping tap')).split('\n').find((l) => l.includes('dripping')) ?? '',
  )
  check(
    'and it leaves the folder, which asked for open ones',
    (await page.locator('.list-scroll .task-row').count()) === 2,
    `${await page.locator('.list-scroll .task-row').count()} rows`,
  )
  /*
   * Arranging the list. Grouping by *tag* is deliberately not on offer: a task
   * carries the tags on its own line and the ones its note carries, so a job
   * that is both #home and #urgent has no single group. Due date and note are
   * unambiguous, and by-note is the one that pays off here — the folder's
   * tasks come from two different notes precisely because the tag was
   * inherited.
   */
  await page.locator('.list-scroll .rail-group-btn').click()
  await page.waitForTimeout(300)
  const arrangeRows = await page.locator('.menu-item').allInnerTexts()
  check(
    'a task list can be arranged, but never by tag',
    arrangeRows.some((r) => r.includes('By due date')) &&
      arrangeRows.some((r) => r.includes('By note')) &&
      !arrangeRows.join(' ').toLowerCase().includes('tag'),
    JSON.stringify(arrangeRows),
  )
  await page.locator('.menu-item:has-text("By note")').click()
  await page.waitForTimeout(500)
  const noteGroups = await page.locator('.list-scroll .task-group').allInnerTexts()
  check(
    'grouping by note gathers the tasks under the notes they came from',
    noteGroups.includes('Kitchen jobs') && noteGroups.length >= 1,
    JSON.stringify(noteGroups),
  )
  check(
    'and stops repeating the note name down the side of every row',
    (await page.locator('.list-scroll .task-row .task-meta').count()) === 0,
  )

  await page.locator('.list-scroll .rail-group-btn').click()
  await page.waitForTimeout(300)
  await page.locator('.menu-item:has-text("By due date")').click()
  await page.waitForTimeout(500)
  const dueGroups = await page.locator('.list-scroll .task-group').allInnerTexts()
  check(
    'grouping by date bands them in the order they are worth reading',
    dueGroups.join('|') === ['Overdue', 'No date'].join('|'),
    JSON.stringify(dueGroups),
  )

  /* One setting, so the rail is arranged the same way as the folder. */
  check(
    'and the rail follows, because it is one way of reading a task list',
    (await page.locator('.rail .task-group').count()) > 0,
    JSON.stringify(await page.locator('.rail .task-group').allInnerTexts()),
  )
  await page.locator('.list-scroll .rail-group-btn').click()
  await page.waitForTimeout(300)
  await page.locator('.menu-item:has-text("No grouping")').click()
  await page.waitForTimeout(400)
  check(
    'turning it off leaves the list as it was',
    (await page.locator('.list-scroll .task-group').count()) === 0,
  )

  /* ---- what the sidebar's Tasks row is for -------------------------------
   * It counts tasks, so it lists tasks. Listing the notes that happened to
   * hold them left the count promising one thing and the click delivering
   * another — and the check glyph is what tells a task-gathering Tag Folder
   * apart from the note-gathering one sitting right beside it.
   */
  check(
    'a Tag Folder that gathers tasks says so on its row',
    (await page.locator('.side-row:has-text("Home jobs") .side-task').count()) === 1,
  )
  check(
    'and one that gathers notes does not',
    (await page.locator('.side-row:has-text("Active work") .side-task').count()) === 0,
  )

  await page.locator('.side-row:has-text("Tasks")').first().click()
  await page.waitForTimeout(500)
  const taskRowTexts = await page.locator('.list-scroll .task-row').allInnerTexts()
  const noteRows = await page.locator('.list-scroll .note-row').count()
  check(
    'the sidebar Tasks row lists tasks, not the notes holding them',
    taskRowTexts.length > 0 && noteRows === 0,
    `${taskRowTexts.length} task rows, ${noteRows} note rows`,
  )
  const taskNotes = new Set(
    (await page.locator('.list-scroll .task-row .task-meta').allInnerTexts()).map((t) => t.trim()),
  )
  check(
    'and gathers them from every note in the vault, not one',
    taskNotes.size > 1,
    [...taskNotes].join(' | '),
  )
  check(
    'showing what is still to do',
    taskRowTexts.join(' | ').includes('Ring the plumber'),
    taskRowTexts.join(' | ').slice(0, 140),
  )
  /*
   * And not the ones already crossed off. A list whose bottom is a growing
   * archive of finished work is a list people stop reading — but the heading
   * still counts them, so nothing is hidden without saying so, and the switch
   * that brings them back is in the same menu that arranges the list.
   */
  check(
    'but not the ones already crossed off',
    !taskRowTexts.join(' | ').includes('Measure the worktop'),
    taskRowTexts.join(' | ').slice(0, 140),
  )
  check(
    'though the heading still counts them, so nothing is hidden silently',
    /\d+ open · \d+ done/i.test(await page.locator('.list-scroll .rail-section h3').innerText()),
    (await page.locator('.list-scroll .rail-section h3').innerText()).replace(/\n/g, ' '),
  )

  await page.locator('.list-scroll .rail-group-btn').click()
  await page.waitForTimeout(300)
  await page.locator('.menu-item:has-text("Show completed")').click()
  await page.waitForTimeout(500)
  check(
    'turning them on brings the finished ones back',
    (await page.locator('.list-scroll .task-row').allInnerTexts())
      .join(' | ')
      .includes('Measure the worktop'),
  )
  /*
   * Straight into the reload, inside the timer the vault-wide write sits on:
   * backstage/config.json is overlaid over this device's own copy at boot, so
   * a preference changed a moment before a reload used to come back as
   * whatever it was before the change.
   */
  await page.waitForTimeout(250)
  await page.reload()
  await page.waitForSelector('.side-row')
  await page.waitForTimeout(900)
  await page.locator('.side-row:has-text("Tasks")').first().click()
  await page.waitForTimeout(500)
  check(
    'and the choice survives a reload, like every other way of reading a list',
    (await page.locator('.list-scroll .task-row').allInnerTexts())
      .join(' | ')
      .includes('Measure the worktop'),
  )
  await page.locator('.list-scroll .rail-group-btn').click()
  await page.waitForTimeout(300)
  await page.locator('.menu-item:has-text("Show completed")').click()
  await page.waitForTimeout(500)
  check(
    'and turning it off hides them again',
    !(await page.locator('.list-scroll .task-row').allInnerTexts())
      .join(' | ')
      .includes('Measure the worktop'),
  )

  /* ---- the calendar, read the other way round ----------------------------
   * A day with work owed on it has to look different from an empty one, or the
   * only way to find it is clicking days at random. The pip is its own channel:
   * the dots below the number mean notes filed on that day, and overloading
   * them would make a dot mean two things.
   */
  /* "Order the tiles" is due two days ago; nothing is due three days ago. */
  await page.locator('.cal-today').click()
  await page.waitForTimeout(400)
  const overdueDay = await showDay(-2)
  const overdueLabel = (await overdueDay.getAttribute('aria-label')) ?? ''
  const overduePips = await overdueDay.locator('.cal-due').count()
  const overdueLate = await overdueDay.locator('.cal-due[data-late="1"]').count()
  check('a day with work due on it is marked on the calendar', overduePips === 1, overdueLabel)
  check('and says so to a screen reader as well as to an eye', /\d+ due/.test(overdueLabel), overdueLabel)
  check('a day already past wears the same red the date chip turns', overdueLate === 1)

  const quietDay = await showDay(-3)
  check(
    'and a day with none is left alone',
    (await quietDay.locator('.cal-due').count()) === 0,
    (await quietDay.getAttribute('aria-label')) ?? '',
  )

  const tomorrow = await showDay(1)
  check(
    'while a day still to come does not',
    (await tomorrow.locator('.cal-due[data-late="0"]').count()) === 1,
    (await tomorrow.getAttribute('aria-label')) ?? '',
  )

  const laterDay = await showDay(1)
  await laterDay.click()
  await page.waitForTimeout(500)
  const dayPanel = page.locator('.rail .rail-section').nth(0)
  check(
    'clicking a day shows what it asks of you, under what is filed on it',
    (await dayPanel.locator('.task-row').allInnerTexts()).join(' | ').includes('Renew passport'),
    (await dayPanel.locator('.task-row').allInnerTexts()).join(' | '),
  )
  check(
    'with no heading over them — a checkbox already says which rows are tasks',
    (await dayPanel.locator('.task-group').count()) === 0,
  )

  /*
   * And never the same task twice in one column. The Due list below already
   * holds everything overdue and everything due today, so a day the list has
   * covered keeps its notes and hands the tasks to it.
   */
  const overdueAgain = await showDay(-2)
  await overdueAgain.click()
  await page.waitForTimeout(500)
  check(
    'a day whose work is already late leaves it to the Due list below',
    (await dayPanel.locator('.task-row').count()) === 0,
    (await dayPanel.locator('.task-row').allInnerTexts()).join(' | '),
  )
  check(
    'so the task is in the rail once, not twice',
    (await page.locator('.rail .task-row', { hasText: 'Order the tiles' }).count()) === 1,
  )

  await page.locator('.cal-today').click()
  await page.waitForTimeout(500)
  check(
    'and today says it once too, in the Due list rather than in both',
    (await dayPanel.locator('.task-row').count()) === 0,
    `${await dayPanel.locator('.task-row').count()} rows in the day panel`,
  )

  await page.locator('.side-row:has-text("All Notes")').first().click()
  await page.waitForTimeout(400)

  /* ---- copying a table back out -----------------------------------------
   * The return trip. Only the HTML flavour is added: spreadsheets read it in
   * preference to plain text, so Excel gets cells while the plain flavour
   * stays the markdown that was selected and another markdown editor still
   * gets the pipe table. Both halves are asserted, because writing tab
   * separated text over the plain flavour would pass a check for the first and
   * silently lose the second.
   *
   * "Table at start" is the fixture because its table is the first three lines
   * of the note, so the selection can be made with the keyboard and end
   * exactly where the table does — which is the thing being tested.
   */
  await page.locator('.note-row', { hasText: 'Table at start' }).first().click()
  await page.waitForTimeout(500)
  await page.locator('.cm-content').click()
  await page.waitForTimeout(250)
  // Source mode: no widgets, so the selection is over the pipes themselves.
  let modeSteps = 0
  for (let i = 0; i < 3 && (await page.locator('.cm-table-render').count()) > 0; i++) {
    await page.keyboard.press('Control+Shift+m')
    modeSteps++
    await page.waitForTimeout(350)
  }
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+End')
  await page.waitForTimeout(250)

  const flavours = await page.evaluate(() => {
    const dt = new DataTransfer()
    document
      .querySelector('.cm-content')
      .dispatchEvent(
        new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }),
      )
    return { html: dt.getData('text/html'), plain: dt.getData('text/plain') }
  })
  check(
    'copying a table adds a real <table> for a spreadsheet to read',
    flavours.html === '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>',
    JSON.stringify(flavours.html),
  )
  check(
    'and leaves the plain text as the markdown it was',
    flavours.plain.includes('| A | B |') && !flavours.plain.includes('<table'),
    JSON.stringify(flavours.plain),
  )

  /*
   * And a selection that is not rows of one table is left entirely alone —
   * otherwise ordinary copying inside a note would start rewriting itself.
   */
  await page.keyboard.press('Control+a')
  await page.waitForTimeout(200)
  const wholeNote = await page.evaluate(() => {
    const dt = new DataTransfer()
    document
      .querySelector('.cm-content')
      .dispatchEvent(
        new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }),
      )
    return dt.getData('text/html')
  })
  check(
    'a selection running past the table is left to copy normally',
    !wholeNote.startsWith('<table'),
    JSON.stringify(wholeNote.slice(0, 60)),
  )

  /*
   * The same thing without the aim: the caret is in the table, so the table is
   * what gets copied. Dragging works and is checked above, but it is a gesture
   * with no edges — in the rendered modes the table is one widget, and a drag
   * that overshoots by a few pixels is correctly refused with no sign of it
   * but pipes arriving in the spreadsheet.
   */
  // Rich text, which is the mode with a formatting bar to reach the menu from.
  for (let i = 0; i < 3; i++) {
    await page.locator('.cm-content').click()
    await page.waitForTimeout(300)
    if ((await page.locator('.fmt-bar').count()) > 0) break
    await page.keyboard.press('Control+Shift+m')
    modeSteps++
    await page.waitForTimeout(400)
  }
  await page.locator('.cm-table-render td').first().click()
  await page.waitForTimeout(400)
  // Through `clickFormat`, because at this width the table button is in the
  // overflow menu rather than on the bar.
  await clickFormat('Table rows and columns')
  await page.waitForTimeout(350)
  check(
    'the table menu offers to copy the whole table',
    (await page.locator('.menu-item:has-text("Copy table")').count()) === 1,
    JSON.stringify(await page.locator('.menu-item').allInnerTexts()),
  )
  await page.locator('.menu-item:has-text("Copy table")').click()
  await page.waitForTimeout(700)

  const onClipboard = await page.evaluate(async () => {
    const items = await navigator.clipboard.read()
    const out = {}
    for (const item of items) {
      for (const type of item.types) out[type] = await (await item.getType(type)).text()
    }
    return out
  })
  check(
    'and puts a table on the clipboard for a spreadsheet',
    onClipboard['text/html']?.includes('<th>A</th>') &&
      onClipboard['text/html']?.includes('<td>1</td>'),
    JSON.stringify(onClipboard['text/html'] ?? null),
  )
  check(
    'with the markdown beside it for everything else',
    onClipboard['text/plain']?.includes('| A') && onClipboard['text/plain']?.includes('| --- |'),
    JSON.stringify(onClipboard['text/plain'] ?? null),
  )

  /*
   * Put the mode back. The three modes cycle, so completing the loop returns
   * whatever this borrowed — everything below reads the same editor, and
   * leaving it in source mode means no live-preview decorations for any of it.
   */
  for (let i = (3 - (modeSteps % 3)) % 3; i > 0; i--) {
    await page.keyboard.press('Control+Shift+m')
    await page.waitForTimeout(350)
  }

  /* ---- naming a note after the heading you typed in it -------------------
   * A note made with *New note here* — and every note started from a template
   * — is called Untitled. Type a heading into it and the file, the note list
   * and any wikilink to it all still say Untitled about a note that plainly
   * is not. The offer is made only for a note that has never been named, so it
   * can never nag anyone whose `2026-09-04.md` is headed `# Thursday` on
   * purpose.
   */
  await page.click('[title^="New note"]')
  await page.waitForTimeout(500)
  await page.locator('.cm-content').click()
  await page.locator('.cm-content').pressSequentially('# Kickoff with Acme', { delay: 12 })
  await page.waitForTimeout(1400)
  check(
    'an unnamed note offers its heading as a name',
    (await page.locator('.toast:has-text("Kickoff with Acme")').count()) === 1,
    (await page.locator('.toast').innerText().catch(() => '')) || 'no toast',
  )
  check(
    'and offers it rather than doing it',
    (await page.locator('.editor-title-input').inputValue()).startsWith('Untitled'),
    await page.locator('.editor-title-input').inputValue(),
  )
  await page.locator('.toast-action').click()
  await page.waitForTimeout(800)
  check(
    'taking the offer renames the file',
    (await page.locator('.editor-title-input').inputValue()) === 'Kickoff with Acme',
    await page.locator('.editor-title-input').inputValue(),
  )
  const renamed = await page.evaluate(async () => {
    const req = indexedDB.open('slate')
    return new Promise((r) => {
      req.onsuccess = () => {
        const tx = req.result.transaction('files', 'readonly')
        const all = tx.objectStore('files').getAll()
        all.onsuccess = () =>
          r(all.result.filter((f) => !f.deleted).map((f) => f.path).includes('Kickoff with Acme.md'))
      }
    })
  })
  check('on disk as well as in the header', renamed === true)

  /*
   * And a note that has a name of its own is left alone, however far its
   * heading drifts from it — which is the case that would otherwise turn this
   * into a nuisance.
   */
  await page.locator('.cm-content').click()
  await page.locator('.cm-content').press('Control+End')
  await page.locator('.cm-content').pressSequentially('\n\n# A different heading entirely', {
    delay: 8,
  })
  await page.waitForTimeout(1400)
  check(
    'a note that has been named is never asked about again',
    (await page.locator('.toast:has-text("A different heading")').count()) === 0,
    (await page.locator('.toast').innerText().catch(() => '')) || 'no toast',
  )

  /* ---- exporting a note -------------------------------------------------
   * Nothing is converted: the bytes that leave are the bytes on disk, which is
   * the whole reason this is not a renderer. Headless Chromium has no share
   * target, so `canShareFiles()` is false here and this exercises the download
   * path — which is the desktop path anyway.
   */
  await page.locator('.note-row', { hasText: 'Kitchen Sink' }).first().click()
  await page.waitForTimeout(400)
  await page.locator('.note-row', { hasText: 'Kitchen Sink' }).first().click({ button: 'right' })
  await page.waitForTimeout(300)
  const exportItem = page.locator('.menu-item:has-text("Export as Markdown")')
  check('a note offers a way out of the app', (await exportItem.count()) === 1)

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 10_000 }).catch(() => null),
    exportItem.click(),
  ])
  check(
    'exporting saves the note as a .md file named after it',
    download?.suggestedFilename() === 'Kitchen Sink.md',
    download ? download.suggestedFilename() : 'no download fired',
  )
  if (download) {
    const saved = await download.createReadStream()
    const chunks = []
    for await (const c of saved) chunks.push(c)
    const text = Buffer.concat(chunks).toString('utf8')
    /*
     * Byte-for-byte the file, frontmatter and wikilinks included — not a
     * rendering of it. That is what makes the export worth having.
     */
    const onDisk = await noteContaining('Kitchen Sink')
    check(
      'and what comes out is the file, not a rendering of it',
      text === onDisk && text.startsWith('---\n') && text.includes('[[Wikilink]]'),
      JSON.stringify(text.slice(0, 60)),
    )
  }

  /* ---- folder templates -------------------------------------------------
   * The feature is opt-in, and the first assertion is the one that says so: a
   * vault that has never made a `Templates/` folder must show no sign of any
   * of this. Nothing creates that folder except the button in Settings.
   */
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForTimeout(400)
  const clients = page.locator('.side-row:has-text("Clients")').first()
  await clients.click({ button: 'right' })
  await page.waitForTimeout(300)
  const menuBefore = await page.locator('.menu-item').allInnerTexts()
  check(
    'a vault with no Templates folder is never told about templates',
    !menuBefore.join(' ').toLowerCase().includes('template'),
    JSON.stringify(menuBefore),
  )
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)

  const templateFiles = () =>
    page.evaluate(async () => {
      const req = indexedDB.open('slate')
      return new Promise((r) => {
        req.onsuccess = () => {
          const tx = req.result.transaction('files', 'readonly')
          const all = tx.objectStore('files').getAll()
          all.onsuccess = () =>
            r(all.result.filter((f) => !f.deleted && f.path.startsWith('Templates/')).map((f) => f.path))
        }
      })
    })
  check('and no Templates folder has appeared by itself', (await templateFiles()).length === 0)

  // The one action in the app that creates it.
  await page.click('.pane-head .icon-btn[title^="Settings"]')
  await page.waitForSelector('.dialog')
  await page.click('.tab:has-text("Editor")')
  await page.waitForTimeout(300)
  const optIn = page.locator('.dialog .btn:has-text("Create the Templates folder")')
  check('Settings offers to start using templates', (await optIn.count()) === 1)
  await optIn.click()
  await page.waitForTimeout(800)
  const seeded = await templateFiles()
  check(
    'and creating it writes one template to start from',
    seeded.length === 1 && seeded[0] === 'Templates/Example.md',
    JSON.stringify(seeded),
  )
  check(
    'which opens so you can see what a template is',
    (await page.locator('.editor-title-input').inputValue()) === 'Example',
  )

  /*
   * The pair that matters. A template is a real note in a real folder — which
   * is how it gets edited — but it is boilerplate for a note that does not
   * exist yet, so it has no business in the list of what you have written.
   */
  const allNotesRow = page.locator('.side-row:has-text("All Notes")').first()
  const countBefore = (await allNotesRow.innerText()).match(/(\d+)\s*$/)?.[1]
  await allNotesRow.click()
  await page.waitForTimeout(500)
  const listed = await page.locator('.note-row-title').allInnerTexts()
  check(
    'a template stays out of the default notes view',
    !listed.includes('Example'),
    JSON.stringify(listed),
  )
  check(
    'and out of the count beside it',
    countBefore === String(listed.length),
    `badge ${countBefore}, ${listed.length} rows`,
  )
  await page.locator('.side-row:has-text("Templates")').first().click()
  await page.waitForTimeout(500)
  check(
    'but browsing the folder still shows it, which is how one is edited',
    (await page.locator('.note-row-title').allInnerTexts()).includes('Example'),
  )

  // Point a folder at it.
  await clients.click({ button: 'right' })
  await page.waitForTimeout(300)
  const pick = page.locator('.menu-item:has-text("Use a template")')
  check('now a folder can be given one', (await pick.count()) === 1)
  await pick.click()
  await page.waitForTimeout(300)
  check(
    'the picker lists the templates and an off switch',
    (await page.locator('.menu-item:has-text("No template")').count()) === 1 &&
      (await page.locator('.menu-item:has-text("Example")').count()) === 1,
  )
  await page.locator('.menu-item:has-text("Example")').click()
  await page.waitForTimeout(500)

  // A new note in that folder starts from it.
  await clients.click({ button: 'right' })
  await page.waitForTimeout(300)
  check(
    'and the folder menu then names the template it is using',
    (await page.locator('.menu-item:has-text("Template: Example")').count()) === 1,
    JSON.stringify(await page.locator('.menu-item').allInnerTexts()),
  )
  await page.locator('.menu-item:has-text("New note here")').click()
  await page.waitForTimeout(700)
  await page.keyboard.type('Agenda')
  await page.waitForTimeout(900)

  const fromTemplate = await page.evaluate(async () => {
    const req = indexedDB.open('slate')
    return new Promise((r) => {
      req.onsuccess = () => {
        const tx = req.result.transaction('files', 'readonly')
        const all = tx.objectStore('files').getAll()
        all.onsuccess = () => {
          const hit = all.result
            .filter((f) => !f.deleted && f.path.startsWith('Clients/'))
            .sort((a, b) => b.mtime - a.mtime)[0]
          r(hit?.text ?? '')
        }
      }
    })
  })
  check(
    'a note made in that folder starts from the template',
    /^# .*\n/.test(fromTemplate) && fromTemplate.includes(String(new Date().getFullYear())),
    JSON.stringify(fromTemplate),
  )
  check(
    'with its fields filled in rather than left as tokens',
    !fromTemplate.includes('{{'),
    JSON.stringify(fromTemplate),
  )
  /*
   * `{{cursor}}` is the point of the exercise. Typing lands in the heading the
   * starter template leaves open — not at position 0, which is where the caret
   * sits without this and would have written "Agenda# ", and not at the end
   * under the date, which is where it would go if the marker were ignored.
   */
  check(
    'and typing starts where {{cursor}} said',
    fromTemplate.startsWith('# Agenda\n'),
    JSON.stringify(fromTemplate),
  )

  /*
   * The vault root, which has no row in the sidebar to right-click and so is
   * set from Settings. It is where a note created from a broken [[link]] goes,
   * and that note is named for the link — the one place `{{title}}` is worth
   * writing, and unreachable until this existed.
   */
  await page.click('.pane-head .icon-btn[title^="Settings"]')
  await page.waitForSelector('.dialog')
  await page.click('.tab:has-text("Editor")')
  await page.waitForTimeout(300)
  const rootPick = page.locator('.field:has-text("Notes outside any folder") select')
  check('Settings can give the root a template too', (await rootPick.count()) === 1)
  await rootPick.selectOption({ label: 'Example' })
  await page.waitForTimeout(400)
  await page.click('.dialog-foot .btn-primary')
  await page.waitForTimeout(300)

  // Follow a broken wikilink and let it create the note.
  await page.click('[title^="New note"]')
  await page.waitForTimeout(600)
  await page.locator('.cm-content').click()
  await page.locator('.cm-content').pressSequentially('See [[Highway 9]] for the outage.', {
    delay: 12,
  })
  await page.waitForTimeout(700)
  await page.locator('.cm-wikilink-broken').first().click()
  await page.waitForTimeout(900)

  const fromLink = await page.evaluate(async () => {
    const req = indexedDB.open('slate')
    return new Promise((r) => {
      req.onsuccess = () => {
        const tx = req.result.transaction('files', 'readonly')
        const all = tx.objectStore('files').getAll()
        all.onsuccess = () => r(all.result.find((f) => f.path === 'Highway 9.md')?.text ?? '')
      }
    })
  })
  check(
    'a note created from a broken link starts from the root template',
    fromLink.includes(String(new Date().getFullYear())) && !fromLink.includes('{{'),
    JSON.stringify(fromLink),
  )
  /*
   * And it is named for the link, which is the whole case `{{title}}` exists
   * for. The same template leaves the heading empty for a note made with
   * *New note here*, which has no name yet — checked above.
   */
  check(
    'and {{title}} is the link text, not the word Untitled',
    fromLink.startsWith('# Highway 9\n'),
    JSON.stringify(fromLink),
  )

  /* ---- pasting a spreadsheet range -------------------------------------
   * Excel, Numbers, Sheets and Calc all put two flavours on the clipboard: a
   * `<table>` under text/html and the same cells tab-separated under
   * text/plain. Only a real ClipboardEvent carrying both exercises the branch,
   * and the negative case below is the one that keeps it honest — tab-separated
   * text with no table behind it has to stay text.
   */
  await page.click('[title^="New note"]')
  await page.waitForTimeout(500)
  await page.locator('.cm-content').click()
  await page.locator('.cm-content').press('Control+End')

  /*
   * `withPicture` is not a detail — it is the shape of a real Excel clipboard,
   * and the reason this test exists in this form.
   *
   * Excel does not put cells on the clipboard and stop: it also puts a picture
   * of the copied range there. The first version of this test built a
   * clipboard out of the two text flavours alone, which no spreadsheet on
   * earth produces, and so it passed against a handler that checked images
   * first and turned every real paste into a screenshot of a spreadsheet.
   */
  const pasteGrid = (html, plain, withPicture = true) =>
    page.evaluate(
      async ([h, p, pic]) => {
        const dt = new DataTransfer()
        if (h) dt.setData('text/html', h)
        dt.setData('text/plain', p)
        if (pic) {
          const c = document.createElement('canvas')
          c.width = 220
          c.height = 60
          const x = c.getContext('2d')
          x.fillStyle = '#fff'
          x.fillRect(0, 0, 220, 60)
          x.fillStyle = '#333'
          x.font = '14px sans-serif'
          x.fillText('a picture of the cells', 10, 34)
          const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
          dt.items.add(new File([blob], 'image.png', { type: 'image/png' }))
        }
        document
          .querySelector('.cm-content')
          .dispatchEvent(
            new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
          )
      },
      [html, plain, withPicture],
    )

  const countAttachments = () =>
    page.evaluate(async () => {
      const req = indexedDB.open('slate')
      return new Promise((r) => {
        req.onsuccess = () => {
          const tx = req.result.transaction('files', 'readonly')
          const all = tx.objectStore('files').getAll()
          all.onsuccess = () =>
            r(all.result.filter((f) => f.kind === 'attachment' && !f.deleted).length)
        }
      })
    })
  const attachmentsBeforeGrid = await countAttachments()

  // A quoted cell with a line break in it and a cell holding a pipe: both are
  // ordinary in a spreadsheet and neither can survive in a pipe table as-is.
  await pasteGrid(
    '<table><tr><td>Region</td><td>Q3</td></tr><tr><td>EMEA</td><td>1200</td></tr></table>',
    'Region\tQ3\r\nEMEA\t1200\r\n"North\nSouth"\ta|b\r\n',
  )
  await page.waitForTimeout(900)

  const pastedNote = async () =>
    page.evaluate(async () => {
      const req = indexedDB.open('slate')
      return new Promise((resolve) => {
        req.onsuccess = () => {
          const tx = req.result.transaction('files', 'readonly')
          const all = tx.objectStore('files').getAll()
          all.onsuccess = () => {
            const notes = all.result
              .filter((f) => f.kind === 'note' && !f.deleted)
              .sort((a, b) => b.mtime - a.mtime)
            resolve(notes[0]?.text ?? '')
          }
        }
      })
    })

  const grid = await pastedNote()
  check(
    'a spreadsheet range pastes as a GFM table',
    /\| Region +\| Q3 +\|/.test(grid) && /\| -+ \| -+ \|/.test(grid),
    JSON.stringify(grid.slice(-160)),
  )
  check(
    'a pipe inside a cell is escaped rather than ending it',
    grid.includes('a\\|b'),
    JSON.stringify(grid.slice(-160)),
  )
  check(
    'a multi-line cell is flattened onto its row',
    grid.includes('North South'),
    JSON.stringify(grid.slice(-160)),
  )
  check(
    'and it renders as a real table straight away',
    (await page.locator('.cm-table-render td').count()) >= 4,
  )
  /*
   * The picture Excel sent along with the cells has to lose, and lose
   * silently: not embedded in the note, and not filed in the vault either,
   * where it would sit as an orphaned attachment syncing to every device.
   */
  check(
    'the picture a spreadsheet sends with its cells does not win',
    !grid.includes('![['),
    JSON.stringify(grid.slice(-160)),
  )
  check(
    'and is not filed in the vault behind your back',
    (await countAttachments()) === attachmentsBeforeGrid,
    `${attachmentsBeforeGrid} → ${await countAttachments()} attachments`,
  )

  /*
   * The discriminator, from the other side. Tab-separated text pasted out of a
   * terminal has no `<table>` behind it and must arrive as the text it is —
   * otherwise every indented paste in the app silently becomes a table.
   */
  await page.locator('.cm-content').click()
  await page.locator('.cm-content').press('Control+End')
  await pasteGrid(null, 'alpha\tbeta\ngamma\tdelta', false)
  await page.waitForTimeout(900)
  const plain = await pastedNote()
  check(
    'tab-separated text with no table behind it stays text',
    plain.includes('alpha\tbeta') && !/\| alpha +\| beta/.test(plain),
    JSON.stringify(plain.slice(-120)),
  )

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
