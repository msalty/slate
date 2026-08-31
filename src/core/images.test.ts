import { describe, expect, it } from 'vitest'
import { attachmentPath } from './images'

const y = new Date().getFullYear()
const m = `${new Date().getMonth() + 1}`.padStart(2, '0')

describe('attachment naming', () => {
  it('files attachments under a dated folder', () => {
    expect(attachmentPath('attachments', 'diagram.png', 'image/png')).toBe(
      `attachments/${y}/${m}/diagram.png`,
    )
  })

  it('uses the mime type for the extension, not the original name', () => {
    // A PNG re-encoded to WebP must not keep a .png name.
    expect(attachmentPath('attachments', 'shot.png', 'image/webp')).toMatch(/\.webp$/)
  })

  it('gives a dated name to a bare camera capture', () => {
    for (const name of ['image.jpg', 'photo.jpg', 'IMG.jpg', 'capture.png', 'image_1.jpg']) {
      expect(attachmentPath('attachments', name, 'image/webp')).toMatch(
        /\/photo-\d{4}-\d{2}-\d{2}-\d{6}\.webp$/,
      )
    }
  })

  it('keeps a library filename the user would recognise', () => {
    // These are what iOS and Android hand over from the photo library; the
    // sequence number and the embedded date are the user's thread back to the
    // original, so they must survive.
    expect(attachmentPath('attachments', 'IMG_0421.jpg', 'image/webp')).toContain('IMG_0421')
    expect(attachmentPath('attachments', 'IMG_20260831_143340.jpg', 'image/webp')).toContain(
      'IMG_20260831_143340',
    )
    expect(attachmentPath('attachments', 'Screenshot 2026-08-31.png', 'image/webp')).toContain(
      'Screenshot',
    )
  })

  it('sanitises a name that would break on Windows or WebDAV', () => {
    const p = attachmentPath('attachments', 'Q1: profit/loss?.png', 'image/png')
    expect(p.split('/').pop()).not.toMatch(/[:?]/)
  })

  it('respects a custom attachment folder', () => {
    expect(attachmentPath('media/files', 'a.png', 'image/png')).toBe(`media/files/${y}/${m}/a.png`)
  })
})
