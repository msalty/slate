import { describe, expect, it } from 'vitest'
import { merge3 } from './merge'

const base = ['# Trip', '', 'Flights booked.', 'Hotel pending.', '', 'Notes here.'].join('\n')

describe('merge3', () => {
  it('returns the single changed side when only one moved', () => {
    const mine = base.replace('Hotel pending.', 'Hotel booked.')
    expect(merge3(base, mine, base).merged).toBe(mine)
    expect(merge3(base, base, mine).merged).toBe(mine)
    expect(merge3(base, base, mine).conflict).toBe(false)
  })

  it('is a no-op when both sides made the same edit', () => {
    const same = `${base}\nSame line.`
    const r = merge3(base, same, same)
    expect(r.merged).toBe(same)
    expect(r.conflict).toBe(false)
  })

  it('combines edits that touch different regions', () => {
    const mine = base.replace('Flights booked.', 'Flights booked and paid.')
    const theirs = base.replace('Notes here.', 'Notes here. Pack sunscreen.')
    const r = merge3(base, mine, theirs)
    expect(r.conflict).toBe(false)
    expect(r.merged).toContain('Flights booked and paid.')
    expect(r.merged).toContain('Pack sunscreen.')
    expect(r.merged).toContain('Hotel pending.')
  })

  it('combines an append on one side with an edit on the other', () => {
    const mine = `${base}\n- [ ] Renew passport`
    const theirs = base.replace('# Trip', '# Trip to Lisbon')
    const r = merge3(base, mine, theirs)
    expect(r.conflict).toBe(false)
    expect(r.merged).toContain('# Trip to Lisbon')
    expect(r.merged).toContain('Renew passport')
  })

  it('reports a conflict when both sides rewrote the same line', () => {
    const mine = base.replace('Hotel pending.', 'Hotel: Alfama guesthouse.')
    const theirs = base.replace('Hotel pending.', 'Hotel: Chiado apartment.')
    const r = merge3(base, mine, theirs)
    expect(r.conflict).toBe(true)
    expect(r.conflicts).toBe(1)
  })

  it('emits standard markers when asked for them', () => {
    const mine = base.replace('Hotel pending.', 'A')
    const theirs = base.replace('Hotel pending.', 'B')
    const r = merge3(base, mine, theirs, { markers: true, labelMine: 'mac', labelTheirs: 'phone' })
    expect(r.merged).toContain('<<<<<<< mac')
    expect(r.merged).toContain('>>>>>>> phone')
    expect(r.merged).toContain('A')
    expect(r.merged).toContain('B')
  })

  it('handles insertions at the very start and very end', () => {
    const mine = `Top line.\n${base}`
    const theirs = `${base}\nBottom line.`
    const r = merge3(base, mine, theirs)
    expect(r.conflict).toBe(false)
    expect(r.merged.startsWith('Top line.')).toBe(true)
    expect(r.merged.endsWith('Bottom line.')).toBe(true)
  })

  it('treats a deletion on one side against an untouched other side as a deletion', () => {
    const mine = base.split('\n').filter((l) => l !== 'Hotel pending.').join('\n')
    const r = merge3(base, mine, base)
    expect(r.conflict).toBe(false)
    expect(r.merged).not.toContain('Hotel pending.')
  })

  it('keeps both when two devices append different lines', () => {
    const mine = `${base}\nBooked the tram tickets.`
    const theirs = `${base}\nFound a place for dinner.`
    const r = merge3(base, mine, theirs)
    expect(r.conflict).toBe(false)
    expect(r.merged).toContain('Booked the tram tickets.')
    expect(r.merged).toContain('Found a place for dinner.')
  })

  it('orders co-insertions identically no matter which side is local', () => {
    // Both devices must compute byte-identical output, or the vault never
    // settles: each would keep "fixing" the other's version.
    const mine = `${base}\nzebra`
    const theirs = `${base}\napple`
    expect(merge3(base, mine, theirs).merged).toBe(merge3(base, theirs, mine).merged)
  })

  it('still conflicts when both sides rewrote existing content', () => {
    const r = merge3('alpha\nbravo', 'ALPHA\nbravo', 'ALFA\nbravo')
    expect(r.conflict).toBe(true)
  })

  it('preserves CRLF when the inputs use it', () => {
    const b = 'one\r\ntwo\r\nthree'
    const mine = 'one\r\nTWO\r\nthree'
    const r = merge3(b, mine, b)
    expect(r.merged).toContain('\r\n')
  })

  it('survives a large document without pathological slowdown', () => {
    const lines = Array.from({ length: 4000 }, (_, i) => `line ${i}`)
    const big = lines.join('\n')
    const mine = [...lines]
    mine[10] = 'line 10 edited by me'
    const theirs = [...lines]
    theirs[3900] = 'line 3900 edited by them'
    const t0 = Date.now()
    const r = merge3(big, mine.join('\n'), theirs.join('\n'))
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(r.conflict).toBe(false)
    expect(r.merged).toContain('line 10 edited by me')
    expect(r.merged).toContain('line 3900 edited by them')
  })
})
