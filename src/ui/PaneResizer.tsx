/**
 * Drag the edge of a pane to resize it.
 *
 * The width lives in a CSS variable that the shell's grid reads, so a drag
 * writes one custom property and the browser does the rest — no re-render per
 * pointer move, no layout thrash, and the panes stay exactly as wide as the
 * grid says they are.
 *
 * The settled width is saved once, on release. Saving on every move would
 * write to IndexedDB (and the vault's shared preferences) sixty times a
 * second, and none of those intermediate widths is one anybody chose.
 */

import { useRef } from 'preact/hooks'
import { settings, update } from '../core/settings'
import type { AppSettings } from '../core/types'

export interface PaneResizerProps {
  /** The CSS variable the shell's grid template reads. */
  variable: '--sidebar-w' | '--list-w'
  setting: 'sidebarWidth' | 'listWidth'
  min: number
  max: number
  /** What a double-click goes back to. */
  fallback: number
  label: string
}

export function PaneResizer({ variable, setting, min, max, fallback, label }: PaneResizerProps) {
  const ref = useRef<HTMLDivElement>(null)
  const width = (settings.value[setting] as number) || fallback
  const clamp = (n: number) => Math.round(Math.min(max, Math.max(min, n)))
  const shell = () => ref.current?.closest('.shell') as HTMLElement | null

  const preview = (n: number) => shell()?.style.setProperty(variable, `${n}px`)
  const commit = (n: number) => update({ [setting]: n } as Partial<AppSettings>)

  const onPointerDown = (e: PointerEvent) => {
    // Only the primary button; a right-click here is not a drag.
    if (e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget as HTMLElement
    const startX = e.clientX
    const startW = width
    let next = startW
    el.setPointerCapture(e.pointerId)
    document.body.classList.add('resizing')

    const move = (ev: PointerEvent) => {
      next = clamp(startW + (ev.clientX - startX))
      preview(next)
    }
    const up = () => {
      el.releasePointerCapture(e.pointerId)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      document.body.classList.remove('resizing')
      commit(next)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  return (
    <div
      ref={ref}
      class="pane-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDblClick={() => {
        preview(fallback)
        commit(fallback)
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 32 : 8
        if (e.key === 'ArrowLeft') {
          e.preventDefault()
          const n = clamp(width - step)
          preview(n)
          commit(n)
        } else if (e.key === 'ArrowRight') {
          e.preventDefault()
          const n = clamp(width + step)
          preview(n)
          commit(n)
        }
      }}
    />
  )
}
