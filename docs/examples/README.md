# Example vault

What the calendar and contacts helper writes, and what Slate makes beside it,
as real files — the format in `docs/calendar-contacts.md`, shown rather than
described. Both sides test against them:

- **Slate** loads every file here into a vault and checks it reads them as the
  design says (`src/core/examples.test.ts`). A change to Slate that stops
  reading one of these is a change to the contract, and fails there first.
- **The helper** should produce these files byte for byte from matching
  `.ics` / `.vcf` fixtures, and treat the ones it did not write as off limits.

Paths are vault paths. Everything under `backstage/calendar/` and
`Contacts/Address Book/` is the helper's; everything else is yours. Meetings are
in backstage, so Slate keeps them out of search, lists, ⌘K and mentions and
shows them on the agenda only.

| File | Shows | Design |
| --- | --- | --- |
| `backstage/calendar/Fastmail/2026/09/Design review (b361).md` | A timed, floating event with every blessed key, and attendees: a matched contact as a link, an unmatched one as plain text. | §2.1, §6.4 |
| `backstage/calendar/Fastmail/2026/09/Office closed (3a77).md` | An all-day event over two days. `end` is **inclusive**: iCalendar's `DTEND:20260923` becomes `end: 2026-09-22`. | §3 |
| `backstage/calendar/Work/2026/10/Tokyo sync (43ce).md` | A zoned event. `start`/`end` are Tokyo wall clock; west of Tokyo it lands on 30 September, and is filed in October's folder because the folder follows the file. A second account. | §3, §2.1 |
| `Contacts/Address Book/Fastmail/Jane Doe.md` | A contact, with `aliases:` so old names still resolve. | §2.2, §4.4 |
| `Contacts/Address Book/Work/Jane Doe (Example Corp).md` | The same name arriving from a second account, disambiguated across the whole vault by `org`. | §2.2 |
| `Calendar/2026/09/Design review - 2026-09-21.md` | Your notes on a meeting, as *Write notes* makes them: `date:`, a `meeting:` link back by path (a backstage note has no name a bare link reaches), the meeting's `attendees:` copied in, and no `start:`. These are what put the meeting in Jane's mentions. | §5.5 |
| `Calendar/2026/09/Standup - 2026-09-22.md` | A meeting you detached: no `source:` or `uid:`, filed and named as a hand-made event. | §5.5 |

**Names.** An imported event is `<title> (<tag>)`, where the tag is the first
four lowercase hex digits of the SHA-256 of its `uid` (UTF-8), lengthened a
digit at a time — up to eight — only if another file in the same folder already
has it. `3f2a9c@fastmail.com` → `b36177ac…` → `(b361)`.

**What is deliberately not here.** No `synced_at:`, `generated:` or any other
timestamp: the files must come out identical on every run (§6.5).
