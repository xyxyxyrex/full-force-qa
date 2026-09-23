import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { BrowserComparison, BrowserComparisonCapture, BrowserComparisonImage, BrowserComparisonProgress, ComparisonAnnotation, ComparisonEngine } from '../../../shared/crossBrowser'
import './BrowserComparisonPanel.css'

type ViewMode = 'engine' | 'chromium' | 'difference' | 'side-by-side'
type Menu = 'views' | 'history' | 'more' | 'warning' | null
type IconName = 'browser' | 'refresh' | 'layers' | 'pen' | 'history' | 'more' | 'close' | 'trash' | 'download' | 'login' | 'check' | 'stop' | 'alert'
type CaptureInput = Omit<BrowserComparisonCapture, 'projectId' | 'engine'>

interface Props {
  engine: ComparisonEngine
  projectId?: string
  captureChromium: () => Promise<CaptureInput>
  getPageUrl: () => string
  scrollY: number
  onScroll: (top: number) => void
  onClose: () => void
  onHeaderPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void
}

const icons: Record<IconName, React.ReactNode> = {
  browser: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><circle cx="6.5" cy="6.5" r=".5" fill="currentColor"/></>,
  refresh: <><path d="M20 6v5h-5"/><path d="M18.5 15a7 7 0 1 1-.8-7L20 11"/></>,
  layers: <><rect x="3" y="3" width="14" height="14" rx="2"/><path d="M8 21h11a2 2 0 0 0 2-2V8"/></>,
  pen: <><path d="m4 20 4-.8L20 7a2 2 0 0 0-3-3L5 16z"/><path d="m14 7 3 3"/></>,
  history: <><path d="M3 11a9 9 0 1 1 2 6"/><path d="M3 4v7h7"/><path d="M12 7v5l3 2"/></>,
  more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  close: <path d="M5 5l14 14M19 5 5 19"/>,
  trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"/><path d="M10 11v6m4-6v6"/></>,
  download: <><path d="M12 3v12m-4-4 4 4 4-4"/><path d="M4 17v4h16v-4"/></>,
  login: <><path d="M11 4H4v16h7M14 8l4 4-4 4M8 12h10"/></>,
  check: <path d="m4 12 5 5L20 6"/>,
  stop: <rect x="5" y="5" width="14" height="14" rx="2"/>,
  alert: <><path d="M12 3 2 21h20L12 3Z"/><path d="M12 9v5m0 3h.01"/></>,
}

function Icon({ name }: { name: IconName }) {
  return <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{icons[name]}</svg>
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error)
}

export default function BrowserComparisonPanel({ engine, projectId, captureChromium, getPageUrl, scrollY, onScroll, onClose, onHeaderPointerDown }: Props) {
  const [installed, setInstalled] = useState(false)
  const [records, setRecords] = useState<BrowserComparison[]>([])
  const [selected, setSelected] = useState<BrowserComparisonImage | null>(null)
  const [mode, setMode] = useState<ViewMode>('engine')
  const [menu, setMenu] = useState<Menu>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<BrowserComparisonProgress | null>(null)
  const [loginOpen, setLoginOpen] = useState(false)
  const [annotating, setAnnotating] = useState(false)
  const [draft, setDraft] = useState<ComparisonAnnotation | null>(null)
  const [note, setNote] = useState('')
  const start = useRef<{ x: number; y: number; id: string } | null>(null)
  const surface = useRef<HTMLDivElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const suppressScroll = useRef(false)
  const lastManualScroll = useRef(0)
  const generation = useRef(0)
  const autoCaptureAttempted = useRef(false)
  const title = engine === 'webkit' ? 'WebKit' : 'Firefox'

  const refresh = useCallback(async () => {
    const status = await window.electronAPI.comparisonStatus()
    setInstalled(status[engine])
    if (!projectId) { setRecords([]); return }
    const list = await window.electronAPI.comparisonList(projectId)
    setRecords(list.filter(item => item.engine === engine))
  }, [engine, projectId])

  useEffect(() => {
    const current = ++generation.current
    setSelected(null)
    setError('')
    setProgress(null)
    setLoginOpen(false)
    void refresh().catch(err => { if (generation.current === current) setError(message(err)) })
    const offProgress = window.electronAPI.onComparisonProgress(value => { if (value.engine === engine) setProgress(value) })
    const offAccount = window.electronAPI.onAccountChanged(() => {
      generation.current++
      setSelected(null)
      setRecords([])
      setLoginOpen(false)
    })
    return () => { generation.current++; offProgress(); offAccount() }
  }, [engine, projectId, refresh])

  const run = async (task: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try { await task() } catch (err) { setError(message(err)) } finally { setBusy(false) }
  }

  const capture = () => void run(async () => {
    autoCaptureAttempted.current = true
    if (!projectId) throw new Error('Save this project before comparing browsers.')
    if (!installed) throw new Error(`Install ${title} first.`)
    const current = generation.current
    setProgress({ engine, phase: 'preparing', message: 'Capturing the full Chromium page...' })
    const chromium = await captureChromium()
    if (current !== generation.current) return
    const result = await window.electronAPI.comparisonCapture({ ...chromium, projectId, engine })
    if (current !== generation.current) return
    setSelected(result)
    setMenu(null)
    await refresh()
  })

  useEffect(() => {
    if (installed && projectId && !autoCaptureAttempted.current) capture()
  }, [installed, projectId])

  const load = (id: string) => void run(async () => {
    if (!projectId) return
    const current = generation.current
    const result = await window.electronAPI.comparisonLoad(projectId, id)
    if (current === generation.current) { setSelected(result); setMenu(null); setDraft(null) }
  })

  const remove = (id: string) => void run(async () => {
    if (!projectId) return
    await window.electronAPI.comparisonDelete(projectId, id)
    if (selected?.record.id === id) { setSelected(null); setDraft(null) }
    await refresh()
  })

  const changeAnnotations = (annotations: ComparisonAnnotation[]) => void run(async () => {
    if (!projectId || !selected) return
    const updated = await window.electronAPI.comparisonSaveAnnotations(projectId, selected.record.id, annotations)
    setSelected(previous => previous?.record.id === updated.id ? { ...previous, record: updated } : previous)
    setRecords(previous => previous.map(item => item.id === updated.id ? updated : item))
    setDraft(null)
    setNote('')
  })

  const point = (event: ReactPointerEvent) => {
    const rect = surface.current!.getBoundingClientRect()
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }
  }

  useEffect(() => {
    const element = viewport.current
    if (!element || !selected || Date.now() - lastManualScroll.current < 250) return
    const imageWidth = mode === 'side-by-side' ? (element.clientWidth - 8) / 2 : element.clientWidth
    const scale = imageWidth / selected.record.width
    const expected = scrollY * scale
    if (Math.abs(element.scrollTop - expected) > 2) {
      suppressScroll.current = true
      element.scrollTop = expected
      requestAnimationFrame(() => { suppressScroll.current = false })
    }
  }, [scrollY, selected, mode])

  const onViewportScroll = () => {
    const element = viewport.current
    if (!element || !selected || suppressScroll.current || !selected.record.fullPage) return
    lastManualScroll.current = Date.now()
    const imageWidth = mode === 'side-by-side' ? (element.clientWidth - 8) / 2 : element.clientWidth
    const sourceY = element.scrollTop / (imageWidth / selected.record.width)
    if (Math.abs(sourceY - scrollY) > 2) onScroll(sourceY)
  }

  const imageKinds: Array<'engine' | 'chromium' | 'difference'> = mode === 'side-by-side' ? ['chromium', 'engine'] : [mode]
  const canCancel = busy && !!progress && ['launching', 'loading', 'capturing'].includes(progress.phase)
  const imageHeight = selected?.record.imageHeight || selected?.record.height || 1
  const chromiumHeight = selected?.record.chromiumImageHeight || selected?.record.height || 1
  const warningText = [selected?.record.warning, selected && !selected.record.fullPage ? 'This older capture contains one viewport. Capture again for full-page scrolling.' : ''].filter(Boolean).join(' ')

  return <div className="browser-comparison-panel" role="region" aria-label={`${title} page comparison`} onMouseDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
    <div className="browser-comparison-header" onPointerDown={onHeaderPointerDown} title="Drag to move comparison">
      <span className="browser-comparison-title"><Icon name="browser" /><strong>{title}</strong><small>{selected?.record.fullPage ? 'Full page' : selected ? 'Viewport only' : 'Comparison'}</small></span>
      <span className="browser-comparison-header-actions">
        {warningText && <button title={warningText} aria-label="Capture warnings" className={`browser-comparison-warning-button ${menu === 'warning' ? 'active' : ''}`} onClick={() => setMenu(menu === 'warning' ? null : 'warning')}><Icon name="alert" /></button>}
        <button title="Capture full page again" aria-label="Capture full page again" disabled={busy || !installed || !projectId} onClick={capture}><Icon name="refresh" /></button>
        <button title="Choose comparison view" aria-label="Choose comparison view" className={menu === 'views' ? 'active' : ''} disabled={!selected} onClick={() => setMenu(menu === 'views' ? null : 'views')}><Icon name="layers" /></button>
        <button title="Mark differences" aria-label="Mark differences" aria-pressed={annotating} className={annotating ? 'active' : ''} disabled={!selected || mode === 'chromium'} onClick={() => { setAnnotating(!annotating); setMenu(null) }}><Icon name="pen" /></button>
        <button title="Saved comparisons" aria-label="Saved comparisons" className={menu === 'history' ? 'active' : ''} onClick={() => setMenu(menu === 'history' ? null : 'history')}><Icon name="history" /></button>
        <button title="More browser actions" aria-label="More browser actions" className={menu === 'more' ? 'active' : ''} onClick={() => setMenu(menu === 'more' ? null : 'more')}><Icon name="more" /></button>
        <button title="Close comparison" aria-label="Close comparison" onClick={onClose}><Icon name="close" /></button>
      </span>
    </div>

    {menu && <div className="browser-comparison-popover" role="menu">
      {menu === 'warning' && <p className="browser-comparison-warning-detail">{warningText}</p>}
      {menu === 'views' && ([
        ['engine', `${title} page`], ['chromium', 'Chromium capture'], ['difference', 'Difference'], ['side-by-side', 'Both captures'],
      ] as const).map(([value, label]) => <button role="menuitem" key={value} className={mode === value ? 'active' : ''} onClick={() => { setMode(value); setMenu(null); setAnnotating(false) }}><span>{label}</span>{mode === value && <Icon name="check" />}</button>)}
      {menu === 'history' && <><div className="browser-comparison-popover-heading">Saved {title} comparisons</div>{records.length ? records.map(item => <div className="browser-comparison-history-row" key={item.id}><button role="menuitem" className={selected?.record.id === item.id ? 'active' : ''} onClick={() => load(item.id)}><span>{new Date(item.capturedAt).toLocaleString()}</span><small>{item.fullPage ? 'Full page' : 'Viewport only'} · {item.width} × {item.height}</small></button><button className="browser-comparison-delete" aria-label={`Delete comparison from ${new Date(item.capturedAt).toLocaleString()}`} title="Delete this saved comparison" disabled={busy} onClick={() => remove(item.id)}><Icon name="trash" /></button></div>) : <p>No saved comparisons yet.</p>}</>}
      {menu === 'more' && <>
        {!installed && <button role="menuitem" disabled={busy} onClick={() => void run(async () => { await window.electronAPI.comparisonInstall(engine); await refresh(); setMenu(null) })}><Icon name="download" />Install {title} runtime</button>}
        <button role="menuitem" disabled={busy || !installed || !projectId} onClick={() => void run(async () => { await window.electronAPI.comparisonOpenLogin(engine, projectId!, getPageUrl()); setLoginOpen(true); setMenu(null) })}><Icon name="login" />Open browser login</button>
        {loginOpen && <button role="menuitem" disabled={busy} onClick={() => void run(async () => { await window.electronAPI.comparisonFinishLogin(engine, projectId!); setLoginOpen(false); setMenu(null) })}><Icon name="check" />Save browser login</button>}
        <button role="menuitem" disabled={busy || !projectId} onClick={() => void run(async () => { await window.electronAPI.comparisonClearSession(engine, projectId!); setLoginOpen(false); setMenu(null) })}><Icon name="close" />Clear browser login</button>
        {selected && <button role="menuitem" disabled={busy} onClick={() => void run(async () => { await window.electronAPI.comparisonExport(projectId!, selected.record.id); setMenu(null) })}><Icon name="download" />Export comparison</button>}
        {selected && <button role="menuitem" disabled={busy} onClick={() => remove(selected.record.id)}><Icon name="trash" />Delete current comparison</button>}
      </>}
    </div>}

    {busy && <div className="browser-comparison-status" role="status"><span className="browser-comparison-spinner" />{progress?.message || 'Working...'}{canCancel && <button title="Cancel capture" aria-label="Cancel capture" onClick={() => void window.electronAPI.comparisonCancel()}><Icon name="stop" /></button>}</div>}
    {error && <div className="browser-comparison-error" role="alert">{error}</div>}
    {!projectId && <div className="browser-comparison-empty">Save this project to keep browser comparisons.</div>}
    {projectId && !installed && <div className="browser-comparison-empty"><p>{title} is ready to add.</p><button disabled={busy} onClick={() => void run(async () => { await window.electronAPI.comparisonInstall(engine); await refresh() })}><Icon name="download" /> Install runtime</button></div>}
    {projectId && installed && !selected && <div className="browser-comparison-empty"><p>Capture the full page to compare it with Chromium.</p><button disabled={busy} onClick={capture}><Icon name="refresh" /> Capture full page</button></div>}

    {selected && <>
      <div className="browser-comparison-visual">
      <div className="browser-comparison-viewport" ref={viewport} onScroll={onViewportScroll}>
        <div className={`browser-comparison-images ${mode}`}>
          {imageKinds.map(kind => {
            const source = kind === 'chromium' ? selected.chromiumImage : selected.image
            const height = kind === 'chromium' ? chromiumHeight : imageHeight
            const canMark = annotating && kind !== 'chromium'
            return <div key={kind} className={`browser-comparison-image ${canMark ? 'is-marking' : ''}`} ref={kind !== 'chromium' ? surface : undefined} style={{ aspectRatio: `${selected.record.width} / ${height}` }}
              onPointerDown={canMark ? event => { const position = point(event); start.current = { ...position, id: crypto.randomUUID() }; event.currentTarget.setPointerCapture(event.pointerId) } : undefined}
              onPointerMove={canMark ? event => { if (!start.current) return; const position = point(event); setDraft({ id: start.current.id, x: Math.min(start.current.x, position.x), y: Math.min(start.current.y, position.y), width: Math.abs(start.current.x - position.x), height: Math.abs(start.current.y - position.y), note: '' }) } : undefined}
              onPointerUp={canMark ? () => { start.current = null; setDraft(current => current && current.width > .003 && current.height > .003 ? current : null) } : undefined}>
              {kind === 'difference' && <img src={selected.chromiumImage} className="browser-comparison-underlay" alt="" draggable={false} />}
              <img src={source} className={kind === 'difference' ? 'browser-comparison-difference' : ''} alt={kind === 'chromium' ? 'Chromium full-page capture' : `${title} full-page capture`} draggable={false} />
              {kind !== 'chromium' && <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Comparison annotations">{[...selected.record.annotations, ...(draft ? [draft] : [])].map((annotation, index) => <g key={annotation.id}><rect x={annotation.x * 100} y={annotation.y * 100} width={annotation.width * 100} height={annotation.height * 100} fill="#ed3b7033" stroke="#ed3b70" strokeWidth=".35"/><text x={annotation.x * 100 + .5} y={annotation.y * 100 + 2} fontSize="1.9" fill="#ed3b70">{index + 1}</text></g>)}</svg>}
            </div>
          })}
        </div>
      </div>
      {!!selected.record.pinnedHeaderHeight && !!selected.record.fullPage && scrollY > 1 && <div className={`browser-comparison-pinned ${mode}`} aria-label="Pinned header from captured page">
        {imageKinds.map(kind => <div key={kind} className="browser-comparison-pinned-column" style={{ aspectRatio: `${selected.record.width} / ${selected.record.pinnedHeaderHeight}` }}>
          {kind === 'difference' && <img src={selected.chromiumImage} alt="" draggable={false} />}
          <img src={kind === 'chromium' ? selected.chromiumImage : selected.image} className={kind === 'difference' ? 'browser-comparison-difference' : ''} alt="" draggable={false} />
        </div>)}
      </div>}
      </div>
      {draft && <form className="browser-comparison-note" onSubmit={event => { event.preventDefault(); changeAnnotations([...selected.record.annotations, { ...draft, note }]) }}><input autoFocus aria-label="Annotation note" value={note} onChange={event => setNote(event.target.value)} placeholder="Describe the difference"/><button type="submit" title="Save annotation"><Icon name="check" /></button><button type="button" title="Cancel annotation" onClick={() => setDraft(null)}><Icon name="close" /></button></form>}
      {annotating && !draft && <div className="browser-comparison-hint">Drag on the capture to mark a difference.</div>}
      {!!selected.record.annotations.length && <div className="browser-comparison-notes">{selected.record.annotations.map((annotation, index) => <div key={annotation.id}><span>{index + 1}. {annotation.note || 'Marked area'}</span><button title="Remove annotation" aria-label={`Remove annotation ${index + 1}`} onClick={() => changeAnnotations(selected.record.annotations.filter(item => item.id !== annotation.id))}><Icon name="trash" /></button></div>)}</div>}
    </>}
  </div>
}
