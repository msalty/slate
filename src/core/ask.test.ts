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
  appendTurn,
  isDerived,
  conversationTitle,
  historyFor,
  isConversation,
  newConversation,
  openTurn,
  parseTerms,
  provenanceCallout,
  readTurns,
  sourceLabel,
  sourceOf,
} from './ask'
import { parseFrontmatter } from './markdown'

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

describe('the provenance callout', () => {
  it('is folded, so it is in the file without being in the way', () => {
    const c = provenanceCallout({ terms: ['migrat'], matched: 3, read: ['Postmortem'], tokens: 900, dropped: 0 })
    expect(c.startsWith('> [!note]-')).toBe(true)
  })

  it('names the terms and cites what was read as links', () => {
    const c = provenanceCallout({
      terms: ['migrat', 'rollback'],
      matched: 5,
      read: ['Migration plan', 'Postmortem'],
      tokens: 2100,
      dropped: 0,
    })
    expect(c).toContain('“migrat”, “rollback”')
    expect(c).toContain('[[Migration plan]]')
    expect(c).toContain('5 notes matched')
  })

  it('says when the budget cut notes out, and what to do about it', () => {
    const c = provenanceCallout({ terms: ['x'], matched: 9, read: ['A'], tokens: 800, dropped: 3 })
    expect(c).toContain('3 more matched')
    expect(c).toContain('context budget')
  })

  it('is honest when a search found nothing', () => {
    const c = provenanceCallout({ terms: ['x'], matched: 0, read: [], tokens: 0, dropped: 0 })
    expect(c).toContain('read nothing')
    expect(c).toContain('0 notes matched')
  })
})
