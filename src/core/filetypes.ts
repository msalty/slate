/**
 * What a file *is*, when nothing can show what it contains.
 *
 * A note can embed anything the vault holds, but only four kinds of file draw
 * themselves in the page: a picture, a video, a sound, and a PDF. Everything
 * else — a spreadsheet, a zip, a font, a Keynote — arrives as a card, and a
 * card with the same grey page on it whatever it holds is a card that has to
 * be read to be recognised. Twelve of them in a project note is a wall of
 * identical rectangles.
 *
 * So each family gets a mark of its own. The families are coarser than a media
 * type on purpose (`.docx`, `.odt` and `.pages` are one thing to the eye) and
 * finer than one in the other direction, because a media type cannot tell
 * `.js` from `.csv` — both are text, and only one of them is code.
 *
 * The icons are markup rather than components because the two places that need
 * them are on opposite sides of the app's layering: the embed card is built
 * with plain DOM inside a CodeMirror widget, which never imports UI, and the
 * file picker is Preact. A string of SVG is the one shape both can use, and it
 * is static markup — no part of a file's name reaches it.
 */

import { extname, mediaClass } from './util'

export type FileFamily =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'doc'
  | 'sheet'
  | 'slides'
  | 'archive'
  | 'code'
  | 'text'
  | 'font'
  | 'ebook'
  | 'other'

/**
 * The families a media type cannot work out on its own.
 *
 * Anything not named here falls back to `mediaClass`, which already covers
 * every picture, video, sound, PDF and plain text file by its media type — so
 * a `.png` nobody thought to list is still a picture.
 */
const BY_EXT: Record<string, FileFamily> = {
  '.doc': 'doc',
  '.docx': 'doc',
  '.odt': 'doc',
  '.rtf': 'doc',
  '.pages': 'doc',
  '.xls': 'sheet',
  '.xlsx': 'sheet',
  '.ods': 'sheet',
  '.numbers': 'sheet',
  '.csv': 'sheet',
  '.tsv': 'sheet',
  '.ppt': 'slides',
  '.pptx': 'slides',
  '.odp': 'slides',
  '.key': 'slides',
  '.zip': 'archive',
  '.gz': 'archive',
  '.tgz': 'archive',
  '.tar': 'archive',
  '.7z': 'archive',
  '.rar': 'archive',
  '.dmg': 'archive',
  '.epub': 'ebook',
  '.mobi': 'ebook',
  '.azw3': 'ebook',
  '.woff': 'font',
  '.woff2': 'font',
  '.ttf': 'font',
  '.otf': 'font',
  '.html': 'code',
  '.htm': 'code',
  '.css': 'code',
  '.js': 'code',
  '.mjs': 'code',
  '.cjs': 'code',
  '.ts': 'code',
  '.tsx': 'code',
  '.jsx': 'code',
  '.json': 'code',
  '.py': 'code',
  '.rb': 'code',
  '.go': 'code',
  '.rs': 'code',
  '.java': 'code',
  '.c': 'code',
  '.h': 'code',
  '.cpp': 'code',
  '.cs': 'code',
  '.php': 'code',
  '.swift': 'code',
  '.kt': 'code',
  '.sh': 'code',
  '.sql': 'code',
  '.xml': 'code',
  '.yml': 'code',
  '.yaml': 'code',
  '.toml': 'code',
  '.ini': 'code',
}

/** Which family a vault path belongs to. */
export function fileFamily(path: string): FileFamily {
  return BY_EXT[extname(path)] ?? mediaClass(path)
}

/** What to call the family in a sentence: "Spreadsheet", "Archive". */
const FAMILY_NAME: Record<FileFamily, string> = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  pdf: 'PDF',
  doc: 'Document',
  sheet: 'Spreadsheet',
  slides: 'Presentation',
  archive: 'Archive',
  code: 'Code',
  text: 'Text',
  font: 'Font',
  ebook: 'Ebook',
  other: 'File',
}

export function familyName(family: FileFamily): string {
  return FAMILY_NAME[family]
}

/**
 * The badge a card wears: the extension, which is what the file's own name
 * already says, and the one thing that separates a `.docx` from a `.pages`.
 * A file with no extension falls back to its family.
 */
export function fileTypeLabel(path: string): string {
  const ext = extname(path)
  return ext ? ext.slice(1).toUpperCase() : FAMILY_NAME[fileFamily(path)].toUpperCase()
}

/**
 * The mark itself: stroke-based on a 24-unit grid at 1.7 wide, the same as
 * `ui/Icons.tsx`, so it sits in a row of the app's own icons without looking
 * borrowed. `currentColor` throughout, so it follows the text it sits beside
 * in either theme.
 */
const PAGE = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>'

const GLYPH: Record<FileFamily, string> = {
  image:
    '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="8.6" cy="10" r="1.6"/>' +
    '<path d="m4 17.5 4.6-4.6a1.7 1.7 0 0 1 2.4 0l4.2 4.2"/><path d="m13.6 15.1 1.8-1.8a1.7 1.7 0 0 1 2.4 0L21 16.5"/>',
  video: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10.2 9.3 15.4 12l-5.2 2.7z"/>',
  audio: '<path d="M9 17.5V6.2l10-2v11.3"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="16.5" cy="15.5" r="2.5"/>',
  // A page with a ribbon in it: the document you keep a place in.
  pdf: PAGE + '<path d="M9.5 12h5v7.5L12 17.4 9.5 19.5z"/>',
  doc: PAGE + '<path d="M8 12.5h8M8 16h8M8 19h5"/>',
  sheet:
    '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 9.5h18M3 14.5h18M9.5 4.5v15M15 4.5v15"/>',
  slides: '<rect x="3" y="4" width="18" height="12.5" rx="2"/><path d="M12 16.5V19M9 21h6"/>',
  archive:
    '<path d="M3 7.8 5.2 4h13.6L21 7.8V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 7.8h18M10.2 11.5h3.6"/>',
  code: PAGE + '<path d="m10.2 12.8-2.2 2.7 2.2 2.7M14 12.8l2.2 2.7L14 18.2"/>',
  text: '<path d="M4 6h16M4 10.5h16M4 15h11M4 19.5h7"/>',
  font: '<path d="m6 19.5 6-15 6 15"/><path d="M8.4 14.6h7.2"/>',
  ebook:
    '<path d="M4 4.8h5.5A2.5 2.5 0 0 1 12 7.3V20a2.5 2.5 0 0 0-2.5-1.7H4z"/>' +
    '<path d="M20 4.8h-5.5A2.5 2.5 0 0 0 12 7.3V20a2.5 2.5 0 0 1 2.5-1.7H20z"/>',
  other: PAGE,
}

/** The icon for a family, as SVG markup. */
export function familyIconSvg(family: FileFamily, size = 20): string {
  const px = Math.max(1, Math.round(size))
  return (
    `<svg class="file-icon" data-family="${family}" width="${px}" height="${px}" viewBox="0 0 24 24"` +
    ` fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"` +
    ` stroke-linejoin="round" aria-hidden="true">${GLYPH[family]}</svg>`
  )
}

/** The icon for a vault path, as SVG markup. */
export function fileIconSvg(path: string, size = 20): string {
  return familyIconSvg(fileFamily(path), size)
}
