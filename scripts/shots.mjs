/**
 * Seeds a realistic vault and captures screenshots in both themes.
 * Run with: node scripts/shots.mjs
 */

import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

const DIST = resolve('dist')
const SHOTS = resolve('screenshots')
const PORT = 4180
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
}

const server = createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`)
  let f = join(DIST, decodeURIComponent(u.pathname))
  if (!existsSync(f) || u.pathname === '/') f = join(DIST, 'index.html')
  try {
    res.writeHead(200, { 'Content-Type': MIME[extname(f)] ?? 'application/octet-stream' })
    res.end(await readFile(f))
  } catch {
    res.writeHead(404).end()
  }
})

const NOTES = [
  ['Work', 'Sprint planning', '# Sprint planning\n\nBacklog groomed. Two spikes carried over.\n\n- [ ] Write the migration note 📅 2026-09-02\n\n#work #active\n'],
  ['Work', 'Retro Q2', '# Retro Q2\n\nWhat went well, what did not.\n\n#work #archived\n'],
  ['', 'Start', `---\npinned: true\n---\n\n# ✳ Start\n\n## Hubs\n\n- [[Finance]]\n- [[Work]]\n- [[People]]\n- [[Lisbon Trip]]\n\n## Open threads\n\n- [ ] Decide on the laundry room window 📅 2026-09-04\n- [ ] Send the Q3 numbers to accounting 📅 2026-09-01\n- [x] Renew the domain\n\nEverything else lives under #home, #work and #travel.\n`],
  ['Work', 'Call with TAC', `# Call with TAC\n\nCircuit is flapping on the west uplink. They want the interface counters before\nthey escalate.\n\n\`\`\`shell\nshow interface gi0/0/1 | include error|drop\n\`\`\`\n\n- [ ] Pull counters and attach them here\n- [ ] Reference the [[Highway 9]] incident notes\n\n#work #network\n`],
  ['Work', 'Highway 9', `# Highway 9\n\nBen's account of the outage. The short version: a backhoe, and no diverse path.\n\n> The second fibre run was ordered in March and never installed.\n\nSee also [[Call with TAC]].\n\n#work\n`],
  ['', 'Lisbon Trip', `---\ndate: 2026-09-12\n---\n\n# Lisbon Trip\n\nFlights are **booked**. Hotel is *pending* — the Alfama place looks right.\n\n| Day | Plan |\n| --- | ---- |\n| Fri | Arrive, Time Out Market |\n| Sat | Belém, then Alfama |\n| Sun | Sintra day trip |\n\n> [!tip] Buy the Sintra train ticket the night before\n> The queue at Rossio is the whole morning otherwise.\n\n- [ ] Book the tram tickets 📅 2026-09-04\n- [ ] Renew passport 📅 2026-08-20\n- [x] Book flights\n\n#travel\n`],
  ['', 'Window Dimensions', `# Window Dimensions\n\nLaundry Room — 27 and 7/8 wide, 36 tall.\nBack bedroom — 31 1/2 wide, 48 tall.\n\n#home\n`],
  ['', 'Finance', `# ✳ Finance\n\nHub note. Links out to the monthly reconciliations.\n\n#finance\n`],
  ['', 'Work', `# ✳ Work\n\n- [[Call with TAC]]\n- [[Highway 9]]\n\n#work\n`],
  ['', 'People', `# ✳ People\n\nOne note per person, tagged #people.\n`],
]

await mkdir(SHOTS, { recursive: true })
await new Promise((r) => server.listen(PORT, r))
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox'],
})

async function shoot(theme) {
  const page = await browser.newPage({
    viewport: { width: 1480, height: 940 },
    colorScheme: theme,
    deviceScaleFactor: 2,
  })
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.shell')

  // Seed straight into IndexedDB and reload. Typing these bodies through the
  // editor would fight the auto-close and autocomplete behaviour that exists
  // for real use, and this is only a screenshot fixture.
  await page.evaluate(async (notes) => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('slate')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const tx = db.transaction('files', 'readwrite')
    const now = Date.now()
    notes.forEach(([folder, title, text], i) => {
      const path = folder ? `${folder}/${title}.md` : `${title}.md`
      tx.objectStore('files').put({
        path,
        kind: 'note',
        text,
        mime: 'text/markdown',
        size: text.length,
        hash: `seed${i}`,
        mtime: now - i * 60_000,
        ctime: now - i * 60_000,
        dirty: true,
        dirtyFlag: 1,
        sync: {},
      })
    })
    await new Promise((res) => {
      tx.oncomplete = res
    })
  }, NOTES)
  // Seed a Tag Folder hierarchy the same way — it lives in backstage/ as an
  // ordinary vault file, so it seeds exactly like a note.
  await page.evaluate(async () => {
    const folders = [
      { id: 'f1', name: 'Work', query: '#work', icon: '💼', createdAt: 1 },
      { id: 'f2', name: 'Active', query: '#active', icon: '⚡️', parentId: 'f1', inherit: true, createdAt: 2 },
      { id: 'f3', name: 'Urgent', query: '#urgent', icon: '🔥', parentId: 'f2', inherit: true, createdAt: 3 },
      { id: 'f4', name: 'Archived', query: '#archived', icon: '🧾', parentId: 'f1', inherit: true, createdAt: 4 },
      { id: 'f5', name: 'Home', query: '#home', icon: '🏠', createdAt: 5 },
    ]
    const text = JSON.stringify(folders, null, 2)
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('slate')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const tx = db.transaction('files', 'readwrite')
    tx.objectStore('files').put({
      path: 'backstage/smart-folders.json',
      kind: 'note',
      text,
      mime: 'application/json',
      size: text.length,
      hash: 'sf',
      mtime: Date.now(),
      ctime: Date.now(),
      dirty: true,
      dirtyFlag: 1,
      sync: {},
    })
    await new Promise((res) => { tx.oncomplete = res })
  })

  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.note-row')

  // Add a pasted screenshot to the trip note so an embed is visible.
  await page.locator('.search-box input').fill('Lisbon')
  await page.waitForTimeout(500)
  await page.locator('.note-row').first().click()
  await page.waitForTimeout(300)
  await page.locator('.search-box input').fill('')
  await page.waitForTimeout(400)
  await page.waitForSelector('.cm-content')
  await page.locator('.cm-content').click()
  await page.locator('.cm-content').press('Control+End')
  await page.evaluate(async () => {
    const c = document.createElement('canvas')
    c.width = 1600
    c.height = 900
    const x = c.getContext('2d')
    const g = x.createLinearGradient(0, 0, 1600, 900)
    g.addColorStop(0, '#2b6cb0')
    g.addColorStop(0.55, '#e0a80d')
    g.addColorStop(1, '#742a2a')
    x.fillStyle = g
    x.fillRect(0, 0, 1600, 900)
    x.fillStyle = 'rgba(255,255,255,.92)'
    x.font = 'bold 78px -apple-system, sans-serif'
    x.fillText('Alfama guesthouse', 90, 430)
    x.font = '42px -apple-system, sans-serif'
    x.fillText('€128 / night · 4 min to the tram', 90, 510)
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
    const dt = new DataTransfer()
    dt.items.add(new File([blob], 'listing.png', { type: 'image/png' }))
    document
      .querySelector('.cm-content')
      .dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  await page.waitForTimeout(2200)
  await page.locator('.cm-content').press('Control+Home')
  await page.waitForTimeout(600)

  await page.screenshot({ path: join(SHOTS, `app-${theme}.png`) })

  await page.setViewportSize({ width: 430, height: 900 })
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(SHOTS, `mobile-${theme}.png`) })
  await page.close()
}

try {
  await shoot('dark')
  await shoot('light')
  console.log('screenshots written to', SHOTS)
} finally {
  await browser.close()
  server.close()
}
