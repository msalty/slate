/** Full-screen viewer for any embedded file: image, video, audio, PDF or text. */

import { useEffect, useState } from 'preact/hooks'
import { attachmentUrl, getRaw } from '../core/vault'
import { basename, formatBytes, mediaClass } from '../core/util'
import { lightboxPath } from './state'
import { IconClose, IconDownload } from './Icons'

export function Lightbox() {
  const path = lightboxPath.value
  const [zoom, setZoom] = useState(1)

  useEffect(() => {
    if (!path) return
    setZoom(1)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        lightboxPath.value = undefined
      }
      if (e.key === '0') setZoom(1)
      if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(8, z * 1.25))
      if (e.key === '-') setZoom((z) => Math.max(0.1, z / 1.25))
    }
    addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [path])

  if (!path) return null
  const file = getRaw(path)
  const url = attachmentUrl(path)
  const kind = mediaClass(path)

  const download = () => {
    if (!url) return
    const a = document.createElement('a')
    a.href = url
    a.download = basename(path)
    a.click()
  }

  return (
    <div
      class="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={basename(path)}
      onClick={() => (lightboxPath.value = undefined)}
    >
      <div class="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span style={{ fontWeight: 500 }}>{basename(path)}</span>
        <span style={{ opacity: 0.6 }}>
          {file ? formatBytes(file.size) : ''}
          {kind === 'image' && zoom !== 1 ? ` · ${Math.round(zoom * 100)}%` : ''}
        </span>
        <span class="spacer" style={{ flex: 1 }} />
        {kind === 'image' && (
          <>
            <button class="icon-btn" onClick={() => setZoom((z) => Math.max(0.1, z / 1.25))} title="Zoom out (−)">
              −
            </button>
            <button class="icon-btn" onClick={() => setZoom(1)} title="Actual size (0)">
              1:1
            </button>
            <button class="icon-btn" onClick={() => setZoom((z) => Math.min(8, z * 1.25))} title="Zoom in (+)">
              +
            </button>
          </>
        )}
        <button class="icon-btn" onClick={download} title="Download">
          <IconDownload />
        </button>
        <button
          class="icon-btn"
          onClick={() => (lightboxPath.value = undefined)}
          title="Close (Esc)"
        >
          <IconClose />
        </button>
      </div>

      <div class="lightbox-stage" onClick={(e) => e.stopPropagation()}>
        {!url ? (
          <div style={{ color: '#bbb' }}>This file isn’t available on this device yet.</div>
        ) : kind === 'image' ? (
          <img
            src={url}
            alt={basename(path)}
            style={{
              transform: `scale(${zoom})`,
              transformOrigin: 'center',
              transition: 'transform 120ms',
              cursor: zoom > 1 ? 'grab' : 'zoom-in',
            }}
            onClick={() => setZoom((z) => (z === 1 ? 2 : 1))}
          />
        ) : kind === 'video' ? (
          <video src={url} controls autoplay style={{ maxHeight: '100%' }} />
        ) : kind === 'audio' ? (
          <audio src={url} controls autoplay style={{ width: 'min(600px, 90%)' }} />
        ) : kind === 'pdf' ? (
          <iframe src={url} title={basename(path)} />
        ) : kind === 'text' ? (
          <TextPreview path={path} />
        ) : (
          <div style={{ color: '#bbb', textAlign: 'center' }}>
            No preview for this file type.
            <br />
            <button class="btn" style={{ marginTop: 12 }} onClick={download}>
              Download
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function TextPreview({ path }: { path: string }) {
  const [text, setText] = useState<string | undefined>()
  useEffect(() => {
    const f = getRaw(path)
    if (f?.text !== undefined) setText(f.text)
    else if (f?.blob) void f.blob.text().then(setText)
  }, [path])
  return <pre>{text ?? 'Loading…'}</pre>
}
