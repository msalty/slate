/**
 * The templates `Templates/` is created with.
 *
 * A starter set rather than a lone example, because the feature is invisible
 * until the folder exists and someone who has just asked for templates is
 * looking at a folder, not at a manual. Seven notes in it answer the two
 * questions an empty one leaves — what does a template look like, and what is
 * it for — in the only place the answer sticks: the vault, where each of them
 * can be opened, rewritten, renamed or deleted like the ordinary notes they
 * are.
 *
 * They are written to be *edited*. Nothing here is a schema and nothing reads
 * these keys back: a property is a row in the note's own form, so the fields
 * are the ones worth having in front of you when the note is new, and a field
 * that never gets filled in is a row to delete rather than a rule being broken.
 *
 * Three conventions run through all of them, and they are the ones worth
 * copying into a template of your own:
 *
 *   - `# {{title}}{{cursor}}` — the heading is filled in for a note that is
 *     named already (a daily note, one made from a `[[link]]`) and left empty
 *     with the caret in it for one that is not.
 *   - An empty `- `, `- [ ] ` or table row is a blank to fill in: one
 *     keystroke to delete, and no reach for the formatting bar to start.
 *     The trailing space is not an accident — GFM draws a checkbox only when
 *     something follows the brackets, so `- [ ]` with nothing after it is the
 *     literal text "[ ]" in every renderer, this one included.
 *   - Frontmatter carries what the note *is*; the body carries what happened.
 *     A list field (`attendees: []`) is typed as "Ana, Bo" in the properties
 *     form, so an empty list is an invitation rather than a puzzle.
 */

export interface StarterTemplate {
  /** The note's name in `Templates/`, and so what the pickers show. */
  name: string
  text: string
}

/**
 * The daily note, which is the case folder templates were built for: point
 * `Daily/` at this one and every day starts the same way, dated for the day it
 * is filed under rather than for today.
 *
 * `{{cursor}}` sits on the first task rather than in the heading, because the
 * heading is already written — the note knows what day it is — and the first
 * thing anybody does with a daily note is write down the thing they have to do.
 */
const DAILY = `---
date: {{date}}
tags: [daily]
mood:
energy:
---

# {{weekday}}, {{date:D MMMM YYYY}}

## Today

- [ ] {{cursor}}

## Notes

## Log

- {{time}} —

## Habits

- [ ] Move
- [ ] Read
- [ ] Inbox to zero

## Tomorrow

- [ ] 

## One good thing

`

/**
 * A meeting, with the fields that decide whether the note is findable a year
 * later — who it was with and what it was about — above the ones that only
 * matter in the room.
 *
 * Attendees are plain names in a list field, so they can be typed on a phone
 * in one go. Link the ones who have a note of their own in the body instead:
 * a `[[Ana Ruiz]]` in the notes puts this meeting in her backlinks, which is
 * the half of the wiring that a frontmatter field cannot do.
 */
const MEETING = `---
date: {{date}}
time: {{time}}
tags: [meeting]
client:
project:
attendees: []
location:
---

# {{title}}{{cursor}}

**{{date:DDDD, D MMMM YYYY}} · {{time}}**

## Agenda

1. 

## Notes

## Decisions

> [!IMPORTANT] Decided
> One line each, in the words you would send in the follow-up.

## Actions

- [ ] 

## Follow-up

- 
`

/**
 * A person, with the fields a vCard carries — vCard being the one contact
 * schema everything from a phone's address book to a CRM already agrees on,
 * so a note written this way is one export away from anywhere else.
 *
 * `email` and `phone` are lists because vCard allows several of each; the
 * address is split the way `ADR` is, so a note can be read back into one
 * without guessing where the street ended. What vCard calls `NOTE` is the body
 * of the note, which is the point of keeping people in a notes app at all.
 */
const PERSON = `---
tags: [person]
name: {{title}}
nickname:
org:
department:
role:
email: []
phone: []
website:
street:
city:
region:
postcode:
country:
timezone:
birthday:
anniversary:
social: []
assistant:
partner:
date: {{date}}
---

# {{title}}{{cursor}}

> [!NOTE] In one line
> How you would introduce them.

## Context

Where you met, who introduced you, what they are working on.

## Threads

- 

## Tasks

- [ ] 

## History

- {{date}} — added
`

/**
 * A project, which is the note a folder of notes hangs off. Frontmatter says
 * whether it is alive and who owns it; the milestone table is the thing worth
 * having in one place rather than spread over a month of daily notes.
 */
const PROJECT = `---
tags: [project]
status: active
owner:
client:
started: {{date}}
due:
stakeholders: []
---

# {{title}}{{cursor}}

> [!ABSTRACT] Outcome
> What is true when this is done.

## Milestones

| Milestone | Date | Status |
| --- | --- | --- |
|  |  |  |

## Tasks

- [ ] 

## Risks

> [!WARNING] Watch
> What would make this late, and what you would do about it.

## Notes

## Log

- {{date}} — opened
`

/**
 * A decision, written down while the reasons are still in the room.
 *
 * The shape is the one architecture decision records use, and the reason it is
 * here rather than in a wiki somewhere is `status:` — a decision that has been
 * superseded is worth finding as a decision that has been superseded, not
 * worth deleting.
 */
const DECISION = `---
tags: [decision]
date: {{date}}
status: proposed
owner:
supersedes:
---

# {{title}}{{cursor}}

> [!QUESTION] The question
> One sentence, in the present tense.

## Context

What is true today that makes this a decision at all.

## Options

### Option A

- For:
- Against:

### Option B

- For:
- Against:

## Decision

> [!IMPORTANT] Chosen
> Which option, and the reason that actually decided it.

## Consequences

- 

## Revisit when

- 
`

/**
 * Something read, and what came of it. `status:` and `rating:` are what turn a
 * pile of these into a shelf you can look along; the highlights are ordinary
 * blockquotes, so they paste out of here into anything.
 */
const READING = `---
tags: [reading]
author:
kind: book
source:
status: reading
started: {{date}}
finished:
rating:
---

# {{title}}{{cursor}}

> [!ABSTRACT] The argument in one line
> What it is claiming, rather than what it is about.

## Why I picked it up

## Highlights

## Takeaways

- 

## Tasks

- [ ] 
`

/**
 * The week, read back. It pairs with the daily note: the daily one is written
 * forwards and this one is written looking back over seven of them, which is
 * why "rolled over" is a task list rather than a paragraph.
 */
const WEEKLY = `---
date: {{date}}
tags: [review, weekly]
---

# Week ending {{date:D MMMM YYYY}}

> [!SUMMARY] The week in one line
> {{cursor}}

## Went well

- 

## Did not

- 

## Rolled over

- [ ] 

## Next week

- [ ] 

## Notes
`

/**
 * The set, in the order the folder will show them once they are sorted by
 * name — near enough — and with the daily note first, because it is the one
 * that gets opened after the button is pressed.
 */
export const STARTER_TEMPLATES: StarterTemplate[] = [
  { name: 'Daily Note', text: DAILY },
  { name: 'Meeting', text: MEETING },
  { name: 'Person', text: PERSON },
  { name: 'Project', text: PROJECT },
  { name: 'Decision', text: DECISION },
  { name: 'Reading', text: READING },
  { name: 'Weekly Review', text: WEEKLY },
]
