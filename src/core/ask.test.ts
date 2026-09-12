/**
 * The conversation, as a file.
 *
 * Two things here are load-bearing and the rest is prompt text. `readTurns` is
 * how a follow-up question knows what was already asked — and it reads the
 * *file*, including whatever you edited or deleted by hand, so it has to cope
 * with a note somebody has been through with a pen. `parseTerms` is the one
 * reply in this feature whose shape nothing downstream can check: a model that
 * answers in a sentence instead of a list yields search terms that match
 * nothing, and the symptom is an answer that says your notes are empty.
 */

import { describe, expect, it } from 'vitest'
import {
  ALL,
  answerSystem,
  appendTurn,
  citedNotes,
  citedWithoutReading,
  isDerived,
  conversationTitle,
  dropLastTurn,
  lastTurn,
  termsInCallout,
  historyFor,
  isConversation,
  newConversation,
  openTurn,
  noteScope,
  noteScopeRule,
  parseTerms,
  pinTitle,
  pinsOf,
  provenanceCallout,
  readTurns,
  sourceDescription,
  sourceLabel,
  sourceOf,
  withPins,
} from './ask'
import { parseFrontmatter, scanWikiLinks } from './markdown'

describe('what makes a note a conversation', () => {
  it('is the frontmatter, and nothing else', () => {
    expect(isConversation('---\ntype: conversation\n---\n\n# Ask\n')).toBe(true)
    expect(isConversation('---\ntype: Conversation\n---\n')).toBe(true)
    expect(isConversation('---\ntype: meeting\n---\n')).toBe(false)
    expect(isConversation('# Just a note\n\nAbout a conversation.\n')).toBe(false)
    expect(isConversation('')).toBe(false)
  })

  it('reads the scope back, defaulting to the whole vault', () => {
    expect(sourceOf('---\ntype: conversation\nsource: "#work"\n---\n')).toBe('#work')
    expect(sourceOf('---\ntype: conversation\n---\n')).toBe(ALL)
    expect(sourceLabel(ALL)).toBe('All notes')
    expect(sourceLabel('#work')).toBe('#work')
  })
})

describe('what retrieval refuses to read', () => {
  it('excludes conversations, which would otherwise read themselves back', () => {
    // A conversation is the strongest keyword match for its own questions.
    expect(isDerived('---\ntype: conversation\n---\n\n## Why?\n\nBecause.\n')).toBe(true)
  })

  it('excludes summaries, which are a paraphrase of notes already in scope', () => {
    expect(isDerived('---\ngenerated: true\nsource: "#work"\n---\n\nAn overview.\n')).toBe(true)
  })

  it('leaves everything you wrote yourself alone', () => {
    expect(isDerived('# Migration plan\n\nWhat we are doing.\n')).toBe(false)
    expect(isDerived('---\ntags: [work]\ngenerated: false\n---\n\nMine.\n')).toBe(false)
    expect(isDerived('')).toBe(false)
  })
})

describe('the note a conversation starts as', () => {
  const now = new Date('2026-09-12T09:00:00Z')

  it('says what it is and what it may read', () => {
    const n = newConversation({ question: 'What went wrong with the migration?', source: '#work', now })
    expect(n.text).toContain('type: conversation')
    expect(isConversation(n.text)).toBe(true)
    expect(sourceOf(n.text)).toBe('#work')
  })

  it('quotes a rule that would otherwise read as a YAML comment', () => {
    // `source: #work` parses as an empty value — the tag becomes a comment, and
    // the conversation silently widens to the whole vault.
    const n = newConversation({ question: 'q', source: '#work', now })
    expect(n.text).toContain('source: "#work"')
    expect(parseFrontmatter(n.text).data.source).toBe('#work')
  })

  it('leaves a plain rule unquoted', () => {
    expect(newConversation({ question: 'q', source: ALL, now }).text).toContain('source: all')
  })

  /* What "ask about this note" starts: the note is guaranteed from turn one. */
  it('can start pinned to a note, without disturbing anything else', () => {
    const n = newConversation({ question: 'q', source: ALL, now, pins: ['Migration plan'] })
    expect(pinsOf(n.text)).toEqual(['Migration plan'])
    expect(isConversation(n.text)).toBe(true)
    expect(sourceOf(n.text)).toBe(ALL)
    expect(n.text).toContain('# Ask — q')
  })

  it('starts with no include key at all when nothing is pinned', () => {
    expect(newConversation({ question: 'q', source: ALL, now }).text).not.toContain('include')
  })

  it('names itself after the first question', () => {
    expect(conversationTitle('What went wrong?')).toBe('Ask — What went wrong')
    expect(conversationTitle('  spaced   out  question ')).toBe('Ask — spaced out question')
  })

  it('trims a long question at a word rather than mid-word', () => {
    const question = 'What did we decide about the database migration and the rollback'
    const t = conversationTitle(question, 40)
    expect(t).toMatch(/…$/)
    // The kept part must end where a word does — checked against the question
    // itself, since "ends in a letter then an ellipsis" is true of any trim.
    const kept = t.replace(/^Ask — /, '').replace(/…$/, '')
    expect(question.startsWith(kept)).toBe(true)
    expect(question[kept.length]).toBe(' ')
  })

  it('always produces something usable as a file name', () => {
    expect(conversationTitle('???')).toBe('Ask — your notes')
    expect(conversationTitle('')).toBe('Ask — your notes')
  })
})

describe('reading the conversation back out of the file', () => {
  const note = [
    '---',
    'type: conversation',
    '---',
    '',
    '# Ask — the migration',
    '',
    '## What went wrong?',
    '',
    'Two indexes had to be rebuilt — see [[Postmortem]].',
    '',
    '> [!note]- Searched “migrat” · read [[Postmortem]]',
    '> 3 notes matched.',
    '',
    '## Was it written up?',
    '',
    'No.',
    '',
  ].join('\n')

  it('pairs each question with its answer', () => {
    const turns = readTurns(note)
    expect(turns).toHaveLength(2)
    expect(turns[0].question).toBe('What went wrong?')
    expect(turns[0].answer).toBe('Two indexes had to be rebuilt — see [[Postmortem]].')
    expect(turns[1].answer).toBe('No.')
  })

  it('leaves the provenance callouts out', () => {
    // They are for a reader. Feeding them back would spend the context window
    // describing past searches to a model that needs the answers.
    expect(readTurns(note)[0].answer).not.toContain('Searched')
  })

  it('ignores the title and the frontmatter', () => {
    expect(readTurns(note).some((t) => t.question.includes('Ask —'))).toBe(false)
    expect(readTurns(note).some((t) => t.answer.includes('type:'))).toBe(false)
  })

  it('copes with a note that has been edited by hand', () => {
    // The file is the record, so deleting an answer is a supported thing to do.
    const edited = note.replace('Two indexes had to be rebuilt — see [[Postmortem]].', '')
    const turns = readTurns(edited)
    expect(turns).toHaveLength(2)
    expect(turns[0].answer).toBe('')
  })

  it('returns nothing for a conversation with no turns yet', () => {
    expect(readTurns('---\ntype: conversation\n---\n\n# Ask — nothing\n')).toEqual([])
  })

  it('carries only the last few turns forward, as text', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ question: `Q${i}`, answer: `A${i}` }))
    const h = historyFor(many, 3)
    expect(h).toContain('Q5')
    expect(h).toContain('Q3')
    expect(h).not.toContain('Q2')
    expect(historyFor([], 3)).toBe('')
  })
})

describe('the search terms a model comes back with', () => {
  it('takes a plain comma list', () => {
    expect(parseTerms('migration, rollback, index rebuild')).toEqual([
      'migration',
      'rollback',
      'index rebuild',
    ])
  })

  it('takes a bulleted or numbered list, markers and all', () => {
    expect(parseTerms('- migration\n- rollback')).toEqual(['migration', 'rollback'])
    expect(parseTerms('1. migration\n2. rollback')).toEqual(['migration', 'rollback'])
  })

  it('unwraps a fence and strips quoting', () => {
    expect(parseTerms('```\n"migration", "rollback"\n```')).toEqual(['migration', 'rollback'])
  })

  it('salvages terms from a model that would not stop talking', () => {
    // The failure this exists for: a sentence fed to the search box matches
    // nothing, and the symptom is "your notes do not mention it".
    expect(parseTerms('Sure! I would search for:\nmigration\nrollback')).toContain('migration')
  })

  it('drops anything too long to be a search term', () => {
    const wordy = parseTerms('migration, I would also look for anything about the database at all')
    expect(wordy).toEqual(['migration'])
  })

  it('caps how many it returns, and never repeats one', () => {
    expect(parseTerms('a, b, c, d, e, f')).toHaveLength(4)
    expect(parseTerms('migration, Migration, rollback')).toEqual(['migration', 'rollback'])
  })

  it('returns nothing when there was nothing usable', () => {
    expect(parseTerms('')).toEqual([])
    expect(parseTerms('I am afraid I cannot help with that particular request today sorry')).toEqual([])
  })
})

describe('reading a turn back, to ask it again', () => {
  const note = [
    '---',
    'type: conversation',
    '---',
    '',
    '# Ask — x',
    '',
    '## First question?',
    '',
    'First answer.',
    '',
    '> [!note]- Searched “alpha”, “beta” · read [[A]]',
    '',
    '## Second question?',
    '',
    'Second answer.',
    '',
    '> [!note]- Searched “gamma” · read [[B]]',
    '',
  ].join('\n')

  it('finds the last question and what it searched for', () => {
    const last = lastTurn(note)
    expect(last?.question).toBe('Second question?')
    expect(last?.terms).toEqual(['gamma'])
  })

  it('does not carry the previous turn’s terms into the last one', () => {
    // The scan has to reset per heading, or a turn whose callout was deleted
    // would silently inherit the terms of the turn before it.
    const trimmed = note.replace('> [!note]- Searched “gamma” · read [[B]]\n', '')
    expect(lastTurn(trimmed)?.terms).toEqual([])
  })

  it('reads terms out of a callout, quotes and all', () => {
    expect(termsInCallout('> [!note]- Searched “a b”, “c” · read [[X]]')).toEqual(['a b', 'c'])
    expect(termsInCallout('> [!note]- No search terms · read nothing')).toEqual([])
  })

  it('takes the last exchange off, leaving everything before it', () => {
    const dropped = dropLastTurn(note)
    expect(dropped).toContain('## First question?')
    expect(dropped).toContain('First answer.')
    expect(dropped).not.toContain('Second question?')
    expect(dropped).not.toContain('gamma')
    expect(readTurns(dropped)).toHaveLength(1)
  })

  it('leaves a conversation with no turns exactly as it is', () => {
    const empty = '---\ntype: conversation\n---\n\n# Ask — x\n'
    expect(lastTurn(empty)).toBeUndefined()
    expect(dropLastTurn(empty)).toBe(empty)
  })

  it('round-trips: drop the last turn, write it again, and the note matches', () => {
    const again = appendTurn(dropLastTurn(note), {
      question: 'Second question?',
      answer: 'Second answer.',
      provenance: { terms: ['gamma'], matched: 1, read: ['B'], tokens: 10, dropped: 0, beyondLimit: 0, limit: 6 },
    })
    expect(readTurns(again)).toHaveLength(2)
    expect(lastTurn(again)?.terms).toEqual(['gamma'])
  })
})

describe('writing a turn into the note', () => {
  const base = '---\ntype: conversation\n---\n\n# Ask — x\n'

  it('adds the question as a heading and the answer under it', () => {
    const out = appendTurn(base, { question: 'Why?', answer: 'Because.' })
    expect(out).toContain('## Why?')
    expect(out).toContain('Because.')
    expect(readTurns(out)).toHaveLength(1)
  })

  it('never disturbs what is already in the note', () => {
    const out = appendTurn(base, { question: 'Why?', answer: 'Because.' })
    expect(out.startsWith(base.replace(/\s+$/, ''))).toBe(true)
  })

  it('does not open a widening gap turn after turn', () => {
    let text = base
    for (let i = 0; i < 3; i++) text = appendTurn(text, { question: `Q${i}`, answer: `A${i}` })
    expect(text).not.toMatch(/\n{3}/)
    expect(readTurns(text)).toHaveLength(3)
  })

  it('flattens a question typed across several lines', () => {
    // A heading is one line by definition; a pasted multi-line question would
    // otherwise put half of itself in the answer.
    const out = appendTurn(base, { question: 'Why\nis\nthis?', answer: 'Because.' })
    expect(out).toContain('## Why is this?')
    expect(readTurns(out)[0].answer).toBe('Because.')
  })

  it('opens a turn with just the heading, for the answer to stream under', () => {
    const opened = openTurn(base, 'Why?')
    expect(opened.endsWith('## Why?\n\n')).toBe(true)
    expect(readTurns(opened)).toEqual([{ question: 'Why?', answer: '' }])
  })
})

/*
 * `include:` is hand-editable by design, so the reader has to cope with every
 * way somebody might reasonably write a note's name — and the writer has to
 * produce something a rename can find, because a pin that silently stops
 * pinning is the failure this whole feature has to avoid.
 */
/*
 * The Tag Folder language has no way to say "this note" — it is about tags and
 * folders, and this is about the graph. These two rules exist because "ask
 * about this note" answering from the whole vault reads as a bug: you name a
 * note and back comes an answer citing four others that happened to share a
 * word with the question.
 */
describe('scoping a conversation to one note', () => {
  it('reads both rules, title and all', () => {
    expect(noteScope('note:Migration plan')).toEqual({ kind: 'note', title: 'Migration plan' })
    expect(noteScope('links:Migration plan')).toEqual({ kind: 'links', title: 'Migration plan' })
  })

  it('is not confused by an ordinary rule', () => {
    expect(noteScope('#work')).toBeUndefined()
    expect(noteScope('folder:Projects')).toBeUndefined()
    expect(noteScope(ALL)).toBeUndefined()
    expect(noteScope('')).toBeUndefined()
  })

  it('ignores a prefix with no note after it', () => {
    expect(noteScope('note:')).toBeUndefined()
    expect(noteScope('links:   ')).toBeUndefined()
  })

  it('keeps the title’s own case while matching the prefix loosely', () => {
    expect(noteScope('NOTE:Migration Plan')).toEqual({ kind: 'note', title: 'Migration Plan' })
  })

  /* A title with a colon in it is a note name, not a second prefix. */
  it('takes everything after the first colon as the title', () => {
    expect(noteScope('note:Q3: what happened')).toEqual({ kind: 'note', title: 'Q3: what happened' })
  })

  it('round-trips through the rule it writes', () => {
    for (const kind of ['note', 'links'] as const) {
      const rule = noteScopeRule(kind, 'Migration plan')
      expect(noteScope(rule)).toEqual({ kind, title: 'Migration plan' })
    }
  })

  it('survives the frontmatter it is stored in', () => {
    const n = newConversation({
      question: 'q',
      source: noteScopeRule('links', 'Migration plan'),
      now: new Date('2026-09-12T09:00:00Z'),
    })
    expect(sourceOf(n.text)).toBe('links:Migration plan')
    expect(noteScope(sourceOf(n.text))?.title).toBe('Migration plan')
  })

  it('says what it means, in a chip and in a sentence', () => {
    expect(sourceLabel('note:Migration plan')).toBe('Only Migration plan')
    expect(sourceLabel('links:Migration plan')).toBe('Migration plan + links')
    expect(sourceDescription('note:Migration plan')).toBe('“Migration plan” and nothing else')
    expect(sourceDescription('links:Migration plan')).toBe('“Migration plan” and its links')
  })

  /*
   * The prose used to lowercase whatever the chip said, which is right for
   * `all notes` and `#work` and wrong the moment a rule carries a note title.
   */
  it('does not mangle a title’s capitals in prose', () => {
    expect(sourceDescription('note:NASA Debrief')).toContain('NASA Debrief')
    expect(sourceDescription(ALL)).toBe('all notes')
    expect(sourceDescription('#work')).toBe('#work')
  })
})

describe('the notes a conversation pins', () => {
  const conv = (...fm: string[]) => ['---', 'type: conversation', ...fm, '---', '', '# Ask', ''].join('\n')

  it('reads a block list of wikilinks', () => {
    expect(pinsOf(conv('include:', '  - "[[Migration plan]]"', '  - "[[Team charter]]"'))).toEqual([
      'Migration plan',
      'Team charter',
    ])
  })

  it('takes a bare title, an embed, an alias or an anchor — a pin is the note', () => {
    expect(pinTitle('Migration plan')).toBe('Migration plan')
    expect(pinTitle('[[Migration plan]]')).toBe('Migration plan')
    expect(pinTitle('![[Migration plan]]')).toBe('Migration plan')
    expect(pinTitle('[[Migration plan#Rollback]]')).toBe('Migration plan')
    expect(pinTitle('[[Migration plan|the plan]]')).toBe('Migration plan')
  })

  it('takes a single value as a list of one', () => {
    expect(pinsOf(conv('include: "[[Migration plan]]"'))).toEqual(['Migration plan'])
  })

  it('is empty when there is no key, and drops blanks', () => {
    expect(pinsOf(conv())).toEqual([])
    expect(pinsOf(conv('include:', '  - "[[]]"', '  - "[[A]]"'))).toEqual(['A'])
  })

  it('does not pin the same note twice under two spellings', () => {
    expect(pinsOf(conv('include:', '  - "[[Plan]]"', '  - "[[plan]]"'))).toEqual(['Plan'])
  })

  it('writes links a rename can find, and reads them back unchanged', () => {
    const out = withPins(conv(), ['Migration plan', 'Team charter'])
    expect(scanWikiLinks(out).map((l) => l.target)).toEqual(['Migration plan', 'Team charter'])
    expect(pinsOf(out)).toEqual(['Migration plan', 'Team charter'])
    expect(sourceOf(out)).toBe(ALL)
    expect(isConversation(out)).toBe(true)
  })

  it('survives a comma in a note name', () => {
    const out = withPins(conv(), ['Plan, revised'])
    expect(pinsOf(out)).toEqual(['Plan, revised'])
  })

  it('unpins everything without taking the rest of the frontmatter with it', () => {
    const pinned = withPins(conv('source: "#work"'), ['A'])
    const bare = withPins(pinned, [])
    expect(pinsOf(bare)).toEqual([])
    expect(sourceOf(bare)).toBe('#work')
    expect(isConversation(bare)).toBe(true)
  })
})

/*
 * The citation rule was an instruction and nothing more: "never invent a note
 * title", with nothing checking. That gap is the one that matters, because a
 * fabricated citation renders identically to a real one — same brackets, same
 * colour — until somebody clicks it, long after the answer has been believed.
 */
describe('checking what an answer cited', () => {
  it('reads the notes an answer claims to have used', () => {
    expect(citedNotes('Per [[Migration plan]] and [[Postmortem]], it was the indexes.')).toEqual([
      'Migration plan',
      'Postmortem',
    ])
  })

  it('counts a note once however many times it is cited', () => {
    expect(citedNotes('[[A]] says one thing and [[a]] says another, but [[A]] is clear.')).toEqual(['A'])
  })

  it('treats a link into a heading as a citation of the note', () => {
    expect(citedNotes('See [[Migration plan#Rollback]] and [[Postmortem|the writeup]].')).toEqual([
      'Migration plan',
      'Postmortem',
    ])
  })

  it('says nothing about an answer that cited only what it was given', () => {
    const answer = 'The indexes were the problem — see [[Migration plan]].'
    expect(citedWithoutReading(answer, ['Migration plan', 'Postmortem'])).toEqual([])
  })

  it('catches a citation of a note that was never sent', () => {
    const answer = 'It was the indexes ([[Migration plan]]), and the rollback ([[Runbook]]).'
    expect(citedWithoutReading(answer, ['Migration plan'])).toEqual(['Runbook'])
  })

  it('matches what was sent without caring about case', () => {
    expect(citedWithoutReading('See [[migration PLAN]].', ['Migration plan'])).toEqual([])
  })

  /* A citation whose spelling drifted is still a link that goes nowhere. */
  it('reports a near miss rather than forgiving it', () => {
    expect(citedWithoutReading('See [[Migration plans]].', ['Migration plan'])).toEqual([
      'Migration plans',
    ])
  })

  it('ignores a code sample that happens to contain brackets', () => {
    expect(citedNotes('Answer.\n\n```\nconst x = [[Not a note]]\n```\n')).toEqual([])
  })
})

describe('what the answering model is told it has', () => {
  it('describes a plain search plainly', () => {
    const s = answerSystem('#work')
    expect(s).toContain('the notes that matched a search of #work')
    expect(s).not.toContain('every question')
  })

  /* A pinned note matched nothing; calling it a search hit would be a small lie. */
  it('does not pass a pinned note off as something the search found', () => {
    const s = answerSystem('#work', 2)
    expect(s).toContain('2 notes the person keeps in front of you for every question')
    expect(s).toContain('followed by the notes that matched a search of #work')
  })

  it('counts one pin in the singular', () => {
    expect(answerSystem('All notes', 1)).toContain('1 note the person keeps')
  })
})

describe('the provenance callout', () => {
  it('is folded, so it is in the file without being in the way', () => {
    const c = provenanceCallout({ terms: ['migrat'], matched: 3, read: ['Postmortem'], tokens: 900, dropped: 0, beyondLimit: 0, limit: 6 })
    expect(c.startsWith('> [!note]-')).toBe(true)
  })

  it('names the terms and cites what was read as links', () => {
    const c = provenanceCallout({
      terms: ['migrat', 'rollback'],
      matched: 5,
      read: ['Migration plan', 'Postmortem'],
      tokens: 2100,
      dropped: 0,
      beyondLimit: 0,
      limit: 6,
    })
    expect(c).toContain('“migrat”, “rollback”')
    expect(c).toContain('[[Migration plan]]')
    expect(c).toContain('5 notes matched')
  })

  it('says when the context budget cut notes out, and what to do about it', () => {
    const c = provenanceCallout({ terms: ['x'], matched: 9, read: ['A'], tokens: 800, dropped: 3, beyondLimit: 0, limit: 6 })
    expect(c).toContain('3 did not fit the context budget')
    expect(c).toContain('Settings → AI')
  })

  /*
   * The silence this replaced: twenty notes match, the best six are sent, and
   * the callout used to report "20 matched; 6 sent" with nothing at all about
   * the fourteen it never opened — the one number that would have told you the
   * search was not the weak link, the limit was.
   */
  it('says when the limit cut the list before the budget saw it', () => {
    const c = provenanceCallout({ terms: ['x'], matched: 20, read: ['A'], tokens: 800, dropped: 0, beyondLimit: 14, limit: 6 })
    expect(c).toContain('20 notes matched')
    expect(c).toContain('14 more were past the limit of 6')
    expect(c).toContain('Notes per question')
  })

  it('names both when both cut, because they are different problems', () => {
    const c = provenanceCallout({ terms: ['x'], matched: 20, read: ['A'], tokens: 800, dropped: 5, beyondLimit: 14, limit: 6 })
    expect(c).toContain('5 did not fit the context budget')
    expect(c).toContain('14 more were past the limit')
  })

  it('says neither when nothing was cut', () => {
    const c = provenanceCallout({ terms: ['x'], matched: 2, read: ['A', 'B'], tokens: 800, dropped: 0, beyondLimit: 0, limit: 6 })
    expect(c).not.toContain('did not fit')
    expect(c).not.toContain('past the limit')
  })

  it('is honest when a search found nothing', () => {
    const c = provenanceCallout({ terms: ['x'], matched: 0, read: [], tokens: 0, dropped: 0, beyondLimit: 0, limit: 6 })
    expect(c).toContain('read nothing')
    expect(c).toContain('0 notes matched')
  })

  it('marks which of the notes it read were there because they are pinned', () => {
    const c = provenanceCallout({
      terms: ['migrat'],
      matched: 3,
      read: ['Migration plan', 'Postmortem'],
      tokens: 900,
      dropped: 0,
      beyondLimit: 0,
      limit: 6,
      pinned: ['Migration plan'],
    })
    expect(c).toContain('[[Migration plan]] (pinned)')
    expect(c).toContain('[[Postmortem]]')
    expect(c).not.toContain('[[Postmortem]] (pinned)')
  })

  /*
   * The most important line in the callout. A pin that quietly stops pinning
   * produces answers that look exactly as normal as ones that had read the
   * note, and you would go on believing they had.
   */
  it('names a pin that no longer resolves, rather than skipping it', () => {
    const c = provenanceCallout({
      terms: ['x'],
      matched: 2,
      read: ['A'],
      tokens: 400,
      dropped: 0,
      beyondLimit: 0,
      limit: 6,
      missingPins: ['Team charter'],
    })
    expect(c).toContain('Pinned but not found: “Team charter”')
    expect(c).toContain('renamed or deleted')
    // Quoted, not linked: a link that is broken on purpose would put every
    // stale pin into the broken-link report too.
    expect(c).not.toContain('[[Team charter]]')
  })

  it('says when a pin was resolved and still did not get sent', () => {
    const c = provenanceCallout({
      terms: ['x'],
      matched: 4,
      read: ['A'],
      tokens: 400,
      dropped: 2,
      beyondLimit: 0,
      limit: 6,
      pinned: ['A'],
      pinsSkipped: 2,
    })
    expect(c).toContain('2 pinned notes did not fit')
    expect(c).toContain('Notes per question')
  })

  it('says when the pins alone used up the limit', () => {
    const c = provenanceCallout({
      terms: ['x'],
      matched: 9,
      read: ['A', 'B'],
      tokens: 900,
      dropped: 0,
      beyondLimit: 9,
      limit: 2,
      pinned: ['A', 'B'],
      pinsSkipped: 0,
    })
    expect(c).toContain('is taken up by pins')
    expect(c).toContain('nothing the search found was sent')
  })

  it('names a citation the model was never given, and links it when it is real', () => {
    const c = provenanceCallout({
      terms: ['x'],
      matched: 2,
      read: ['Migration plan'],
      tokens: 400,
      dropped: 0,
      beyondLimit: 0,
      limit: 6,
      citedNotRead: ['Runbook'],
    })
    expect(c).toContain('Cited without reading: [[Runbook]]')
    expect(c).toContain('not one of the ones sent')
  })

  it('quotes an invented title rather than linking it', () => {
    const c = provenanceCallout({
      terms: ['x'],
      matched: 2,
      read: ['Migration plan'],
      tokens: 400,
      dropped: 0,
      beyondLimit: 0,
      limit: 6,
      citedNotFound: ['Postmortem 2026-08-14'],
    })
    expect(c).toContain('Cited but no such note: “Postmortem 2026-08-14”')
    expect(c).toContain('the name was invented')
    // The answer above it already carries the model's broken link; a second one
    // here would put the same non-existent note in the report twice.
    expect(c).not.toContain('[[Postmortem 2026-08-14]]')
  })

  it('says nothing about citations when every one of them was read', () => {
    const c = provenanceCallout({
      terms: ['x'],
      matched: 2,
      read: ['A'],
      tokens: 400,
      dropped: 0,
      beyondLimit: 0,
      limit: 6,
      citedNotRead: [],
      citedNotFound: [],
    })
    expect(c).not.toContain('Cited')
  })

  it('says nothing about pins on a conversation that has none', () => {
    const c = provenanceCallout({ terms: ['x'], matched: 2, read: ['A'], tokens: 400, dropped: 0, beyondLimit: 0, limit: 6 })
    expect(c).not.toContain('pinned')
    expect(c).not.toContain('pins')
  })
})
