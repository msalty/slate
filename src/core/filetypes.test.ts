/**
 * Which family a file belongs to, and therefore which mark it wears.
 *
 * The point of the families is that a card is recognisable without being read,
 * so what matters here is that things that look alike to a person land
 * together — every office document is one family, every archive another — and
 * that a file nobody thought of still gets something rather than nothing.
 */

import { describe, expect, it } from 'vitest'
import { familyIconSvg, fileFamily, fileIconSvg, fileTypeLabel, type FileFamily } from './filetypes'

describe('fileFamily', () => {
  it('keeps the four kinds the page can draw for itself', () => {
    expect(fileFamily('a/b/photo.png')).toBe('image')
    expect(fileFamily('clip.mp4')).toBe('video')
    expect(fileFamily('take-1.flac')).toBe('audio')
    expect(fileFamily('invoice.pdf')).toBe('pdf')
  })

  it('groups the office formats by what they are, not by who made them', () => {
    for (const p of ['a.doc', 'a.docx', 'a.odt', 'a.pages', 'a.rtf']) expect(fileFamily(p)).toBe('doc')
    for (const p of ['a.xls', 'a.xlsx', 'a.ods', 'a.numbers', 'a.csv']) expect(fileFamily(p)).toBe('sheet')
    for (const p of ['a.ppt', 'a.pptx', 'a.odp', 'a.key']) expect(fileFamily(p)).toBe('slides')
  })

  it('separates code from the plain text it is made of', () => {
    expect(fileFamily('script.py')).toBe('code')
    expect(fileFamily('data.json')).toBe('code')
    expect(fileFamily('notes.txt')).toBe('text')
    expect(fileFamily('README.md')).toBe('text')
  })

  it('knows the rest by extension', () => {
    expect(fileFamily('backup.zip')).toBe('archive')
    expect(fileFamily('novel.epub')).toBe('ebook')
    expect(fileFamily('Inter.woff2')).toBe('font')
  })

  it('ignores case, because a camera writes .JPG and Windows writes .PDF', () => {
    expect(fileFamily('IMG_0421.JPG')).toBe('image')
    expect(fileFamily('Report.PDF')).toBe('pdf')
    expect(fileFamily('Archive.ZIP')).toBe('archive')
  })

  it('falls back rather than failing on something it has never seen', () => {
    expect(fileFamily('firmware.bin')).toBe('other')
    expect(fileFamily('Makefile')).toBe('other')
  })
})

describe('fileTypeLabel', () => {
  it('is the extension, which is what tells two documents apart', () => {
    expect(fileTypeLabel('a/b/deck.pptx')).toBe('PPTX')
    expect(fileTypeLabel('IMG_0421.JPG')).toBe('JPG')
  })

  it('names the family when there is no extension to show', () => {
    expect(fileTypeLabel('Makefile')).toBe('FILE')
  })
})

describe('the icons', () => {
  const families: FileFamily[] = [
    'image',
    'video',
    'audio',
    'pdf',
    'doc',
    'sheet',
    'slides',
    'archive',
    'code',
    'text',
    'font',
    'ebook',
    'other',
  ]

  it('gives every family a mark of its own', () => {
    const drawings = new Set(families.map((f) => familyIconSvg(f)))
    expect(drawings.size).toBe(families.length)
  })

  it('is a complete, self-describing svg that inherits its colour', () => {
    const svg = fileIconSvg('backup.zip', 18)
    expect(svg.startsWith('<svg ')).toBe(true)
    expect(svg.endsWith('</svg>')).toBe(true)
    expect(svg).toContain('data-family="archive"')
    expect(svg).toContain('width="18" height="18"')
    expect(svg).toContain('stroke="currentColor"')
  })

  it('takes no part of the file name into the markup', () => {
    expect(fileIconSvg('"><script>alert(1)</script>.zip')).toBe(familyIconSvg('archive'))
  })
})
