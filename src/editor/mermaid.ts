/**
 * Mermaid diagrams, drawn by Pele.
 *
 * Pele rather than mermaid.js: it is a fraction of the size, has no
 * dependencies, renders synchronously, and takes its colours from CSS
 * variables — so a diagram follows the theme without being drawn again (the
 * variables are set on `.cm-fence` in theme.ts).
 *
 * This module is only ever reached through the registry in fences.ts, which is
 * what keeps the library out of the bundle a note without a diagram loads.
 */

import { mount } from 'pele'
import type { FenceMount } from './fences'

export const mountMermaid: FenceMount = (el, source, resized) => {
  /*
   * Pele keeps the last good drawing on screen when an edit does not parse,
   * which is right — a diagram that vanished at every half-typed arrow would
   * be unusable — but it says nothing about why the picture stopped following
   * the text. This line under it does.
   */
  const art = document.createElement('div')
  const note = document.createElement('div')
  note.className = 'cm-fence-error'
  note.hidden = true
  el.append(art, note)

  /*
   * Only when the picture is stale. Some failures Pele reports by putting the
   * message where the picture was — a first drawing that never worked, or
   * source that is no longer any kind of diagram — and saying it twice is
   * noise. Asked after the fact rather than in `onError`, which runs before
   * Pele has decided what to leave on screen.
   */
  const report = () => {
    const error = mounted.error
    const stale = !!error && !!art.querySelector('svg')
    note.textContent = stale ? firstLine(error) : ''
    note.hidden = !stale
    resized()
  }

  const options = {
    /*
     * A `click … href` in a diagram would navigate the app itself away from
     * the note. Links in a note are wikilinks and markdown links, which have
     * their own handling; a diagram is a picture.
     */
    links: false,
    // Pele also redraws by itself, when the width it has to fit changes.
    onRender: () => queueMicrotask(report),
    onError: () => queueMicrotask(report),
  }

  const mounted = mount(art, source, options)
  report()
  return {
    update: (next) => {
      mounted.update(next, options)
      report()
    },
    destroy: () => mounted.destroy(),
  }
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split('\n')[0].replace(/:$/, '')
}
