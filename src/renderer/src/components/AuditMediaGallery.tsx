import { useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { createPortal } from 'react-dom'
import type { AuditMediaPreviewResult } from '../../../shared/auditExport'
import { filterAuditMedia, inlineMediaPreviewUrl, type AuditMediaFilter, type AuditMediaItem } from '../utils/auditMediaGallery'
import { formatAuditResourceSize } from '../utils/auditResourceSize'
import './AuditMediaGallery.css'

interface Props {
  items: AuditMediaItem[]
  sourceUrl: string
  capturedAt?: number
  coveragePartial: boolean
  onClose: () => void
  onExportAll: () => void
  onLocate: (selector: string) => boolean
}

const filters: Array<{ value: AuditMediaFilter; label: string }> = [
  { value: 'all', label: 'All' }, { value: 'image', label: 'Images' },
  { value: 'svg', label: 'SVGs' }, { value: 'icon', label: 'Icons' },
  { value: 'video', label: 'Videos' }, { value: 'audio', label: 'Audio' }
]

function MediaGlyph({ category }: { category: AuditMediaItem['category'] }) {
  if (category === 'video') return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3V9Z"/></svg>
  if (category === 'audio') return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M9 18V5l10-2v13M9 18c0 3-6 4-6 1s6-4 6-1Zm10-2c0 3-6 4-6 1s6-4 6-1Z"/></svg>
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="m4 17 5-5 4 4 2-2 5 5"/></svg>
}

function MediaThumbnail({ item, fetchedPreview }: { item: AuditMediaItem; fetchedPreview?: string }) {
  const [failed, setFailed] = useState(false)
  const source = fetchedPreview || (item.category === 'video' || item.category === 'audio' ? null : inlineMediaPreviewUrl(item.resource))
  useEffect(() => { setFailed(false) }, [source])
  return <span className="audit-media-thumb">{source && !failed ? <img src={source} alt="" loading="lazy" onError={() => setFailed(true)} /> : <MediaGlyph category={item.category} />}</span>
}

export default function AuditMediaGallery({ items, sourceUrl, capturedAt, coveragePartial, onClose, onExportAll, onLocate }: Props) {
  const [filter, setFilter] = useState<AuditMediaFilter>('all')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [preview, setPreview] = useState<AuditMediaPreviewResult | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [playbackError, setPlaybackError] = useState('')
  const [actionStatus, setActionStatus] = useState('')
  const [savedPath, setSavedPath] = useState('')
  const [saving, setSaving] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [position, setPosition] = useState(() => ({ x: Math.max(16, (window.innerWidth - 960) / 2), y: Math.max(16, (window.innerHeight - 680) / 2) }))
  const dialogRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const previewRequest = useRef(0)
  const saveRequest = useRef(0)
  const visible = useMemo(() => filterAuditMedia(items, filter, query), [items, filter, query])
  const selected = visible.find(item => item.id === selectedId) || visible[0] || null

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    searchRef.current?.focus()
    return () => previousFocus?.focus()
  }, [])

  useEffect(() => {
    const requestId = ++previewRequest.current
    setPreview(null)
    setPlaybackError('')
    setActionStatus('')
    setSavedPath('')
    saveRequest.current++
    setZoom(1)
    if (!selected) { setPreviewLoading(false); return }
    const resource = selected.resource
    const direct = inlineMediaPreviewUrl(resource)
    if (resource.inlineContent != null || resource.url.startsWith('data:')) {
      setPreview(direct ? { dataUrl: direct, mimeType: resource.mimeType } : { error: 'This embedded media is unavailable.' })
      setPreviewLoading(false)
      return
    }
    setPreviewLoading(true)
    void window.electronAPI.previewAuditMedia({ resource, refererUrl: sourceUrl }).then(result => {
      if (requestId !== previewRequest.current) return
      setPreview(result)
      setPreviewLoading(false)
    }).catch(error => {
      if (requestId !== previewRequest.current) return
      setPreview({ error: error instanceof Error ? error.message : 'Unable to preview this media.' })
      setPreviewLoading(false)
    })
    return () => { previewRequest.current++ }
  }, [selected?.id, selected?.resource.url, selected?.resource.inlineContent, sourceUrl])

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
    if (event.key === 'Tab') {
      const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), audio[controls], video[controls]') || [])
      if (!controls.length) return
      const current = controls.indexOf(document.activeElement as HTMLElement)
      if (event.shiftKey && current === 0) { event.preventDefault(); controls[controls.length - 1].focus() }
      else if (!event.shiftKey && current === controls.length - 1) { event.preventDefault(); controls[0].focus() }
      return
    }
    if ((event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') || event.target instanceof HTMLInputElement || event.target instanceof HTMLMediaElement) return
    const index = visible.findIndex(item => item.id === selected?.id)
    const next = visible[index + (event.key === 'ArrowRight' ? 1 : -1)]
    if (next) { event.preventDefault(); setSelectedId(next.id) }
  }

  const beginDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
    event.preventDefault()
    const origin = { pointerX: event.clientX, pointerY: event.clientY, left: position.x, top: position.y }
    const move = (next: PointerEvent) => setPosition({
      x: Math.max(0, Math.min(window.innerWidth - 160, origin.left + next.clientX - origin.pointerX)),
      y: Math.max(0, Math.min(window.innerHeight - 80, origin.top + next.clientY - origin.pointerY))
    })
    const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop, { once: true })
  }

  const downloadSelected = async () => {
    if (!selected || saving) return
    const requestId = ++saveRequest.current
    setSaving(true)
    setActionStatus('')
    setSavedPath('')
    try {
      const result = await window.electronAPI.saveAuditMedia({ resource: selected.resource, refererUrl: sourceUrl })
      if (requestId !== saveRequest.current) return
      setActionStatus(result.error || (result.filePath ? `Saved to ${result.filePath}` : ''))
      setSavedPath(result.filePath || '')
    } catch (error) { if (requestId === saveRequest.current) setActionStatus(error instanceof Error ? error.message : 'Download failed.') }
    finally { setSaving(false) }
  }

  const copySource = async () => {
    if (!selected) return
    try {
      await navigator.clipboard.writeText(selected.resource.inlineContent || selected.resource.url)
      setActionStatus(selected.resource.inlineContent ? 'SVG markup copied.' : 'Source URL copied.')
    } catch { setActionStatus('Could not copy to clipboard.') }
  }

  const locate = (selector: string) => setActionStatus(onLocate(selector) ? 'Selected on the Audit canvas.' : 'This element is no longer available in the canvas.')
  const selectedUrl = selected?.resource.url || ''
  const playbackUrl = preview?.dataUrl || (preview?.error?.includes('too large for an in-app preview') && /^https?:\/\//i.test(selectedUrl) ? selectedUrl : '')

  return createPortal(
    <div className="audit-media-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={dialogRef} className="audit-media-dialog" role="dialog" aria-modal="true" aria-label="Media Gallery" tabIndex={-1} onKeyDown={onKeyDown} style={{ left: position.x, top: position.y }}>
        <div className="audit-media-header" onPointerDown={beginDrag}>
          <div className="audit-media-heading"><MediaGlyph category="image" /><span>Media Gallery</span><small>{items.length} captured</small></div>
          <div className="audit-media-header-actions">
            <button type="button" onClick={onExportAll} disabled={!items.length} title="Export all captured media to a folder">Export all</button>
            <button type="button" onClick={onClose} aria-label="Close media gallery" title="Close">×</button>
          </div>
        </div>
        <div className="audit-media-subtitle">{capturedAt ? `Captured ${new Date(capturedAt).toLocaleString()}` : 'Saved Audit snapshot'}{coveragePartial ? ' · Older capture: some media may be missing' : ''}</div>
        <div className="audit-media-toolbar">
          <div className="audit-media-filters" role="group" aria-label="Filter media">
            {filters.map(option => {
              const count = option.value === 'all' ? items.length : items.filter(item => item.category === option.value).length
              return <button key={option.value} type="button" className={filter === option.value ? 'active' : ''} onClick={() => setFilter(option.value)} aria-pressed={filter === option.value}>{option.label} <span>{count}</span></button>
            })}
          </div>
          <input ref={searchRef} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search filenames, URLs, or source elements" aria-label="Search captured media" />
        </div>
        <div className="audit-media-main">
          <div className="audit-media-list" aria-label="Captured media">
            {!visible.length && <div className="audit-media-empty">No media matches this filter.</div>}
            <div className="audit-media-grid">
              {visible.map(item => {
                return <button key={item.id} type="button" className={`audit-media-tile ${selected?.id === item.id ? 'selected' : ''}`} onClick={() => setSelectedId(item.id)} aria-pressed={selected?.id === item.id} title={`${item.name}\n${item.resource.url}`}>
                  <MediaThumbnail item={item} fetchedPreview={selected?.id === item.id ? preview?.dataUrl : undefined} />
                  <span className="audit-media-tile-name">{item.name}</span>
                  <span className="audit-media-tile-kind">{item.category.toUpperCase()} · {item.usages.length} {item.usages.length === 1 ? 'use' : 'uses'}</span>
                </button>
              })}
            </div>
          </div>
          <div className="audit-media-detail">
            {!selected ? <div className="audit-media-empty">Select a media item to inspect it.</div> : <>
              <div className={`audit-media-preview ${zoom > 1 ? 'zoomed' : ''}`}>
                {previewLoading ? <span className="audit-media-placeholder">Loading preview…</span> : null}
                {!previewLoading && playbackUrl && selected.category === 'video' && <video key={selected.id} controls preload="metadata" src={playbackUrl} onError={() => setPlaybackError('This video format or source could not be played.')} />}
                {!previewLoading && playbackUrl && selected.category === 'audio' && <audio key={selected.id} controls preload="metadata" src={playbackUrl} onError={() => setPlaybackError('This audio format or source could not be played.')} />}
                {!previewLoading && playbackUrl && !playbackError && !['video', 'audio'].includes(selected.category) && <img key={selected.id} src={playbackUrl} alt={`Preview of ${selected.name}`} style={{ width: zoom === 1 ? undefined : `${zoom * 100}%`, maxWidth: zoom === 1 ? '100%' : 'none', maxHeight: zoom === 1 ? '100%' : 'none' }} onError={() => setPlaybackError('This image could not be displayed.')} />}
                {!previewLoading && (!playbackUrl || (playbackError && !['video', 'audio'].includes(selected.category))) && <span className="audit-media-placeholder">{playbackError || preview?.error || 'Preview unavailable for this capture.'}</span>}
              </div>
              {playbackError && <div className="audit-media-notice error" role="alert">{playbackError}</div>}
              {preview?.error && playbackUrl && <div className="audit-media-notice">{preview.error} Showing the original URL instead.</div>}
              {!['video', 'audio'].includes(selected.category) && playbackUrl && <div className="audit-media-zoom"><span>Preview size</span><input type="range" min="1" max="3" step="0.25" value={zoom} onChange={event => setZoom(Number(event.target.value))} aria-label="Image preview zoom" /><button type="button" onClick={() => setZoom(1)}>Fit</button><span>{Math.round(zoom * 100)}%</span></div>}
              <div className="audit-media-details-scroll">
                <strong title={selected.name}>{selected.name}</strong>
                <dl>
                  <dt>Type</dt><dd>{selected.category.toUpperCase()}{preview?.mimeType ? ` · ${preview.mimeType}` : ''}</dd>
                  {preview?.bytes != null && <><dt>Size</dt><dd>{formatAuditResourceSize(preview.bytes)}</dd></>}
                  <dt>Source</dt><dd className="audit-media-url" title={selectedUrl}>{selectedUrl}</dd>
                </dl>
                <div className="audit-media-actions">
                  <button type="button" onClick={() => void downloadSelected()} disabled={saving || selectedUrl.startsWith('canvas:') || selectedUrl.startsWith('blob:')}>{saving ? 'Saving…' : 'Download'}</button>
                  <button type="button" onClick={() => void copySource()}>{selected.resource.inlineContent ? 'Copy SVG' : 'Copy URL'}</button>
                  {/^https?:\/\//i.test(selectedUrl) && <button type="button" onClick={() => void window.electronAPI.openExternal(selectedUrl)}>Open original</button>}
                </div>
                {actionStatus && <div className="audit-media-notice" role="status">{actionStatus}</div>}
                {savedPath && <button type="button" className="audit-media-reveal" onClick={() => void window.electronAPI.revealAuditMediaFile(savedPath).then(result => { if (!result.success) setActionStatus(result.error || 'Could not show the saved file.') })}>Show in folder</button>}
                <div className="audit-media-usages-title">Found in capture · {selected.usages.length}</div>
                <div className="audit-media-usages">{selected.usages.map((usage, index) => <div key={`${usage.source}:${usage.selector || ''}:${index}`} className="audit-media-usage"><span>{usage.source}{usage.descriptor ? ` · ${usage.descriptor}` : ''}</span>{usage.selector && <><code title={usage.selector}>{usage.selector}</code><button type="button" onClick={() => locate(usage.selector!)}>Locate on canvas</button></>}</div>)}</div>
              </div>
            </>}
          </div>
        </div>
        <div className="audit-media-footer"><span>{visible.length} shown · Arrow keys move between items</span><span>Drag title bar · Resize from corner</span></div>
      </div>
    </div>, document.body
  )
}
