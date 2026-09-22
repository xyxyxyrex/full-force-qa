import { useEffect, useMemo, useRef, useState } from 'react'
import type { AutomateRunSummary, FindingTriageState, ProjectAutomateState } from '../../../shared/types'
import { findingToAnnotationSpec, semanticComparison, stableId, type AnnotationFromFindingSpec, type DomNode, type Finding } from '../utils/visualCompare'
import type { PixelComparison, ResultState } from '../../../shared/automation'
import { visualFindings } from '../../../shared/automationFindings'
import { ComparisonView } from '../automation/ComparisonView'
import './AutomateWorkspace.css'
import { usePaletteProvider } from '../palette/registry'
import { pageSearchExpression, pageBatch, type PageSearchResponse } from '../palette/pageSearch'

interface FrameSummary { id: string; name: string; type: string; pageName: string; path?: string; width: number; height: number }

// App-wide (not per-project) — the Figma token is one credential shared across
// every project, so the "have we ever confirmed one" hint should be too.
const FIGMA_CONNECTED_HINT_KEY = 'qa_automate_figma_connected'

interface Props {
  sourceUrl: string
  figmaUrl?: string
  projectId: string
  onOpenSettings?: () => void
  onCreateAnnotation?: (spec: AnnotationFromFindingSpec) => string
  automateState: ProjectAutomateState
  onAutomateStateChange: (state: ProjectAutomateState) => void
  pinnedFindingIds?: string[]
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(message)), milliseconds)
    promise.then((value) => { clearTimeout(timeout); resolve(value) }, (error) => { clearTimeout(timeout); reject(error) })
  })
}

export default function AutomateWorkspace({ sourceUrl, figmaUrl = '', projectId, onOpenSettings, onCreateAnnotation, automateState, onAutomateStateChange, pinnedFindingIds: persistedPinnedFindingIds = [] }: Props) {
  const webviewRef = useRef<any>(null)
  const comparisonRunRef = useRef(0)
  const activeVisualJobRef = useRef('')
  // This tab unmounts and remounts on every click into it, and whether a Figma
  // token is configured can only be confirmed asynchronously (over IPC). Without
  // this, `tokenConfigured` starts at `false` on every single mount and the
  // "Connect the Figma REST API" setup card renders before the check has had a
  // chance to resolve — visible every time, even once the check itself is fast.
  // Seed the initial render from the outcome of the last check instead.
  const [tokenConfigured, setTokenConfigured] = useState(() => localStorage.getItem(FIGMA_CONNECTED_HINT_KEY) === '1')
  const applyTokenConfigured = (configured: boolean) => {
    setTokenConfigured(configured)
    if (configured) localStorage.setItem(FIGMA_CONNECTED_HINT_KEY, '1')
    else localStorage.removeItem(FIGMA_CONNECTED_HINT_KEY)
  }
  const [token, setToken] = useState(''); const [showToken, setShowToken] = useState(false)
  const [designUrl, setDesignUrl] = useState(() => localStorage.getItem(`qa_${projectId}_automate_figma_url`) || figmaUrl)
  const [frames, setFrames] = useState<FrameSummary[]>([]); const [frameId, setFrameId] = useState(''); const [fileName, setFileName] = useState('')
  const [ready, setReady] = useState(false); const [busy, setBusy] = useState(false); const [status, setStatus] = useState('Connect a Figma frame to begin.'); const [error, setError] = useState('')
  const [designImage, setDesignImage] = useState(''); const [liveImage, setLiveImage] = useState('')
  const [progress, setProgress] = useState({ percent: 0, detail: '' })
  const [liveDocumentHeight, setLiveDocumentHeight] = useState<number | null>(null)
  const [selectedFindingIndex, setSelectedFindingIndex] = useState<number | null>(null)
  const [rawDesignNode, setRawDesignNode] = useState<any>(null)
  const [rawDomNodes, setRawDomNodes] = useState<DomNode[] | null>(null)
  const [rawVisualData, setRawVisualData] = useState<PixelComparison | null>(null)
  const triage = automateState.triage
  const [showTriaged, setShowTriaged] = useState(false)
  const [styleNames, setStyleNames] = useState<Record<string, string>>({})
  const [breakpoint, setBreakpoint] = useState<'Desktop' | 'Tablet' | 'Mobile'>('Desktop')
  const [lastCompletedRunId, setLastCompletedRunId] = useState(0)
  // The persisted annotation itself is the source of truth for pin state.
  const pinnedFindingIds = useMemo(() => new Set(persistedPinnedFindingIds), [persistedPinnedFindingIds])
  // Starts empty on purpose — nothing is pinned until explicitly checked.
  const [selectedForAnnotation, setSelectedForAnnotation] = useState<Set<string>>(new Set())
  const selectedFrame = useMemo(() => frames.find((frame) => frame.id === frameId), [frameId, frames])
  const runHistory = useMemo(
    () => selectedFrame ? automateState.runsByFrame[selectedFrame.id] || [] : [],
    [automateState.runsByFrame, selectedFrame]
  )

  useEffect(() => {
    // This tab unmounts and remounts on every click (conditional render in
    // EditorWorkspace), so a live API round-trip here means every click into
    // Automate depends on Figma answering right now. Read the stored-token
    // state instead — instant, no network — and only actually calling Figma
    // (loadFrames / runComparison) will ever surface a truly revoked token.
    const syncStatus = () => window.electronAPI.figmaTokenStatus(false).then((result) => applyTokenConfigured(result.apiConfigured)).catch(() => { })
    void syncStatus()
    return window.electronAPI.onFigmaAuthChanged?.((result) => applyTokenConfigured(result.apiConfigured))
  }, [])

  // A frame's own width is a reasonable guess at its breakpoint; the analyst can
  // override it when tagging runs for history, since guesses aren't always right.
  useEffect(() => {
    if (!selectedFrame) return
    setBreakpoint(selectedFrame.width < 600 ? 'Mobile' : selectedFrame.width < 1024 ? 'Tablet' : 'Desktop')
  }, [selectedFrame])

  const applyTriage = (findingId: string, state: FindingTriageState | null) => {
    const next = { ...triage }
    if (state) next[findingId] = { state, at: Date.now() }
    else delete next[findingId]
    onAutomateStateChange({ ...automateState, triage: next })
  }
  useEffect(() => { if (figmaUrl && !designUrl) setDesignUrl(figmaUrl) }, [designUrl, figmaUrl])
  useEffect(() => {
    const view = webviewRef.current
    if (!view) return
    const loaded = () => setReady(true)
    const loading = () => setReady(false)
    const failed = (event: any) => {
      if (event?.errorCode === -3) return
      setReady(false)
      setError(`The staging capture browser could not load the page${event?.errorDescription ? `: ${event.errorDescription}` : '.'}`)
    }
    view.addEventListener('did-start-loading', loading)
    view.addEventListener('dom-ready', loaded)
    view.addEventListener('did-finish-load', loaded)
    view.addEventListener('did-fail-load', failed)
    try { if (view.getWebContentsId?.()) view.executeJavaScript('document.readyState', true).then((state: string) => { if (state === 'interactive' || state === 'complete') loaded() }).catch(() => { }) } catch { }
    return () => {
      view.removeEventListener('did-start-loading', loading)
      view.removeEventListener('dom-ready', loaded)
      view.removeEventListener('did-finish-load', loaded)
      view.removeEventListener('did-fail-load', failed)
    }
  }, [sourceUrl])

  const connect = async () => {
    setBusy(true); setError('')
    try {
      const result = await window.electronAPI.setFigmaToken(token.trim())
      applyTokenConfigured(result.success && result.configured)
      if (result.success && result.configured) { setToken(''); setShowToken(false); setStatus('Figma API connected securely. Load a design to verify file access.') }
      else setError(result.error || 'Unable to save the Figma token.')
    } catch (cause: any) {
      setError(cause?.message || 'The Figma connection service did not respond. Restart the application and try again.')
    } finally { setBusy(false) }
  }
  const loadFrames = async () => {
    if (!designUrl.trim()) return setError('Enter a Figma design URL.')
    setBusy(true); setError(''); setStatus('Reading Figma frame structure…')
    try {
      const result = await window.electronAPI.listFigmaFrames(designUrl.trim())
      if (!result.success) throw new Error(result.error || 'Unable to read the Figma file.')
      const nextFrames = result.frames || []; setFrames(nextFrames); setFileName(result.fileName || 'Figma design')
      setStyleNames(result.styleNames || {})
      setRawVisualData(null); setRawDesignNode(null); setRawDomNodes(null)
      const requested = nextFrames.find((frame) => frame.id === result.requestedNodeId)?.id
      setFrameId(requested || nextFrames[0]?.id || ''); localStorage.setItem(`qa_${projectId}_automate_figma_url`, designUrl.trim())
      setStatus(`${nextFrames.length} comparable frames found.`)
    } catch (cause: any) {
      setError(cause?.message || 'Figma retrieval unavailable.'); setStatus('Design source unavailable.')
    } finally { setBusy(false) }
  }
  const runComparison = async () => {
    if (!selectedFrame) return setError('Select a Figma frame first.')
    if (!webviewRef.current) return setError('The staging capture browser is not attached yet.')
    const runId = ++comparisonRunRef.current
    const visualJobId = `${projectId}:${crypto.randomUUID()}`
    activeVisualJobRef.current = visualJobId
    const cancelled = () => comparisonRunRef.current !== runId
    const updateProgress = (percent: number, detail: string) => { if (!cancelled()) { setProgress({ percent: Math.round(percent), detail }); setStatus(detail) } }
    setBusy(true); setError(''); setStatus('Preparing comparison…'); setProgress({ percent: 4, detail: 'Preparing comparison…' }); setSelectedFindingIndex(null); setRawVisualData(null); setRawDesignNode(null); setRawDomNodes(null); setSelectedForAnnotation(new Set())
    try {
      const view = webviewRef.current
      updateProgress(8, 'Checking the authenticated staging page…')
      if (!ready) {
        const documentState = await withTimeout(view.executeJavaScript('document.readyState', true), 12000, 'The staging page did not become ready within 12 seconds.')
        if (documentState !== 'interactive' && documentState !== 'complete') throw new Error('The authenticated staging page is still loading. Try again in a moment.')
        setReady(true)
      }
      updateProgress(14, 'Rendering the selected Figma frame…')
      const design = await withTimeout(window.electronAPI.getFigmaFrame(designUrl.trim(), selectedFrame.id), 45000, 'Figma did not return the selected frame within 45 seconds. Check the token, file access, or rate limit and try again.')
      if (!design.success || !design.node || !design.imageDataUrl) throw new Error(design.error || 'Unable to render the Figma frame.')
      if (cancelled()) throw new Error('Comparison cancelled.')
      updateProgress(24, 'Capturing verified Chromium tiles through DevTools…')
      const webContentsId = view.getWebContentsId?.()
      if (!webContentsId) throw new Error('The staging webview has no Chromium content identifier.')
      const liveCapture = await withTimeout(window.electronAPI.captureAutomatePage(webContentsId, captureWidth, captureViewportHeight), 90_000, 'The DevTools Chromium capture exceeded 90 seconds and was stopped.')
      if (!liveCapture?.success || !liveCapture.dataUrl) throw new Error(liveCapture?.error || 'The DevTools Chromium capture failed.')
      if (cancelled()) throw new Error('Comparison cancelled.')
      updateProgress(73, 'Reading live semantic layout…')
      if (!Array.isArray(liveCapture.domNodes)) throw new Error('Capture did not return a semantic snapshot.')
      const domNodes = liveCapture.domNodes as DomNode[]
      const liveHeight = liveCapture.documentHeight || captureViewportHeight
      updateProgress(80, 'Comparing native-resolution pixels…')
      const response = await withTimeout(window.electronAPI.compareVisuals(visualJobId, design.imageDataUrl, liveCapture.dataUrl), 95_000, 'Pixel comparison timed out.')
      if (!response.success) throw new Error(response.error)
      const visual = response.result
      if (cancelled()) throw new Error('Comparison cancelled.')
      updateProgress(92, 'Matching Figma layers to live elements…')
      if (!cancelled()) {
        setRawDesignNode(design.node)
        setRawDomNodes(domNodes)
        setRawVisualData(visual)
        setDesignImage(design.imageDataUrl); setLiveImage(liveCapture.dataUrl); setLiveDocumentHeight(liveHeight)
        setProgress({ percent: 100, detail: 'Comparison complete' }); setStatus('Comparison complete — review coverage and evidence.')
        setLastCompletedRunId(runId)
      }
    } catch (cause: any) {
      if (!cancelled()) { const message = cause?.message || 'Comparison failed.'; setError(message); setStatus(message === 'Comparison cancelled.' ? 'Comparison cancelled.' : 'Comparison stopped.'); setProgress({ percent: 0, detail: '' }) }
    } finally { void window.electronAPI.cancelVisualComparison(visualJobId); if (activeVisualJobRef.current === visualJobId) activeVisualJobRef.current = ''; if (!cancelled()) setBusy(false) }
  }

  const cancelComparison = () => {
    const visualJobId = activeVisualJobRef.current
    if (visualJobId) { void window.electronAPI.cancelVisualComparison(visualJobId); activeVisualJobRef.current = '' }
    comparisonRunRef.current++
    setBusy(false); setProgress({ percent: 0, detail: '' }); setStatus('Comparison cancelled.'); setError('Comparison cancelled before completion.')
  }

  const captureWidth = selectedFrame?.width || 1440
  const captureViewportHeight = 1200

  const semantic = useMemo(() => rawDesignNode && rawDomNodes && rawVisualData
    ? semanticComparison(rawDesignNode, rawDomNodes, rawVisualData.live.width, rawVisualData.live.height, styleNames)
    : null, [rawDesignNode, rawDomNodes, rawVisualData, styleNames])
  const findings = useMemo(() => {
    if (!rawVisualData) return []
    const order: Record<ResultState,number> = {fail:0,visual:1,ambiguous:2,unavailable:3,ignored:4,pass:5}
    return [...visualFindings(rawVisualData), ...(semantic?.findings || [])].sort((a,b)=>order[a.state]-order[b.state])
  }, [rawVisualData, semantic])
  const visibleFindings = useMemo(() => findings.map(f => triage[f.id] ? { ...f, state: 'ignored' as const } : f)
    .filter(f => showTriaged || f.state !== 'ignored'), [findings, triage, showTriaged])
  const resultCounts = useMemo(() => Object.fromEntries(
    (['pass','fail','visual','ambiguous','ignored','unavailable'] as ResultState[]).map(state =>
      [state, findings.filter(f => (triage[f.id] ? 'ignored' : f.state) === state).length])
  ) as Record<ResultState,number>, [findings,triage])
  useEffect(() => () => {
    comparisonRunRef.current++
    if (activeVisualJobRef.current) void window.electronAPI.cancelVisualComparison(activeVisualJobRef.current)
  }, [])
  const isPinnable = (finding: Finding) => (finding.state === 'fail' || finding.state === 'visual') && !!finding.comparison?.live && !triage[finding.id]
  const pinFinding = (finding: Finding) => {
    if (!onCreateAnnotation || pinnedFindingIds.has(finding.id)) return
    const spec = findingToAnnotationSpec(finding, breakpoint, captureWidth, liveDocumentHeight ?? captureViewportHeight)
    if (!spec) return
    onCreateAnnotation(spec)
    setSelectedForAnnotation((current) => { if (!current.has(finding.id)) return current; const next = new Set(current); next.delete(finding.id); return next })
  }

  // Nothing is selected by default and nothing gets sent unless explicitly
  // checked — a bulk action that auto-includes everything untriaged means
  // mistakes only get caught after the fact, as annotations that then need
  // cleaning up. Selection persists across findings-tab switches so the
  // analyst can review Tokens, then Layout, and accumulate a batch.
  const toggleAnnotationSelection = (findingId: string) => {
    setSelectedForAnnotation((current) => {
      const next = new Set(current)
      if (next.has(findingId)) next.delete(findingId)
      else next.add(findingId)
      return next
    })
  }
  const selectedPinnableCount = useMemo(
    () => findings.filter((f) => selectedForAnnotation.has(f.id) && isPinnable(f) && !pinnedFindingIds.has(f.id)).length,
    [findings, selectedForAnnotation, pinnedFindingIds]
  )
  const pinSelectedFindings = () => {
    if (!onCreateAnnotation) return
    const toPin = findings.filter((f) => selectedForAnnotation.has(f.id) && isPinnable(f) && !pinnedFindingIds.has(f.id))
    if (!toPin.length) return
    const pinnedIds: string[] = []
    for (const finding of toPin) {
      const spec = findingToAnnotationSpec(finding, breakpoint, captureWidth, liveDocumentHeight ?? captureViewportHeight)
      if (!spec) continue
      onCreateAnnotation(spec)
      pinnedIds.push(finding.id)
    }
    setSelectedForAnnotation((current) => { const next = new Set(current); for (const id of pinnedIds) next.delete(id); return next })
  }

  // Severity-weighted counts — a defect list that can be triaged, not a raster
  // similarity percentage nobody can act on.
  const severityCounts = useMemo(() => ({
    high: visibleFindings.filter((f) => f.severity === 'high').length,
    medium: visibleFindings.filter((f) => f.severity === 'medium').length,
    low: visibleFindings.filter((f) => f.severity === 'low').length,
    pass: visibleFindings.filter((f) => f.severity === 'pass').length
  }), [visibleFindings])

  // Records a lightweight trend point once per completed run — never on triage
  // changes or re-renders, only when a comparison actually finished. Reads the
  // freshest findings/severity/score via closure since this fires in the same
  // commit those values updated in.
  useEffect(() => {
    if (!lastCompletedRunId || !selectedFrame) return
    const summary: AutomateRunSummary = {
      id: stableId(selectedFrame.id, String(lastCompletedRunId), String(Date.now())),
      frameId: selectedFrame.id,
      frameName: selectedFrame.name,
      breakpoint,
      captureWidth,
      at: Date.now(),
      severityCounts,
      resultCounts,
      findingsCount: findings.length
    }
    const frameRuns = [summary, ...(automateState.runsByFrame[selectedFrame.id] || [])]
      .filter((run, index, all) => all.findIndex((candidate) => candidate.id === run.id) === index)
      .sort((left, right) => right.at - left.at)
      .slice(0, 30)
    onAutomateStateChange({
      ...automateState,
      runsByFrame: { ...automateState.runsByFrame, [selectedFrame.id]: frameRuns }
    })
    // Deliberately keyed only on lastCompletedRunId — see comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastCompletedRunId])

  const [findingsFilter, setFindingsFilter] = useState<ResultState | 'all'>('all')
  const [findingPage, setFindingPage] = useState(0)
  useEffect(() => setFindingPage(0), [findingsFilter, lastCompletedRunId, showTriaged])
  const filteredFindings = visibleFindings.filter(f => findingsFilter === 'all' || f.state === findingsFilter)
  const pageCount = Math.max(1, Math.ceil(filteredFindings.length / 50))
  const currentPage = Math.min(findingPage, pageCount - 1)
  const pageFindings = filteredFindings.slice(currentPage * 50, (currentPage + 1) * 50)
  const displayValue = (value: unknown) => value === undefined ? 'Not available' : typeof value === 'string' ? value : JSON.stringify(value)
  usePaletteProvider({
    id: 'automate-page', label: 'Automate page',
    search: async (query, signal, options) => {
      if (!['All', 'Page', 'Files'].includes(options.group)) return { items: [] }
      const view = webviewRef.current
      if (!view || !ready) throw new Error('Wait for the Automate page to load.')
      const response = await view.executeJavaScript(pageSearchExpression({ action: 'search', query, limit: options.limit, kind: options.group === 'All' ? undefined : options.group as 'Page' | 'Files' }), true) as PageSearchResponse
      if (signal.aborted) return { items: [] }
      return pageBatch(response, (token, id) => view.executeJavaScript(pageSearchExpression({ action: 'reveal', token, id }), true))
    },
    release: () => { void webviewRef.current?.executeJavaScript(pageSearchExpression({ action: 'release' })).catch(() => {}) },
  })

  return <div className="automate-workspace">
    <webview ref={webviewRef} className="automate-capture-webview" src={sourceUrl} webpreferences="backgroundThrottling=no" style={{ width: captureWidth, height: captureViewportHeight }} />
    <div className="automate-capture-shield" aria-hidden="true" />
    <header className="automate-header">
      <div><span className="automate-kicker">Design QA</span><h2>Automate</h2><p>{status}</p></div>
      <div className="automate-header-controls">
        <div className={`automate-api-state ${tokenConfigured ? 'connected' : ''}`}><i />{tokenConfigured ? 'Figma API connected' : 'Figma API required'}</div>
        {onOpenSettings && (
          <button
            className="automate-engine-toggle"
            onClick={onOpenSettings}
            title="App Settings: Themes, Snapshot Storage Directory, Hotkeys & Integrations"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span>Settings</span>
          </button>
        )}
      </div>
    </header>
    {!tokenConfigured ? (
      <section className="automate-setup-card">
        <div className="automate-setup-icon"><svg viewBox="0 0 24 24"><path d="M8 3h8a5 5 0 0 1 0 10H8a5 5 0 0 1 0-10Zm0 8h5v5a5 5 0 1 1-5-5Zm5 0h3a5 5 0 1 1-3 5v-5Z" /></svg></div>
        <div><h3>Connect the Figma REST API</h3><p>Create a personal access token with <code>file_content:read</code>. It is encrypted using the operating system credential service and handled only by Electron’s main process.</p>
          <div className="automate-token-row"><input type={showToken ? 'text' : 'password'} value={token} onChange={(event) => setToken(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && token.trim() && !busy) void connect() }} placeholder="figd_…" /><button className="automate-icon-btn" onClick={() => setShowToken((value) => !value)} title={showToken ? 'Hide token' : 'Show token'}><svg viewBox="0 0 24 24"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg></button><button className="automate-primary" disabled={!token.trim() || busy} onClick={connect}>{busy ? 'Connecting…' : 'Connect'}</button></div>
          {error && <div className="automate-error automate-setup-error">{error}</div>}
          <button className="automate-link" onClick={() => window.electronAPI.openExternal('https://www.figma.com/developers/api#access-tokens')}>Open Figma token settings ↗</button>
        </div>
      </section>
    ) : (
      <>
        <section className="automate-source-bar">
          <label><span>Figma design</span><input disabled={busy} value={designUrl} onChange={(event) => setDesignUrl(event.target.value)} placeholder="https://www.figma.com/design/…?node-id=…" /></label>
          <button className="automate-secondary" disabled={busy || !designUrl.trim()} onClick={loadFrames}>Load frames</button>
          <label className="automate-frame-select"><span>Frame</span><select value={frameId} onChange={(event) => setFrameId(event.target.value)} disabled={busy || !frames.length}><option value="">Select a frame</option>{frames.map((frame) => <option key={frame.id} value={frame.id}>{frame.pageName}{frame.path ? ` / ${frame.path}` : ''} / {frame.name} · {frame.width}×{frame.height}</option>)}</select></label>
          <label className="automate-breakpoint-select" title="Tags this run in history — guessed from the frame's width, override if it's wrong"><span>Breakpoint</span><select disabled={busy} value={breakpoint} onChange={(event) => setBreakpoint(event.target.value as typeof breakpoint)}><option value="Desktop">Desktop</option><option value="Tablet">Tablet</option><option value="Mobile">Mobile</option></select></label>
          {busy ? <button className="automate-secondary automate-cancel" onClick={cancelComparison}>Cancel</button> : <button className="automate-primary" disabled={!selectedFrame} onClick={runComparison} title={ready ? 'Run visual and semantic comparison' : 'The staging page will be checked before comparison starts'}>Run comparison</button>}
          <button disabled={busy} className="automate-icon-btn" title="Replace Figma API token" onClick={async () => { await window.electronAPI.setFigmaToken(''); applyTokenConfigured(false) }}><svg viewBox="0 0 24 24"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5v.2h-4v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1-2.8-2.8.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3v-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1 2.8-2.8.1.1a1.7 1.7 0 0 0 1.8.3 1.7 1.7 0 0 0 1-1.5V3h4v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1 2.8 2.8-.1.1a1.7 1.7 0 0 0-.3 1.8 1.7 1.7 0 0 0 1.5 1h.2v4h-.2a1.7 1.7 0 0 0-1.4 1Z" /></svg></button>
        </section>

        {busy && <section className="automate-progress" aria-live="polite"><div><span>{progress.detail || 'Comparing…'}</span><strong>{progress.percent}%</strong></div><i><b style={{ width: `${progress.percent}%` }} /></i></section>}
        {error && <div className="automate-error">{error}</div>}
        {!rawVisualData ? <section className="automate-empty">
          <h3>{busy ? 'Comparison in progress' : 'Choose a Figma frame and run a comparison'}</h3>
          <p>Design source: {fileName || 'Live Figma API'} · Viewport: {captureWidth} × {captureViewportHeight}, device scale 1.</p>
          <p>Screenshot dimensions and positional differences are preserved. A failed capture or comparison is unavailable, never a pass.</p>
        </section> : <div className="automate-results">
          <section className="automate-coverage">
            <strong>Design source: {fileName || 'Live Figma API'} / {rawDesignNode?.name || 'Selected frame'}</strong>
            <span>Viewport {rawVisualData.live.width} × {captureViewportHeight} · Design {rawVisualData.design.width} × {rawVisualData.design.height} · Live {rawVisualData.live.width} × {rawVisualData.live.height}</span>
            <span>Pixel coverage: {rawVisualData.overlap.width} × {rawVisualData.overlap.height} native overlap. Outside overlap: {rawVisualData.excludedPixels.design.toLocaleString()} design / {rawVisualData.excludedPixels.live.toLocaleString()} live pixels.</span>
            <span>Text coverage: {semantic?.coverage.processedTextNodes}/{semantic?.coverage.designTextNodes} nodes processed; {semantic?.coverage.matchedTextNodes} strong mappings; {semantic?.coverage.ambiguousTextNodes} unresolved. Image identity validation unavailable.</span>
            <span>Ignored: {resultCounts.ignored} triaged findings. Region masking is not implemented.</span>
          </section>
          <div className="automate-result-grid">
            <ComparisonView designImage={designImage} liveImage={liveImage} result={rawVisualData}
              finding={selectedFindingIndex === null ? undefined : findings[selectedFindingIndex]} />
            <section className="automate-findings">
              <div className="automate-card-head"><h3>Findings</h3>
                <label className="automate-triage-toggle"><input type="checkbox" checked={showTriaged} onChange={e=>setShowTriaged(e.target.checked)} />Show ignored</label>
                {onCreateAnnotation && <button className="automate-secondary" disabled={!selectedPinnableCount} onClick={pinSelectedFindings}>Pin selected ({selectedPinnableCount})</button>}
              </div>
              <div className="automate-findings-tabs" aria-label="Filter findings">
                {(['all','fail','visual','ambiguous','pass','unavailable','ignored'] as const).map(state=>
                  <button key={state} aria-pressed={findingsFilter===state} className={findingsFilter===state?'active':''}
                    onClick={()=>{setFindingsFilter(state);if(state==='ignored')setShowTriaged(true)}}>
                    {{all:'All',fail:'Verified differences',visual:'Visual only',ambiguous:'Ambiguous',pass:'Passed checks',unavailable:'Unavailable',ignored:'Ignored'}[state]}
                    {' '}({state==='all'?findings.length:resultCounts[state]})
                  </button>)}
              </div>
              <div className="automate-findings-list">
                {pageFindings.map(finding=><article key={finding.id} className={findings[selectedFindingIndex ?? -1]?.id === finding.id ? 'selected' : ''}>
                  <div className="automate-finding-heading">
                    {onCreateAnnotation && isPinnable(finding) && !pinnedFindingIds.has(finding.id) &&
                      <input aria-label={'Select '+finding.title} type="checkbox" checked={selectedForAnnotation.has(finding.id)} onChange={()=>toggleAnnotationSelection(finding.id)} />}
                    <button onClick={()=>setSelectedFindingIndex(findings.findIndex(f=>f.id===finding.id))}>{finding.title}</button>
                  </div>
                  <div className="automate-chips"><span>{finding.state}</span><span>{finding.evidenceStrength} evidence</span>{finding.state==='fail'&&<span>{finding.severity} severity</span>}</div>
                  <details><summary>Evidence and actions</summary>
                    <p>{finding.detail}</p>
                    <dl className="automate-evidence">
                      <dt>Expected</dt><dd>{displayValue(finding.expected)}</dd>
                      <dt>Actual</dt><dd>{displayValue(finding.actual)}</dd>
                      <dt>Measured Difference</dt><dd>{displayValue(finding.difference || finding.comparison?.delta)}</dd>
                      <dt>Evidence Type</dt><dd>{finding.evidenceStrength}</dd>
                    </dl>
                    {finding.tokens && <table className="automate-token-table"><thead><tr><th>Property</th><th>Expected</th><th>Actual</th><th>State</th></tr></thead><tbody>
                      {finding.tokens.map(token=><tr key={token.name}><td>{token.name}</td><td>{token.figma}</td><td>{token.css}</td><td>{token.unresolved?'unavailable':token.passed?'pass':'fail'}</td></tr>)}
                    </tbody></table>}
                    {finding.matchQuality && <p>Mapping: {finding.matchQuality.reason}</p>}
                    <div className="automate-triage-row">
                      {triage[finding.id] ? <button onClick={()=>applyTriage(finding.id,null)}>Restore finding</button> :
                        <><button onClick={()=>applyTriage(finding.id,'accepted')}>Accept baseline</button><button onClick={()=>applyTriage(finding.id,'false-positive')}>False positive</button><button onClick={()=>applyTriage(finding.id,'ignored')}>Ignore</button></>}
                      {onCreateAnnotation && isPinnable(finding) && <button disabled={pinnedFindingIds.has(finding.id)} onClick={()=>pinFinding(finding)}>{pinnedFindingIds.has(finding.id)?'Pinned':'Pin annotation'}</button>}
                    </div>
                  </details>
                </article>)}
                {!pageFindings.length && <p className="automate-no-findings">No findings in this filter.</p>}
              </div>
              <div className="automate-pagination"><button disabled={!currentPage} onClick={()=>setFindingPage(currentPage-1)}>Previous</button>
                <span>Page {currentPage+1} / {pageCount} · {filteredFindings.length} findings</span>
                <button disabled={currentPage+1>=pageCount} onClick={()=>setFindingPage(currentPage+1)}>Next</button></div>
            </section>
          </div>
          <details className="automate-developer"><summary>Developer details</summary>
            <p>Pixel engine: {rawVisualData.engine}. Changed pixels: {rawVisualData.changedPixels.toLocaleString()} / {rawVisualData.comparedPixels.toLocaleString()} ({rawVisualData.changedPercent.toFixed(3)}% of overlap, not confidence).</p>
            <p>Pixel threshold: {rawVisualData.options.pixelThreshold}. Include anti-aliased pixels: {String(rawVisualData.options.includeAA)}. No resizing, warping, registration, or local offset search.</p>
            <p>Geometry tolerance: 3 CSS px. Declared/computed typography does not prove rendered font identity. Capture freezes animations. Fixed/sticky content is included in the first viewport only; later occurrences are suppressed. Dynamic widgets and nested scrolling need later coverage work.</p>
          </details>
        </div>}
        {!!runHistory.length && <details className="automate-history-panel"><summary>Run history ({runHistory.length})</summary>
          {runHistory.map(run=><div key={run.id} className="automate-history-entry"><span>{new Date(run.at).toLocaleString()} · {run.breakpoint} · {run.findingsCount} findings</span>
            <span>{run.resultCounts ? `${run.resultCounts.fail} verified differences · ${run.resultCounts.visual} visual · ${run.resultCounts.ambiguous} ambiguous` : 'Legacy run — evidence classification unavailable'}</span></div>)}
        </details>}
      </>
    )}
  </div>
}
