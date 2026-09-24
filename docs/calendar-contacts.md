# Calendar & Contacts

A specification for putting calendar events and contacts into Slate without
putting a calendar app and an address book into Slate.

---

## The problem

A lot of notes are about a person or about a meeting, and a lot of notes want to
*point at* one. Linking notes to people and events would be valuable. Storing
people and events in Slate would not: dedicated calendar and contacts apps
already exist, they are wired into phones, watches, assistants and mail clients
in ways a notes app never will be, and maintaining a hand-written duplicate of
that data is work with no payoff. Building the equivalent inside Slate would be
bloat measured in features nobody asked this app for.

So the external system keeps owning the data, and Slate gets a **projection** of
it: ordinary markdown files, written by a helper program that lives entirely
outside this repository, which Slate reads the same way it reads everything
else. One-way, always. Slate never writes back.

What that buys, concretely: `[[Jane Doe]]` resolves, and Jane's note shows every
meeting she was in and every note you wrote that mentioned her — without a line
of CalDAV in this codebase.

---

## 1. Principles

1. **The external system owns the record.** Slate holds a read-only projection.
   There is no write-back, ever.
2. **The projection is ordinary markdown in ordinary folders.** Not
   `backstage/` — see §1.1.
3. **Origin is a property of the file, not of its location.** A hand-written
   event and an imported one are the same kind of thing to the agenda. The only
   difference between them is a `source:` key.
4. **Slate ships no integration code.** No CalDAV, no CardDAV, no OAuth, no
   iCalendar parser, no recurrence engine. Slate reads frontmatter. Everything
   else is the helper's problem.
5. **The format is the contract, and it lives in this repository**, because
   Slate is the reader and the reader is what must not break.

### 1.1 Why not `backstage/`

`backstage/` is not "a hidden folder" — it is the one path prefix meaning *this
is the app's own bookkeeping, not your material*. `isHidden()`
(`src/core/vault.ts:322`) is applied in exactly one place, the `notes` signal
(`src/core/vault.ts:520`), which every user-facing surface derives from. The
README states the contract: backstage "never appears in the note list, search,
calendar, tags or link autocomplete."

For contacts under `backstage/`, that means:

- `titleIndex` is built from `notes` (`src/core/vault.ts:570`), so `[[Jane Doe]]`
  **does not resolve**. It lands in `unresolvedLinks`, and the app offers to
  *create* a note called Jane Doe — a duplicate of the thing being linked to.
- `pathSet` is built from raw `files` (`src/core/vault.ts:580`), so only the
  full-path form `[[backstage/integrations/contacts/Jane Doe]]` resolves, via
  `resolveTarget`'s exact-path branch (`src/core/markdown.ts:951`).
- Search, backlinks and wikilink autocomplete are all off by design.

Browsing, searching and linking are precisely the surfaces `backstage/` exists
to switch off. Putting the projection there and re-enabling them one at a time
would mean unpicking the single predicate the rest of the app depends on.

**The precedent to follow is `Templates/`.** Templates are real notes in a real
visible folder — searched, linked, autocompleted, synced — but excluded from
every *roll-up* by a second derived signal, `contentNotes`
(`src/core/vault.ts:548`), keyed on a path predicate. The reasoning in the
README's template section is almost word for word the argument for imported
contacts: real files that must be findable and linkable, but not *your
material*, and so not allowed to inflate anything that counts.

---

## 2. Data model

### 2.1 Event notes

```markdown
---
start: 2026-09-21T09:30
end: 2026-09-21T10:00
tz: America/New_York          # optional; start/end are written in this zone
location: Room 4B             # optional
url: https://meet.example/abc # optional, the join link
attendees:                    # optional
  - "[[Jane Doe]]"
  - "Sam Ortiz"               # plain text when no contact matched
source: fastmail              # absent on notes you wrote yourself
uid: 3f2a...@fastmail.com     # absent on notes you wrote yourself
---

# Design review

Short description, if any.
```

| Key | Type | Notes |
| --- | --- | --- |
| `start` | date or datetime | **Required.** Its presence is what makes a note an event. A bare date means all-day. |
| `end` | date or datetime | Optional. **Inclusive** for all-day. Defaults to `start` + 1h (timed) or `start` (all-day). |
| `tz` | IANA zone name | Optional. When present, `start` and `end` are written in it. |
| `location` | string | Optional. |
| `url` | string | Optional. The join link, lifted out of the description. Kept apart from `location` because on a video meeting the "where" is a link: you click one and read the other. |
| `attendees` | list | Wikilinks where a contact matched, plain strings otherwise. |
| `calendar` | string | Optional. Which source calendar it came from — Work, Personal, Family. Nothing reads it yet; reserved because colouring the agenda by it is the obvious next thing, and vdir stores a `displayname` per collection so the importer gets it free. |
| `source` | string | Provider slug. **Its presence means the file is externally owned.** |
| `uid` | string | The source system's identity key. Helper-owned; Slate only round-trips it. |

**Only the first three are read by code.** `start` (with `end` and `tz`) is the
whole of what Slate parses, plus `source` and `uid` from §2.3 onward. Everything
else in the table is a *blessed name* — frontmatter is open, so any key already
works and shows in the properties form; naming these buys nothing but the
guarantee that a hand-written event and an imported one use the same words.
The list of keys code depends on should stay closed and small.

**Rejected on purpose.** `duration:` (a second spelling of `end`, which is
ambiguity bought for nothing), `allday:` (the absence of a time already says
it), `organizer:` (one of the attendees), `status:` (cancelled events are
deleted, and `TENTATIVE` is not worth a key nothing reads), and reminders or
alarms of any kind — Slate has no notification story, and a field nothing acts
on is a promise the file cannot keep.

**A new event pre-fills `start` and `end` and nothing else.** Every pre-filled
empty key is a row of chrome in the properties panel and a line of noise in the
file, and for most events it would be wrong. A folder template on `Calendar/` is
the mechanism for "I always want these four fields", and the `Meeting` starter
is one — it opens with `start:`, so a meeting note lands on the agenda for the
day it happened.

**Filenames.** `Calendar/2026/09/Design review - 2026-09-21.md`. Year/month subfolders keep
any one directory browsable, and a template assigned to `Calendar/` reaches them
— the walk goes up within the calendar tree, because `Calendar/2026/09` is not a
folder anybody chose.

**The day goes on the end of the name, and nothing goes on the front.**
`Calendar/2026/09/Lunch with Joe - 2026-09-22.md`. Not the time — that moves too
often to be worth writing down twice — and never a prefix, which is what this
was first built as and what had to be taken out again: a prefix pushes the name
out of every list that shows one, and the agenda rail is a single line ending in
an ellipsis, so it showed the date and then ran out of room before reaching the
thing you named.

The objection to writing *when* into a filename is real and still stands: a
filename does not follow the frontmatter, so the date stops being true the
moment the event moves. It is left stale rather than chased, because a rename
breaks every `[[link]]` pointing at the note, and nothing reads it — the agenda
takes both the clock and the day off `start:`, and `eventTitle` strips the
suffix before a row is drawn.

What makes it worth paying is the alternative. Collisions resolve per
*directory* and the directory is a month, so a weekly lunch was `Lunch with
Joe`, `Lunch with Joe 2`, `Lunch with Joe 3` through September — and then began
again at `Lunch with Joe` in October, a different folder with a fresh counter.
The same series, numbered differently every month, with nothing in any of the
names saying which occurrence it was. A date is a disambiguator that means
something, sorts the way the folder already sorts, and leaves the name you typed
at the front where prefix search and every alphabetical list expect it.

The suffix is part of building the name, not something added to a name already
built. `safeSegment` caps a path segment at 120 characters, so a suffix stuck on
afterwards is the first thing cut — and a long title came back either without
its date or with half of one. The title is cut with the suffix's room already
taken out, and `eventTitle(eventNoteName(title, start))` is `title` for every
title, including one that ends in a date of its own: that one is given a second
date rather than skipped, because a filename cannot say which of the two a
reader wrote.

It still costs the bare name. `titleIndex` is first-writer-wins on collision
(`src/core/vault.ts:574`), and now no occurrence holds `Lunch with Joe.md` at
all, so `[[Lunch with Joe]]` resolves to nothing and a link names a date or goes
through `aliases:`. That is a better trade than eleven notes reachable only by a
number that starts over in October.

**The importer disambiguates differently**, and deliberately. It uses a short
stable suffix derived from the `uid` — `Standup (a41b).md` — because it writes
hundreds and *stability* is its requirement: a recurring series it re-syncs must
land on the same filenames every run, and a date would force a rename every time
a meeting moved, breaking every link pointing at it. A hand-made event is
written once and never rewritten by anything, so it can afford a date that goes
stale; an imported one cannot. Same problem, two answers, and the difference is
who rewrites the file.

**Bodies stay short.** The description is truncated to roughly 500 characters,
conference boilerplate is stripped, and the join link goes in `url` rather than
being left in prose. See §7 for why this matters more than it looks.

### 2.2 Contact notes

```markdown
---
emails: [jane@example.com, j.doe@work.example]
phones: ["+1 555 0143"]
org: Example Corp
title: Head of Design
birthday: 1984-03-02
aliases: [Jane Smith, JD]
source: fastmail
uid: a41b...
---

Met at the Lisbon conference. Prefers email.
```

**Filenames.** `Contacts/Jane Doe.md`, flat, because the filename *is* the link
target and `[[Jane Doe]]` is the entire point. Collisions take a disambiguator
from `org` or the email local-part: `Contacts/Jane Doe (Example Corp).md`.

No photos — an address book's worth of them is megabytes into a sync set that
reaches your phone. No `#tags` derived from vCard categories, which would
inflate tag counts with somebody else's taxonomy.

### 2.3 The `source:` marker

One key, one meaning: *a program owns this file and will overwrite it*. It
drives the read-only banner (§5.5), the roll-up exclusions (§4.3), and the
helper's own delete-safety check (§6.2). It means nothing else.

---

## 3. Time, precisely

iCalendar already solved this, so the format transliterates its model rather
than inventing one. iCal has three ways to write a start time; each maps to one
frontmatter shape.

**All-day** — `DTSTART;VALUE=DATE:20260921`

```yaml
start: 2026-09-21
```

A bare date and no time. That is the whole signal; no `allday: true` is needed,
because "has no time component" is unambiguous, and it keeps `calendarDateFor`
(`src/core/markdown.ts:920`) working on it untouched.

> **The trap.** iCal's `DTEND` for an all-day event is *exclusive*: a one-day
> event on the 21st is written `DTSTART:20260921 / DTEND:20260922`. Copied
> through literally, every one-day event renders as two days long. **Slate's
> `end` is inclusive**, and the helper subtracts a day.

**Floating local time** — `DTSTART:20260921T093000`

```yaml
start: 2026-09-21T09:30
end: 2026-09-21T10:00
```

No zone: half nine wherever you are. The right shape for the overwhelming
majority of events, and the one you would write by hand.

**Zoned** — `DTSTART;TZID=America/New_York:20260921T140000`

```yaml
start: 2026-09-21T14:00
end: 2026-09-21T15:00
tz: America/New_York
```

**The rule that makes this unambiguous: `start` and `end` are always written in
the zone named by `tz`, and when `tz` is absent they mean the device's local
zone.** So the file reads as the meeting's own local time — "14:00 in New York",
which is how the meeting was described to you — and the zone name is there for
Slate to convert with `Intl.DateTimeFormat`, which every browser ships. No
timezone library is needed.

In the rail a zoned event renders as `14:00 · New York` with your own time in
the primary position.

**Why not an offset** (`2026-09-21T09:30+01:00`). It is correct but worse here:
an offset says *when* without saying *where*, and "where" is what you want on
screen. `+01:00` gives nothing to render as a label, breaks across DST for
anything recurring, and a human editing the file by hand has to know it.
`tz: Europe/London` survives DST, renders as words, and is what the source
system actually stored.

In practice ~95% of event files carry `start` and `end` and nothing else. `tz`
exists so the remaining 5% are not lossy.

---

## 4. Slate core changes

### 4.1 Index additions

`NoteIndexEntry` (`src/core/types.ts:115`) gains three fields, computed in
`buildEntry` (`src/core/vault.ts:340`) from frontmatter that is already being
parsed there — no second pass over the text:

```ts
/** Set when this note has a `start:`. Undefined for ordinary notes. */
event?: { start: number; end: number; allDay: boolean; tz?: string }
/** The provider slug from `source:`, if any. Externally owned when set. */
source?: string
/** Other names this note answers to, from `aliases:`, as written. */
aliases: string[]
```

`event` is one optional object rather than four flat fields on purpose: this
struct is held per note for the whole session, and most notes have no event.

### 4.2 Derived signals

There are two today — `notes` (everything visible, `src/core/vault.ts:520`) and
`contentNotes` (`notes` minus templates, `src/core/vault.ts:548`). This adds a
third tier between them.

```
notes          = everything visible          → search, ⌘K, autocomplete,
                                               orphan scan, rename repointing
linkableNotes  = notes − templates           → backlink SOURCES, eventsByDay
contentNotes   = notes − templates − external → every roll-up
```

`contentNotes` gains one more exclusion, and because the roll-ups already read
it, **the task list, tag counts, calendar dots, Tag Folder matches,
related-notes and the note list all exclude imported material for free.** That
is the whole value of following the Templates precedent rather than inventing a
mechanism.

**`linkableNotes` exists for one specific reason.** `backlinkMap`
(`src/core/vault.ts:634`) iterates `contentNotes` to find link *sources*. Drop
imported events from `contentNotes` and their `attendees: [[Jane Doe]]` links
are never indexed — so Jane's Linked Mentions panel comes back empty, which
would kill the highest-value thing in this whole design. Backlink sources
therefore read `linkableNotes`.

`unresolvedLinks` (`src/core/vault.ts:659`) stays on `contentNotes`: a broken
link inside a generated file is not yours to fix.

```ts
/** date (local midnight ms) -> events on that day, earliest first. */
export const eventsByDay = computed(() => { /* over linkableNotes */ })
```

It reads `linkableNotes` so that a folder template carrying a sample `start:`
never lands on the agenda — a real hazard given §5.4.

### 4.3 Which surfaces see what

| Surface | Reads | Imported event | Imported contact |
| --- | --- | --- | --- |
| Note list (middle column) | `contentNotes` | ✗ | ✗ |
| Calendar month dots | `contentNotes` | ✗ | ✗ |
| Tag counts / Tag Folders | `contentNotes` | ✗ | ✗ |
| Task roll-up | `contentNotes` | ✗ | ✗ |
| Related notes | `contentNotes` | ✗ | ✗ |
| Unlinked mentions | `contentNotes` | ✗ | ✗ |
| **Agenda** | `linkableNotes` | **✓** | n/a |
| **Backlinks (as source)** | `linkableNotes` | **✓** | ✓ |
| **Backlinks (as target)** | `titleIndex` | **✓** | **✓** |
| **Search** | `notes` | **✓** | **✓** |
| **`[[` autocomplete, ⌘K** | `notes` | **✓** | **✓** |
| Orphan scan, rename repointing | `notes` | ✓ *(correctness)* | ✓ *(correctness)* |

That last row is not a preference. The orphan scan must see every file that
references an attachment, or an image used only by an imported note is reported
unused and offered for deletion — the same reason templates are exempted from
the roll-ups but never from the orphan scan.

**A consequence to design for:** Jane Doe's Linked Mentions panel will hold
three notes you wrote and two hundred meetings. `LinkedMentions.tsx` groups by
origin — your own notes first and expanded, external sources collapsed under a
count.

### 4.4 Aliases

`aliases:` feeds `titleIndex` (`src/core/vault.ts:570`), which today maps
lowercased filename to path, first writer winning so that link targets stay
stable when titles collide.

**The build must be two passes: every filename first, then every alias.**
Otherwise an alias on one note can claim a name that is another note's actual
title, and first-writer-wins would let it. Filenames always beat aliases; among
aliases, first still wins.

This is a general Slate feature, useful with no integration in sight. It is also
what stops links rotting when somebody's display name changes upstream: Slate's
rename-repointing cannot fire for a rename that happened on disk, so without
aliases every `[[Jane Doe]]` breaks silently the day the helper renames her file.

---

## 5. Interface

### 5.1 The agenda panel

A new `AgendaPanel` in `RightRail.tsx`, following the existing `rail-section`
shape:

- Header: the selected day, matching `DayNotesPanel`'s current header.
- All-day events pinned at the top, unlabelled.
- Timed events in a list, `09:30` in a fixed-width gutter, title beside it.
  **Not** a time grid: a grid needs vertical space the rail has not got, and
  this is a surface for reading a day, not for scheduling one.
- A row reads as the event's *name*: the trailing ` - 2026-09-21` the filename
  carries for uniqueness is stripped, since the panel is under a heading naming
  the day and puts the clock in its own column already. (A leading
  `2026-09-21 0930` is stripped too, for notes made while the stamp went on the
  front.)
- Zoned events annotate with their own zone.
- A small provider mark on external events; nothing on your own.
- Empty state: "Nothing scheduled.", matching `rail-empty` elsewhere.
- A row opens its note.

### 5.2 Rail composition

```
CalendarPanel
AgendaPanel        ← new
DayNotesPanel      ← its notes list is now conditional
DueTasksPanel
```

`DayNotesPanel` renders its **notes list** only when the middle column is not
already showing the same thing — that is, when `scope.kind !== 'day'`, or when
the scoped day differs from the selected one. Its other three parts — the day
header, *Create daily note*, the day's due tasks and `AddTaskRow` — always
render, because nothing else in the app duplicates them.

Concretely: in the default `filter` mode a calendar click scopes the list to
that day (`src/ui/state.ts:635`) off the same `notesByDay` map the rail reads,
so the rail drops its copy. In `daily` mode a click opens or offers that day's
daily note and never touches the scope, so the rail keeps it. Browsing a folder
with today implicitly selected, it keeps it.

### 5.3 Phone

The rail panels already double as full-screen tabs — that is why they are
exported individually. `AgendaPanel` joins them under the month on the calendar
tab. `DayNotesPanel`'s `omitOwed` flag is the precedent for the small per-surface
differences.

### 5.4 Creating an event

- A `>New event` command in the palette: asks for a title, writes
  `Calendar/<year>/<month>/<title> - <date>.md` with `start` and `end`
  prefilled from the selected day, and opens it.
- A folder template on `Calendar/` for anyone wanting extra fields. This uses
  the existing folder-template mechanism; there is nothing new to build.
- Optionally a `+` in the agenda header, calling the same thing.

No event editor and no date-picker widget. The frontmatter form in
`Properties.tsx` already edits these keys.

### 5.5 Read-only, and Detach

Any note with `source:` set opens read-only, with a banner naming the provider
and one action: **Detach from `<source>`**, which strips `source:` and `uid:`
and leaves an ordinary note you own.

Without this the failure is concrete rather than theoretical. You fix a typo;
the helper rewrites the file on its next run; the folder adapter has no
conditional write (`src/adapters/folder.ts:21`); the engine's three-way merge
resolves it as a **conflict copy** — a second file in your vault named after a
meeting you do not own. Weekly, that is a vault accreting junk.

---

## 6. The helper

Outside this repository, in its own project. Specified here only because the
format is a contract with two sides.

### 6.1 Architecture

```
CalDAV / CardDAV ──vdirsyncer──┐
                               ├──> vdir/ ──project──> <vault>/Calendar/
macOS EventKit ──swift dumper──┘      .ics  .vcf       <vault>/Contacts/
```

Two stages, and the split is the design. Stage one is **transport** — auth,
discovery, incremental sync, deletion detection — and is either
[vdirsyncer](https://vdirsyncer.pimutils.org/) or a small Swift binary that
reads EventKit and writes `.ics` into the same layout. Stage two, `project`, is
a **pure function from a directory of `.ics`/`.vcf` to a directory of `.md`**:
no network, no credentials, no daemon, and testable against a folder of
fixtures.

vdirsyncer's vdir format is one directory per collection and one file per item,
which is already the shape the projection wants. Its `read_only` storage option
enforces the one-way rule at the source, `start_date`/`end_date` bound the
window server-side, and its status database is what distinguishes "cancelled
upstream" from "the fetch failed" — the single hardest thing here to get right
by hand, and the one that deletes real data when it is got wrong.

EventKit exists to cover Exchange and Microsoft 365, which do not speak CalDAV
at all. Defining stage two's input as "a directory of `.ics`/`.vcf`" rather than
"whatever vdirsyncer produces" is what makes the two producers interchangeable,
and mixable per account.

Python 3 for stage two (`icalendar`, `recurring-ical-events`, `vobject`). A
launchd or systemd timer runs `sync && project` every 15 minutes. Not a
resident daemon.

### 6.2 Ownership and deletion

State lives **outside the vault**, in the helper's own directory:

```json
{ "uid@provider": { "path": "Calendar/2026/09/….md", "hash": "sha256…", "gen": 41 } }
```

A file is overwritten or deleted only when **all three** hold:

1. it is in the manifest;
2. its `source:` still names this provider;
3. its hash matches what the helper last wrote.

Fail (3) and the file has been edited by hand — leave it, log it, never touch it
again. Fail (2) and it has been detached. This is what makes §5.5's Detach mean
something durable rather than cosmetic.

**Deletion has two distinct paths, and conflating them is a bug:**

- *Cancelled upstream* — the UID is absent from a **complete and successful**
  fetch. Delete.
- *Slid out of the window* — the occurrence now falls outside the window.
  Delete, but by generation rather than by absence.

A partial or failed fetch triggers neither. Stage two must never infer deletion
from an empty or short directory listing.

### 6.3 Window and recurrence

The window is **now − 1 month → now + 3 months**, recomputed each run.

Recurrence is expanded **in the helper**: one markdown file per occurrence,
in-window only, with `RRULE`, `EXDATE` and `RECURRENCE-ID` overrides all
resolved before anything is written. Slate never sees a recurrence rule and
contains no code that understands one.

The alternatives were considered and rejected. One file per *series* with Slate
expanding the rule puts an iCalendar engine inside Slate, which is the bloat
this whole design exists to avoid. One file per *day* holding a list is smaller
still but kills per-event linking and collides with daily notes.

Per-occurrence costs roughly 300–600 files for a meeting-heavy calendar, which
§7 shows is comfortable.

### 6.4 Attendee linking

For each attendee on an event:

1. Match by **email** against the contact projection. Exact match only — no name
   fuzzing.
2. Matched: write `"[[Jane Doe]]"`, using the contact's current filename.
3. Unmatched: write the display name as **plain text**, never a wikilink. This
   is what keeps unresolved-link noise at exactly zero.
4. Skip yourself.
5. **Skip the list entirely above ~12 attendees.** A 200-person all-hands must
   not write 200 wikilinks into the vault.

Contacts are therefore projected *before* events on every run.

### 6.5 Idempotence

Non-negotiable, because everything the helper writes lands in a sync set that
reaches every device.

- Deterministic serialization: fixed key order, fixed list formatting, fixed
  date formatting.
- **No generated timestamps.** No `synced_at:`, no `generated:`. One such key
  turns every run into a full-vault rewrite.
- Compare bytes before writing and skip identical files entirely — do not even
  touch the mtime. The folder adapter's `rev` is mtime plus size, so a no-op
  touch still costs a re-read and a reconcile pass for every file, every run.

---

## 7. Scale, and the search index

The thresholds, from `src/core/vault.ts:455`:

```
INDEX_FROM_NOTES = 1000
INDEX_FROM_BYTES = 4_000_000
```

`worthIndexing()` (`src/core/vault.ts:473`) checks `indexMap.size` against the
first and the sum of `entry.size` against the second; either gate trips it.
`indexMap` holds every indexed note, so imported events count toward it wherever
they live.

**Crossing it is not a cliff and not a correctness boundary.** The index is a
filter in front of the same linear scan, and it is allowed to be loose but never
wrong — it may hand the scan a note the scan then rejects, and may decline to
narrow at all, but a note that matches is never left out. Results are identical,
in identical order, either way. What it costs is a third of a second or so of
background CPU per cold start at three thousand notes, in 8ms idle slices, never
on the critical path, plus memory roughly the size of the vault's distinct
vocabulary.

**And the projection is unusually cheap by that measure.** The index is over
runs of non-whitespace, deduplicated across the whole vault. Six hundred event
files are enormously repetitive — "Standup", "Weekly", the same dozen attendee
names, the same three rooms — so they raise the note count and barely touch the
vocabulary.

What would genuinely hurt is **bodies**. A calendar invite's `DESCRIPTION` is
usually dial-in boilerplate and a legal footer; six hundred copies of that is
real megabytes, real vocabulary, and a search for "meeting" that returns a wall
of invites. Which is where §2.1's truncation rule comes from.

---

## 8. Non-goals

Two-way sync. RSVP or invitation handling. Free/busy. Editing recurrence in
Slate. Creating or editing contacts in Slate. Contact photos. VTODO import. A
bespoke contacts browser — a folder, `⌘K` and the backlinks panel *are* the
contacts browser.

---

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| An upstream display-name change breaks `[[links]]` | `aliases:` (§4.4); the helper records every prior name |
| Exchange / M365 are unreachable by CalDAV | The EventKit path on macOS; no answer on Linux |
| Two machines running the helper | Specified as one machine only; the manifest is machine-local |
| The phone shows a stale projection | Accepted — it is read-only there by nature, and the window is three months wide |
| Jane's backlinks drowned by 200 meetings | Grouped Linked Mentions (§4.3) |
| The vault crosses the index threshold | Short bodies and a bounded window (§7) |

---

## 10. Delivery

Ten slices. Each merges on its own and leaves the app working. **v1 ships at the
end of slice 3, with no integration in existence.**

### Phase A — core, no integration

**0 · Aliases.** `aliases:` on the index, two-pass `titleIndex`, tests for the
filename-beats-alias rule. A standalone Slate feature that ships and is useful
with nothing else built.

**1 · Event model.** `event?` on `NoteIndexEntry`; frontmatter parsing including
the all-day rule, the inclusive `end`, and `tz`; `eventsByDay`; the
`linkableNotes` signal. **No UI at all.** Core and tests.

**2 · The agenda.** `AgendaPanel`, rail recomposition, the conditional
`DayNotesPanel` notes list, the phone tab. The visible payoff.

**3 · Authoring.** The `>New event` command, the `Calendar/` folder template,
the agenda `+`.

> **v1 ships here.** Hand-written events, a working agenda, aliases. Complete
> and coherent with zero external machinery — and it proves the format before
> anything depends on it.

### Phase B — making Slate ready to receive

**4 · Origin.** `source:` on the index, `isExternal`, the `contentNotes`
exclusion, grouped Linked Mentions. Must land before any real data arrives, or
six hundred events flood the note list.

**5 · Read-only.** The banner, the locked editor, the Detach action.

> **Slate is done here.** Everything after this is a separate repository.

### Phase C — the helper

**6 · Transport.** vdirsyncer configuration, the Swift EventKit dumper, both
landing in one vdir layout. **No markdown produced.** Verified by pointing
`khal` and `khard` at the result — which de-risks the load-bearing half of the
plan before a line of projection code exists.

**7 · Contacts projection.** vCard to markdown, the manifest, the
three-condition delete rule, idempotence tests. Contacts come first
deliberately: no recurrence, no window, no expansion. It exercises the entire
ownership and safety machinery against the easy data shape, so those bugs are
found before recurrence is in the picture.

**8 · Events projection.** Recurrence expansion, the rolling window, both
deletion paths, body truncation.

**9 · Attendee linking.** Email matching, the plain-text fallback,
self-exclusion, the size cap. Depends on 7.

**10 · Polish.** Provider marks, agenda refinements, whatever the first month of
real use asks for.

The ordering has one deliberate property: **every slice up to 5 is worth having
even if the helper is never written**, and every slice from 6 on is worth having
even if vdirsyncer is later swapped for something else. Nothing in the middle is
load-bearing on something that does not exist yet.
