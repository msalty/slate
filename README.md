# Slate

A local-first markdown notes PWA. Apple Notes' layout, Obsidian's linking, plain
`.md` files in a folder you own, and sync that is built to never lose a note.

Runs installed on Windows, macOS, Linux, Android and iOS from one codebase. No
server to run — the app is static files; your notes live on your WebDAV server or
in your Google Drive.

![Slate in dark mode](screenshots/app-dark.png)

---

## Quick start

```bash
npm install
npm run dev            # http://localhost:5173
npm run build          # typecheck + production build into dist/
npm run preview        # serve the production build
npm test               # 92 unit and two-device sync tests
node scripts/smoke.mjs # 107-check browser smoke test against dist/
```

The app works immediately with no configuration — it just stays on one device
until you set up a backend in Settings (⌘,).

---

## What it does

**Writing.** Live-preview markdown: formatting renders as you type, and the raw
syntax reappears the moment your caret enters it. The buffer is always the exact
text of the `.md` file, so nothing is ever silently rewritten. ⌘⇧M shows the
plain source when you want it.

**Linking.** `[[Note Title]]` links notes to each other. Typing `[[` opens an
autocomplete over every note; picking one that doesn't exist yet offers to create
it. Clicking a broken link creates the note on the spot. Renaming a note rewrites
every link that pointed at it. Each note lists its own backlinks underneath.

**Images and files.** Paste, drop, or use the toolbar's insert button — **Take
Photo**, **Photo Library**, or **Choose File**. On a phone, Take Photo opens the
camera directly. Every route lands in the same place: images are re-encoded on
the way in — a 1.4 MB screenshot becomes 11 KB of WebP, a 122× reduction, with
no visible difference at reading size — and every image is resizable by dragging
its right edge (the width is written back into the markdown as
`![[img.png|400]]`) and opens in the lightbox on click. PDFs, video, audio and
text files can live in the vault too.

A capture that arrives as a bare `image.jpg` gets a dated name so a folder of
them stays browsable; a library filename you'd recognise — `IMG_0421`,
`Screenshot 2026-08-31` — is kept as-is.

**Tables render as tables**, including the formatting inside their cells: bold,
italics, `code`, strikethrough, links, wikilinks, tags and images all render in a
cell. Clicking a table puts the caret back in the pipe source to edit it, and it
re-renders when you click away.

**Folders and Tag Folders.** Ordinary folders nest as deep as you like and are
real directories in the vault. Tag Folders are saved boolean rules that gather
notes automatically — `#work AND (#urgent OR #blocked) NOT #archived` — and own
nothing, so deleting one never touches a note. Rules also understand
`folder:Work` and `has:tasks`, tags match hierarchically (`#work` catches
`#work/active`), and two terms side by side mean AND.

**Tag Folders nest too, and nesting means something.** By default a child
*narrows* its parent, so the hierarchy reads the way a folder tree does — a
child is always a subset. A parent of `#work` with a child `#active` and a
grandchild `#urgent` gives you `#work`, then `#work AND #active`, then
`#work AND #active AND #urgent`, and editing the parent re-narrows the whole
subtree at once.

```
💼 Work            #work                                   6
  ⚡️ Active        #work and #active                       1
    🔥 Urgent      #work and #active and #urgent           0
  🧾 Archived      #work and #archived                     1
🏠 Home            #home                                   2
```

Untick **Narrow** on any child and the nesting becomes purely visual — its rule
stands alone, useful for grouping unrelated rules under one heading. Leave a
folder's rule *empty* and it becomes a grouping folder: it shows the union of
everything nested beneath it. Deleting a parent promotes its children rather
than taking them with it; "delete with everything inside" is a separate item.

Both kinds of folder are defined in `backstage/`, so they follow you to every
device.

**Calendar and tasks.** An optional right column (⌘⇧R) shows a month calendar
with a dot per note, filed by frontmatter `date:`, a `YYYY-MM-DD` filename, or
creation time. Click a day to filter the list. Below it, every `- [ ]` in the
vault is rolled up into one task list, with due dates from `📅 2026-09-04`,
`@due(...)` or `due:...`. Ticking a box there edits the source note.

**One layout that doesn't jump.** Three modes — phone, mid-size, wide — chosen
explicitly rather than by CSS reacting to width on its own. The editor holds a
guaranteed minimum width in all of them, so when space runs short a side panel
is dropped rather than the writing surface squeezed. Crossing a breakpoint never
opens or closes anything by itself.

**Offline.** The whole app is precached. It opens, reads and writes with no
network at all, and syncs when connectivity returns.

**Never losing things.** Deletes are soft — notes move to `backstage/trash/` and
show up under Recently Deleted. Every save, sync pull and delete writes a local
snapshot, and the history dialog restores any of them. Conflicting edits are
merged when possible and kept as two files when not.

---

## Layout

| | Shows | Side panels |
|---|---|---|
| **Phone** (< 760px) | One tab at a time, bottom pill bar: Notes · Tasks · Calendar · More | Everything else lives in More |
| **Mid-size** (760–1180px) | Note list + editor | Sidebar and calendar open as dismissable drawers |
| **Wide** (≥ 1180px) | Sidebar + list + editor | Calendar sits inline from 1400px, a drawer below that |

Long-press or right-click a Tag Folder for *New folder inside…*, *Move…*, and
the two delete variants.

On a phone the editor opens full-screen over whichever tab you came from, so
tapping a note in Tasks and pressing back returns you to Tasks. Android's back
button closes the editor before it leaves the app. Long-press any note, folder
or Tag Folder for an action sheet; right-click does the same on a desktop.

## Keyboard

| | |
|---|---|
| ⌘K | Command palette / jump to note |
| ⌘N | New note |
| ⌘S | Sync now |
| ⌘F | Find in note |
| ⌘, | Settings |
| ⌘\ | Toggle sidebar |
| ⌘⇧R | Toggle calendar column |
| ⌘⇧M | Toggle markdown source |
| ⌘B / ⌘I / ⌘E | Bold / italic / code |
| ⌘K *(with a selection)* | Wrap in a wikilink |
| ⌘⇧7 / ⌘⇧8 / ⌘⇧9 | Task / bullet / quote |

---

## Setting up sync

### WebDAV — recommended

Works with Nextcloud, ownCloud, Synology, `rclone serve webdav`, Apache
`mod_dav`, and anything else that speaks the protocol. Nothing leaves your
browser except to your server.

In Settings → Sync, choose WebDAV and fill in the URL, username, password and a
vault folder. Nextcloud's URL looks like
`https://cloud.example.com/remote.php/dav/files/USERNAME`.

**Use an app password, not your account password.** Nextcloud: Settings →
Security → Devices & sessions → Create new app password.

#### The one thing that will go wrong: CORS

A browser will not talk to a WebDAV server that hasn't opted in. If "Connect and
test" fails with a network error while the server is plainly up, this is why.
The server must allow your app's origin, allow the WebDAV methods, allow the
headers the client sends, and **expose `ETag`** — that last one is what makes
conflict-safe writes possible.

<details>
<summary><b>Nextcloud / Apache</b></summary>

```apache
<IfModule mod_headers.c>
  SetEnvIf Origin "^https://notes\.example\.com$" ORIGIN_OK=$0
  Header always set Access-Control-Allow-Origin %{ORIGIN_OK}e env=ORIGIN_OK
  Header always set Access-Control-Allow-Credentials "true"
  Header always set Access-Control-Allow-Methods "GET, HEAD, PUT, DELETE, OPTIONS, PROPFIND, MKCOL, MOVE, COPY"
  Header always set Access-Control-Allow-Headers "Authorization, Content-Type, Depth, If-Match, If-None-Match, Overwrite, Destination"
  Header always set Access-Control-Expose-Headers "ETag, Last-Modified, Content-Length"
  Header always set Access-Control-Max-Age "86400"
  # Preflight must answer 200 without hitting the DAV backend.
  RewriteEngine On
  RewriteCond %{REQUEST_METHOD} OPTIONS
  RewriteRule ^(.*)$ $1 [R=200,L]
</IfModule>
```

Nextcloud also needs your origin whitelisted in `config/config.php`:

```php
'cors.allowed-domains' => ['https://notes.example.com'],
```
</details>

<details>
<summary><b>Caddy</b> (simplest if you're putting a reverse proxy in front)</summary>

```caddy
notes-dav.example.com {
  @cors header Origin https://notes.example.com
  header @cors {
    Access-Control-Allow-Origin "https://notes.example.com"
    Access-Control-Allow-Credentials "true"
    Access-Control-Allow-Methods "GET, HEAD, PUT, DELETE, OPTIONS, PROPFIND, MKCOL, MOVE, COPY"
    Access-Control-Allow-Headers "Authorization, Content-Type, Depth, If-Match, If-None-Match, Overwrite, Destination"
    Access-Control-Expose-Headers "ETag, Last-Modified, Content-Length"
  }
  @preflight method OPTIONS
  respond @preflight 204

  reverse_proxy localhost:8080
}
```
</details>

<details>
<summary><b>rclone</b> (handy for a quick test)</summary>

```bash
rclone serve webdav /path/to/vault \
  --addr :8080 \
  --user mike --pass secret \
  --etag-hash MD5
```

`rclone serve` sends no CORS headers, so put it behind the Caddy block above, or
serve the app from the same origin.
</details>

**The bulletproof shortcut:** serve the app itself from the same origin as the
WebDAV endpoint (e.g. `https://cloud.example.com/notes/`). Same-origin requests
skip CORS entirely and nothing above applies.

### Google Drive

Free, durable, nothing to self-host. It needs a one-time OAuth client, which is
free and takes about ten minutes.

1. <https://console.cloud.google.com> → create a project.
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **OAuth consent screen** → External → add your own email as a test user.
   (Staying in "testing" mode is fine for personal use. Tokens expire weekly in
   that mode, so you'll re-authorize occasionally; publishing the app removes
   that but triggers a verification review.)
4. **Credentials → Create credentials → OAuth client ID → Web application.**
   Under *Authorized JavaScript origins*, add the exact origin you serve the app
   from, e.g. `https://notes.example.com` and `http://localhost:5173`.
5. Paste the client ID into Settings → Sync.

Slate requests only the `drive.file` scope, so it can see nothing in your Drive
except the files it created itself.

**One caveat, stated plainly:** Drive v3 removed ETag preconditions, so a
conditional write isn't available. Slate re-reads each file's revision
immediately before writing and refuses if it moved, which leaves a race window of
a few hundred milliseconds. Drive's own file version history is the backstop.
WebDAV has no such gap — if two devices are often edited within the same second,
prefer it.

### No backend

Perfectly usable. Notes stay in this browser's storage. In Settings → About,
"Request persistent storage" asks the browser not to evict them; installing the
app as a PWA makes that far more likely to be granted.

---

## Deploying

**There is a build step.** The source is TypeScript and JSX, which no browser
can execute. Serving the project folder directly from a static server — macOS
Apache's `~/Sites`, `python -m http.server`, anything — hands the browser
`src/main.tsx`, the server 404s it with an HTML error page, and you get:

> Failed to load module script: Expected a JavaScript-or-Wasm module script but
> the server responded with a MIME type of "text/html".

Run `npm install` once, then either `npm run dev` for development or
`npm run build` and serve `dist/`.

`dist/` uses **relative** asset paths, so it runs from anywhere — a domain root,
`~/Sites/slate/`, a GitHub Pages subpath — with no configuration. To serve it
from macOS's user web directory:

```bash
npm install && npm run build
cp -R dist/ ~/Sites/slate/      # then open http://localhost/~you/slate/
```

Only set `VITE_BASE=/subdir/` if you specifically need absolute paths.

HTTPS is required for service workers and PWA install (localhost is exempt), so
offline mode and installing won't engage over plain `http://` on a LAN address.

To put it on a static host:

```bash
npm run build

# Netlify
netlify deploy --prod --dir=dist

# Cloudflare Pages
wrangler pages deploy dist

# Vercel
vercel deploy --prod dist
```

**Installing it.** Desktop Chrome/Edge: the install icon in the address bar.
Android Chrome: menu → Install app. iOS Safari: Share → Add to Home Screen —
this is the only way to install on iOS, and it is what gets you offline support
and a real app icon there.

**Two lines in `index.html` are load-bearing on iOS**, and both fail the same
way: the installed app stops reaching the bottom of the screen, leaving a band
of dead space below it that no CSS can fill, because the page is never handed
those pixels.

- The `viewport` meta must keep `viewport-fit=cover`. Without it iOS letterboxes
  the app inside the safe area, and every `env(safe-area-inset-*)` reads `0`, so
  nothing in the stylesheet can even detect the situation. It is written on one
  line with no spaces, matching a configuration known to work; reformatting it
  is the kind of tidy-up that quietly brings the bands back.
- `apple-mobile-web-app-status-bar-style` must be `default`. `black-translucent`
  asks for an edge-to-edge web view and returns one shorter than the screen.

Neither is observable outside a real installed iOS PWA — simulators, desktop
Safari and headless Chromium all render correctly either way — so the smoke
suite asserts both on the markup, and Settings › About reports the view height
against the screen height, which is the fastest way to spot it on a device.

**Updating it.** Settings › About shows the running build and a **Check for
updates** button. Use it rather than reloading: a newly deployed build installs
in the background and then *waits*, because a service worker cannot take over
while the old one still controls an open page — and reloading does not release
it. Reloading therefore lands you on the same build no matter how many times you
try, which is why stale installs have a reputation for needing site data
cleared. The button tells the waiting build to take over and then reloads onto
it. Next to it, **Reinstall** unregisters the worker and empties the app's
caches before re-downloading — the same ground as clearing the browser cache,
scoped to the app. Neither touches your notes; those live in IndexedDB.

---

## How your notes are stored

Your vault is an ordinary folder of ordinary files. Open it in Obsidian, edit it
in vim, grep it, back it up with `rsync`. Nothing here is a lock-in format.

```
Vault/
├─ Start.md
├─ Lisbon Trip.md
├─ Work/
│  ├─ Call with TAC.md
│  └─ Highway 9.md
├─ attachments/
│  └─ 2026/08/pasted-a3f9.webp
└─ backstage/                 ← app's own files, hidden in the UI
   ├─ config.json             ← shared preferences
   └─ trash/                  ← soft-deleted notes
```

`backstage/` syncs like everything else but never appears in the note list,
search, calendar, tags or link autocomplete. Credentials are the one thing that
is deliberately *not* in there — a WebDAV password or a Drive client ID stays in
the browser's local database on each device, so secrets never enter the vault.

---

## How sync works

This is the part worth understanding, because it is where a notes app usually
loses your data.

Nothing ever waits on the network. Typing writes to memory and IndexedDB, marks
the file dirty, and returns. Sync happens later, on a timer, when the app becomes
visible, when the network returns, and a few seconds after edits settle.

Each file remembers three things from its last successful sync: a hash of the
content, the server's revision id, and — for notes — the full text. That third
one is the common ancestor, and it is what makes a real three-way merge possible.

When a file has changed on both sides:

- **Different regions edited** → line-wise merge; both sets of changes survive.
- **Both devices appended** → both blocks are kept, ordered deterministically so
  every device computes byte-identical output and the vault converges. This is
  the most common divergence in a notes app and treating it as a conflict would
  be needlessly destructive.
- **Same lines rewritten** → your version stays at the real path (so the editor
  buffer under your cursor is never yanked away) and the server's version is
  saved beside it as `Note (conflict — mac 2026-08-31 1420).md`, which then syncs
  everywhere so the divergence is visible on every device rather than quietly
  resolved on one.

Writes are conditional (`If-Match`), so a write is refused rather than
overwriting a change that arrived since the last listing; the refusal routes back
into the merge above.

Deletes are the other classic way to lose work, so:

- A delete moves the file to `backstage/trash/` rather than removing it.
- A delete is only replicated once the tombstone is confirmed; it never bounces
  back and resurrects over newer content.
- **An edit beats a delete.** If a note was deleted here but edited elsewhere, it
  comes back rather than the edit vanishing.
- Locally-edited files that were deleted remotely are re-uploaded.

On top of all that, every save, sync pull and delete writes a local snapshot
(60 versions per note, 90 days). Sync faithfully replicates mistakes; version
history is what covers "I pasted over three paragraphs an hour ago". It is
device-local and deliberately not synced.

`src/core/sync.test.ts` runs two independent "devices" — separate module
instances with separate databases — against one in-memory server and asserts
every one of these behaviours.

---

## Architecture

```
src/
├─ core/          no DOM, no framework — testable in isolation
│  ├─ types.ts        data model + the RemoteAdapter contract
│  ├─ vault.ts        in-memory source of truth, derived indexes
│  ├─ db.ts           IndexedDB: cache, journal, version history
│  ├─ sync.ts         the reconcile engine
│  ├─ merge.ts        three-way merge (diff3)
│  ├─ markdown.ts     frontmatter, links, tags, tasks
│  ├─ tagquery.ts     the Tag Folder rule language (tokenizer, parser, eval)
│  ├─ folders.ts      nested folders + the Tag Folder tree and inheritance
│  ├─ images.ts       paste- and capture-time re-encoding
│  └─ settings.ts     device-local vs vault-wide preferences
├─ adapters/      webdav.ts · gdrive.ts · memory.ts (tests)
├─ editor/        CodeMirror 6: live preview, widgets, completion, paste
│  ├─ inline.ts      inline markdown for text inside widgets (table cells)
│  └─ pickImage.ts   camera / photo library / file insertion
└─ ui/            Preact components
   ├─ layout.ts      the three layout modes and panel visibility
   └─ Mobile.tsx     phone tab bar and full-screen tab views
```

Two rules keep it comprehensible:

**The vault is the source of truth, not the database.** IndexedDB is a cache and
a journal. Wipe it and a sync repopulates it. Nothing lives only there except
version history.

**A backend is five methods.** `list`, `getText`/`getBlob`, `put`, `remove`,
`ensureDir`. All the difficult reasoning is in `sync.ts`. Adding S3, Dropbox or
the File System Access API is a couple hundred lines in `src/adapters/` and one
line in `src/app/backend.ts` — no changes to the engine.

**Bundle.** ~200 KB gzipped for the editor core, ~1.1 MB precached including the
16 lazily-loaded code-block language modes. CodeMirror's full language catalogue
(~120 chunks, +650 KB of precache) was deliberately dropped for a curated set.

---

## Known limits

Being honest about what isn't done, roughly in the order I'd tackle it:

- **Folder names are still collected with `prompt()`.** Creating and renaming a
  folder works and is undoable, but the input itself is a browser dialog rather
  than a proper inline field. The note actions and Tag Folder editor are real UI;
  this one corner isn't yet.
- **No drag-and-drop between folders.** Moving a note is long-press (or
  right-click) → *Move to…*, which works identically on touch and desktop. Drag
  would be nicer with a mouse.
- **No manual reordering of Tag Folders.** Siblings sit in creation order; the
  underlying `reorderSmartFolders` exists but nothing calls it yet.
- **A Tag Folder can't live inside a real folder.** The two hierarchies are
  separate — use `folder:Work` in the rule to pin one to a folder.
- **Table editing is source-based.** Tables render properly and their cells
  render inline formatting, but clicking one puts the caret in the pipe markdown
  rather than editing in the cell.
- **Search is a linear scan.** Fast and predictable to a few thousand notes; past
  that it wants an inverted index.
- **No encryption at rest.** Notes are plain files on your server. Per-file
  encryption before upload would fit cleanly behind the adapter interface.
- **iOS PWA storage can be evicted** after ~7 days of not opening the app, which
  is a Safari policy, not something the app can override. With sync configured
  this costs a re-download, not data. It is the strongest argument for setting up
  a backend rather than staying local-only.

---

## Ideas worth considering next

- **Daily notes with a template.** The palette already has "Open today's note";
  a configurable template and a keyboard shortcut would make it a habit.
- **A graph or "related notes" view**, built on the backlink map that already
  exists.
- **Publish a note** as a read-only shared link, straight from the adapter.
- **Encrypted vaults**, as above — a clean fit behind `RemoteAdapter`.
- **Multiple vaults**, which is nearly free: `db.ts` already reads its database
  name from a global so more than one can coexist in a profile.
- **Tag Folder rules over dates** — `created:<2026-01-01`, `due:overdue` — which
  the parser is already shaped to accept.
- **Full-text index** if the vault grows past a few thousand notes.

---

## Testing

```bash
npm test                # 92 unit + two-device sync tests
node scripts/smoke.mjs  # 107 checks in headless Chromium against dist/
node scripts/shots.mjs  # regenerate screenshots/
```

The smoke test covers what unit tests can't reach: live-preview rendering,
autocomplete, clipboard paste with real image re-encoding, IndexedDB persistence
across reloads, and a genuine offline load with the network cut. It runs from a
subdirectory so the build stays relocatable, sweeps twelve viewport widths
asserting the editor never drops below a usable size and no drawer is ever left
open by a resize, and drives the phone layout with real touch events. Its
kitchen-sink note exists because a table alone once crashed the editor and
nothing else's content contained one. The table section asserts inline elements
inside cells one by one — `strong`, `em`, `code`, `del`, a wikilink, a link, a
tag — rather than eyeballing text, and the photo-insert section drives the real
native file picker and checks the result was re-encoded, named and made
resizable exactly like a paste.

If Chromium isn't on the default path:

```bash
CHROMIUM_PATH=/path/to/chrome node scripts/smoke.mjs
```
