import { useEffect, useRef, useState, useCallback } from 'react'
import { initEditor, loadMissingFonts } from '../grapesjs/init'
import type { Editor } from 'grapesjs'
import './EditorWorkspace.css'

interface Props {
  html: string
  sourceUrl: string
  onReset: () => void
  onNewCapture: () => void
}

type DevicePreset = 'Desktop' | 'Tablet' | 'Mobile'
type ViewportMode = 'preset' | 'free'

interface Guide {
  axis: 'x' | 'y'
  position: number // 0–1 fraction of content width (y) or height (x)
}

const PRESETS: Record<DevicePreset, { w: number; h: number; label: string }> = {
  Desktop: { w: 1900, h: 1200, label: '1900×1200' },
  Tablet:  { w: 1199, h: 768,  label: '1199×768' },
  Mobile:  { w: 767,  h: 329,  label: '767×329' }
}

const ZOOM_MIN = 25
const ZOOM_MAX = 200
const ZOOM_STEP = 10

export default function EditorWorkspace({
  html,
  sourceUrl,
  onReset,
  onNewCapture
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasWrapRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Editor | null>(null)

  const [activePreset, setActivePreset] = useState<DevicePreset>('Desktop')
  const [mode, setMode] = useState<ViewportMode>('preset')
  const [vpWidth, setVpWidth] = useState(1900)
  const [vpHeight, setVpHeight] = useState(1200)
  const [zoom, setZoom] = useState(100)
  const [resetting, setResetting] = useState(false)
  const [frameRect, setFrameRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null)
  const [missingFonts, setMissingFonts] = useState<string[]>([])
  const [loadingFonts, setLoadingFonts] = useState(false)
  const [fontsAttempted, setFontsAttempted] = useState(false)

  // ── Panel resize state ────────────────────────
  const [leftPanelWidth, setLeftPanelWidth] = useState(260)
  const [rightPanelWidth, setRightPanelWidth] = useState(260)
  const panelDragRef = useRef<{ side: 'left' | 'right'; startX: number; startWidth: number } | null>(null)

  // ── Rulers & guides state ─────────────────────
  const [rulersOn, setRulersOn] = useState(false)
  const [guidesOn, setGuidesOn] = useState(true)
  const [guidesAlwaysVisible, setGuidesAlwaysVisible] = useState(false)
  const [guides, setGuides] = useState<Guide[]>([])
  const [draggingGuide, setDraggingGuide] = useState<Guide | null>(null)
  const [rulerDropdownOpen, setRulerDropdownOpen] = useState(false)
  const [addGuidesOpen, setAddGuidesOpen] = useState(false)
  const [layoutColumns, setLayoutColumns] = useState(3)
  const [layoutRows, setLayoutRows] = useState(3)
  const [layoutMargin, setLayoutMargin] = useState(0)
  const [layoutClear, setLayoutClear] = useState(true)
  const hRulerRef = useRef<HTMLCanvasElement>(null)
  const vRulerRef = useRef<HTMLCanvasElement>(null)
  const canvasInnerRef = useRef<HTMLDivElement>(null)
  const rulerDropdownRef = useRef<HTMLDivElement>(null)

  // ── Canvas frame tracking (iframe position within canvas-inner) ──
  const [canvasFrame, setCanvasFrame] = useState<{ left: number; top: number; width: number; height: number } | null>(null)

  const getCanvasFrame = useCallback(() => {
    const editor = editorRef.current
    const inner = canvasInnerRef.current
    if (!editor || !inner) return null
    const frameEl = editor.Canvas.getFrameEl()
    const wrapper = frameEl?.parentElement
    if (!wrapper) return null
    const innerRect = inner.getBoundingClientRect()
    const wrapperRect = wrapper.getBoundingClientRect()
    return {
      left: wrapperRect.left - innerRect.left,
      top: wrapperRect.top - innerRect.top,
      width: wrapperRect.width,
      height: wrapperRect.height
    }
  }, [])

  // ── Font inspector state ──────────────────────
  const [fontInspectorOn, setFontInspectorOn] = useState(false)
  const fontInspectorCleanupRef = useRef<(() => void) | null>(null)

  // ── Boundaries (element inspection) state ─────
  const [boundariesOn, setBoundariesOn] = useState(false)
  const [showMargins, setShowMargins] = useState(true)
  const [showPaddings, setShowPaddings] = useState(true)
  const [showDimensions, setShowDimensions] = useState(true)
  const [showGaps, setShowGaps] = useState(true)
  const [boundariesDropdownOpen, setBoundariesDropdownOpen] = useState(false)
  const boundariesDropdownRef = useRef<HTMLDivElement>(null)
  const boundariesCleanupRef = useRef<(() => void) | null>(null)
  const bdOptsRef = useRef({ showMargins: true, showPaddings: true, showDimensions: true, showGaps: true })
  const bdLockedRef = useRef<HTMLElement | null>(null)
  const bdHoveredRef = useRef<HTMLElement | null>(null)
  const bdContainerRef = useRef<HTMLDivElement | null>(null)
  const bdDocRef = useRef<Document | null>(null)
  const bdRedrawRef = useRef<(() => void) | null>(null)

  // ── Color palette state ──────────────────────
  const [pageColors, setPageColors] = useState<{ hex: string; count: number }[]>([])
  const [selectedColors, setSelectedColors] = useState<Set<string>>(new Set())

  // ── Editor lifecycle ──────────────────────────
  useEffect(() => {
    if (!containerRef.current) return
    setFontsAttempted(false)
    setMissingFonts([])
    const editor = initEditor(containerRef.current, html, {
      onMissingFonts: (fonts) => setMissingFonts(fonts)
    })
    editorRef.current = editor
    return () => { editor.destroy() }
  }, [html])

  // ── Helpers to push dimensions into GrapesJS ──
  const applyDimensions = useCallback((w: number, h: number) => {
    const editor = editorRef.current
    if (!editor) return

    // Update or add the Custom device, then switch to it
    const devices = editor.Devices
    const existing = devices.get('Custom')
    if (existing) {
      existing.set({ width: `${w}px`, height: `${h}px` })
    }
    editor.setDevice('Custom')

    // Also directly size the canvas frame for height
    const frame = editor.Canvas.getFrameEl()
    if (frame) {
      frame.style.height = `${h}px`
    }
  }, [])

  // ── Preset buttons ────────────────────────────
  const switchPreset = (preset: DevicePreset) => {
    setActivePreset(preset)
    setMode('preset')
    const { w, h } = PRESETS[preset]
    setVpWidth(w)
    setVpHeight(h)

    const editor = editorRef.current
    if (!editor) return
    editor.setDevice(preset)

    // Reset frame height to auto for presets
    const frame = editor.Canvas.getFrameEl()
    if (frame) frame.style.height = ''
  }

  // ── Free-transform mode ───────────────────────
  const enterFreeMode = () => {
    setMode('free')
    setActivePreset('Desktop') // deselect presets visually
    applyDimensions(vpWidth, vpHeight)
  }

  // ── Custom dimension inputs ───────────────────
  const commitWidth = (val: string) => {
    const n = parseInt(val, 10)
    if (!n || n < 100) return
    setVpWidth(n)
    setMode('free')
    applyDimensions(n, vpHeight)
  }

  const commitHeight = (val: string) => {
    const n = parseInt(val, 10)
    if (!n || n < 100) return
    setVpHeight(n)
    setMode('free')
    applyDimensions(vpWidth, n)
  }

  const swapDimensions = () => {
    const newW = vpHeight
    const newH = vpWidth
    setVpWidth(newW)
    setVpHeight(newH)
    setMode('free')
    applyDimensions(newW, newH)
  }

  // ── Zoom ──────────────────────────────────────
  const applyZoom = useCallback((level: number) => {
    const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level))
    setZoom(clamped)
    editorRef.current?.Canvas.setZoom(clamped)
  }, [])

  const zoomIn = () => applyZoom(zoom + ZOOM_STEP)
  const zoomOut = () => applyZoom(zoom - ZOOM_STEP)
  const zoomFit = () => applyZoom(100)

  // ── Ctrl+scroll zoom on the canvas area ───────
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const dir = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP
      setZoom((prev) => {
        const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, prev + dir))
        editorRef.current?.Canvas.setZoom(next)
        return next
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // ── Track canvas frame continuously for guide positioning ──
  // Uses requestAnimationFrame to follow panning, scrolling, zoom, and resize.
  // Only sets state when values actually change to avoid unnecessary re-renders.
  useEffect(() => {
    let raf: number
    let lastKey = ''
    const track = () => {
      const f = getCanvasFrame()
      if (f) {
        const key = `${Math.round(f.left)},${Math.round(f.top)},${Math.round(f.width)},${Math.round(f.height)}`
        if (key !== lastKey) {
          lastKey = key
          setCanvasFrame(f)
        }
      }
      raf = requestAnimationFrame(track)
    }
    raf = requestAnimationFrame(track)
    return () => cancelAnimationFrame(raf)
  }, [getCanvasFrame])

  // ── Track GrapesJS frame wrapper position ──────
  useEffect(() => {
    if (mode !== 'free') {
      setFrameRect(null)
      return
    }
    const wrapEl = canvasWrapRef.current
    if (!wrapEl) return

    let raf: number
    const track = () => {
      const editor = editorRef.current
      if (!editor) { raf = requestAnimationFrame(track); return }

      const frameEl = editor.Canvas.getFrameEl()
      const frameWrapper = frameEl?.parentElement
      if (!frameWrapper || !wrapEl) { raf = requestAnimationFrame(track); return }

      const wrapRect = wrapEl.getBoundingClientRect()
      const fRect = frameWrapper.getBoundingClientRect()

      setFrameRect({
        top: fRect.top - wrapRect.top,
        left: fRect.left - wrapRect.left,
        width: fRect.width,
        height: fRect.height
      })
      raf = requestAnimationFrame(track)
    }
    raf = requestAnimationFrame(track)
    return () => cancelAnimationFrame(raf)
  }, [mode])

  // ── Free-transform drag handles ───────────────
  const dragRef = useRef<{
    edge: 'right' | 'bottom' | 'left' | 'top'
    startX: number; startY: number
    startW: number; startH: number
  } | null>(null)

  const onHandleMouseDown = (
    edge: 'right' | 'bottom' | 'left' | 'top',
    e: React.MouseEvent
  ) => {
    e.preventDefault()
    dragRef.current = {
      edge,
      startX: e.clientX,
      startY: e.clientY,
      startW: vpWidth,
      startH: vpHeight
    }

    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      let newW = d.startW
      let newH = d.startH
      const dx = ev.clientX - d.startX
      const dy = ev.clientY - d.startY

      if (d.edge === 'right') newW = Math.max(200, d.startW + dx)
      if (d.edge === 'left') newW = Math.max(200, d.startW - dx)
      if (d.edge === 'bottom') newH = Math.max(200, d.startH + dy)
      if (d.edge === 'top') newH = Math.max(200, d.startH - dy)

      setVpWidth(Math.round(newW))
      setVpHeight(Math.round(newH))
      applyDimensions(Math.round(newW), Math.round(newH))
    }

    const onUp = () => {
      dragRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // ── Missing fonts ─────────────────────────────
  const handleLoadFonts = async () => {
    const editor = editorRef.current
    if (!editor || missingFonts.length === 0) return
    setLoadingFonts(true)
    try {
      const stillMissing = await loadMissingFonts(editor, missingFonts)
      setMissingFonts(stillMissing)
      setFontsAttempted(true)
    } finally {
      setLoadingFonts(false)
    }
  }

  // ── Panel resize ──────────────────────────────
  const onPanelResizeStart = (side: 'left' | 'right', e: React.MouseEvent) => {
    e.preventDefault()
    panelDragRef.current = {
      side,
      startX: e.clientX,
      startWidth: side === 'left' ? leftPanelWidth : rightPanelWidth
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    // Disable pointer events on iframe during drag
    const iframe = editorRef.current?.Canvas.getFrameEl()
    if (iframe) iframe.style.pointerEvents = 'none'

    let rafId = 0
    let latestX = e.clientX

    const onMove = (ev: MouseEvent) => {
      latestX = ev.clientX
      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          rafId = 0
          const d = panelDragRef.current
          if (!d) return
          const dx = latestX - d.startX
          const delta = d.side === 'left' ? dx : -dx
          const newWidth = Math.max(180, Math.min(500, d.startWidth + delta))
          if (d.side === 'left') setLeftPanelWidth(newWidth)
          else setRightPanelWidth(newWidth)
        })
      }
    }

    const onUp = () => {
      panelDragRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      if (iframe) iframe.style.pointerEvents = ''
      if (rafId) cancelAnimationFrame(rafId)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // ── F5 / Ctrl+R hard refresh ───────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key === 'r')) {
        e.preventDefault()
        if (!resetting) handleReset()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ── Reset capture ─────────────────────────────
  const handleReset = async () => {
    setResetting(true)
    await onReset()
    setResetting(false)
  }

  // ── Ruler drawing ────────────────────────────
  const drawRuler = useCallback((
    canvas: HTMLCanvasElement | null,
    orientation: 'horizontal' | 'vertical'
  ) => {
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    const w = rect.width
    const h = rect.height
    canvas.width = w * dpr
    canvas.height = h * dpr
    ctx.scale(dpr, dpr)

    ctx.fillStyle = '#1e1e1e'
    ctx.fillRect(0, 0, w, h)

    ctx.strokeStyle = '#555'
    ctx.fillStyle = '#888'
    ctx.font = '9px sans-serif'
    ctx.lineWidth = 1

    const length = orientation === 'horizontal' ? w : h
    const scale = zoom / 100

    for (let px = 0; px < length; px++) {
      const logical = px / scale
      const roundedLogical = Math.round(logical)
      if (roundedLogical % 50 !== 0) continue
      const prevPx = px - 1
      if (prevPx >= 0 && Math.round(prevPx / scale) === roundedLogical) continue

      const isMajor = roundedLogical % 100 === 0
      ctx.beginPath()
      if (orientation === 'horizontal') {
        const tickH = isMajor ? 12 : 6
        ctx.moveTo(px + 0.5, h)
        ctx.lineTo(px + 0.5, h - tickH)
        ctx.stroke()
        if (isMajor) {
          ctx.textAlign = 'left'
          ctx.textBaseline = 'top'
          ctx.fillText(String(roundedLogical), px + 2, 2)
        }
      } else {
        const tickW = isMajor ? 12 : 6
        ctx.moveTo(w, px + 0.5)
        ctx.lineTo(w - tickW, px + 0.5)
        ctx.stroke()
        if (isMajor) {
          ctx.save()
          ctx.translate(2, px + 2)
          ctx.rotate(-Math.PI / 2)
          ctx.textAlign = 'right'
          ctx.textBaseline = 'top'
          ctx.fillText(String(roundedLogical), 0, 0)
          ctx.restore()
        }
      }
    }

    // Center snap marker (blue triangle)
    const center = length / 2
    ctx.fillStyle = '#4C8BF5'
    if (orientation === 'horizontal') {
      ctx.beginPath()
      ctx.moveTo(center, h)
      ctx.lineTo(center - 3, h - 6)
      ctx.lineTo(center + 3, h - 6)
      ctx.closePath()
      ctx.fill()
    } else {
      ctx.beginPath()
      ctx.moveTo(w, center)
      ctx.lineTo(w - 6, center - 3)
      ctx.lineTo(w - 6, center + 3)
      ctx.closePath()
      ctx.fill()
    }

    // Border line
    ctx.strokeStyle = '#333'
    ctx.beginPath()
    if (orientation === 'horizontal') {
      ctx.moveTo(0, h - 0.5)
      ctx.lineTo(w, h - 0.5)
    } else {
      ctx.moveTo(w - 0.5, 0)
      ctx.lineTo(w - 0.5, h)
    }
    ctx.stroke()
  }, [zoom])

  // Draw rulers + redraw on resize
  useEffect(() => {
    if (!rulersOn) return
    const draw = () => {
      drawRuler(hRulerRef.current, 'horizontal')
      drawRuler(vRulerRef.current, 'vertical')
    }
    draw()
    const ro = new ResizeObserver(draw)
    if (canvasWrapRef.current) ro.observe(canvasWrapRef.current)
    return () => ro.disconnect()
  }, [rulersOn, zoom, drawRuler])

  // ── Drag-from-ruler to create guides (Photoshop-style) ──
  // Guides are stored as fractions (0–1) of the iframe content area.
  // This makes them responsive to zoom and device changes.
  const SNAP_THRESHOLD = 8

  const toFraction = (screenPx: number, frameOffset: number, frameDim: number): number => {
    return (screenPx - frameOffset) / frameDim
  }

  const snapCenter = (frac: number, frameDim: number): number => {
    const threshold = SNAP_THRESHOLD / frameDim
    return Math.abs(frac - 0.5) < threshold ? 0.5 : frac
  }

  // Top ruler → drag down → creates HORIZONTAL guide (axis 'x')
  const onHRulerMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!guidesOn) return
    e.preventDefault()
    const inner = canvasInnerRef.current
    if (!inner) return
    const frame = getCanvasFrame()
    if (!frame) return

    const iframe = editorRef.current?.Canvas.getFrameEl()
    if (iframe) iframe.style.pointerEvents = 'none'

    const innerRect = inner.getBoundingClientRect()
    let frac = toFraction(e.clientY - innerRect.top, frame.top, frame.height)
    frac = snapCenter(frac, frame.height)
    setDraggingGuide({ axis: 'x', position: frac })

    const onMove = (ev: MouseEvent) => {
      const rect = inner.getBoundingClientRect()
      const f = getCanvasFrame()
      if (!f) return
      let fr = toFraction(ev.clientY - rect.top, f.top, f.height)
      fr = snapCenter(fr, f.height)
      setDraggingGuide({ axis: 'x', position: fr })
    }

    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      if (iframe) iframe.style.pointerEvents = ''

      const rect = inner.getBoundingClientRect()
      const f = getCanvasFrame()
      if (!f) { setDraggingGuide(null); return }
      let fr = toFraction(ev.clientY - rect.top, f.top, f.height)
      fr = snapCenter(fr, f.height)

      if (fr > -0.05 && fr < 1.05) {
        setGuides((prev) => [...prev, { axis: 'x', position: Math.max(0, Math.min(1, fr)) }])
      }
      setDraggingGuide(null)
    }

    document.body.style.cursor = 'row-resize'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // Left ruler → drag right → creates VERTICAL guide (axis 'y')
  const onVRulerMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!guidesOn) return
    e.preventDefault()
    const inner = canvasInnerRef.current
    if (!inner) return
    const frame = getCanvasFrame()
    if (!frame) return

    const iframe = editorRef.current?.Canvas.getFrameEl()
    if (iframe) iframe.style.pointerEvents = 'none'

    const innerRect = inner.getBoundingClientRect()
    let frac = toFraction(e.clientX - innerRect.left, frame.left, frame.width)
    frac = snapCenter(frac, frame.width)
    setDraggingGuide({ axis: 'y', position: frac })

    const onMove = (ev: MouseEvent) => {
      const rect = inner.getBoundingClientRect()
      const f = getCanvasFrame()
      if (!f) return
      let fr = toFraction(ev.clientX - rect.left, f.left, f.width)
      fr = snapCenter(fr, f.width)
      setDraggingGuide({ axis: 'y', position: fr })
    }

    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      if (iframe) iframe.style.pointerEvents = ''

      const rect = inner.getBoundingClientRect()
      const f = getCanvasFrame()
      if (!f) { setDraggingGuide(null); return }
      let fr = toFraction(ev.clientX - rect.left, f.left, f.width)
      fr = snapCenter(fr, f.width)

      if (fr > -0.05 && fr < 1.05) {
        setGuides((prev) => [...prev, { axis: 'y', position: Math.max(0, Math.min(1, fr)) }])
      }
      setDraggingGuide(null)
    }

    document.body.style.cursor = 'col-resize'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const removeGuide = (index: number) => {
    setGuides((prev) => prev.filter((_, i) => i !== index))
  }

  // ── Ruler dropdown: close on outside click ──
  useEffect(() => {
    if (!rulerDropdownOpen) return
    const onClick = (e: MouseEvent) => {
      if (rulerDropdownRef.current && !rulerDropdownRef.current.contains(e.target as Node)) {
        setRulerDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [rulerDropdownOpen])

  // ── Add guide layout (Photoshop-style grid) ──
  const addGuideLayout = () => {
    const frame = getCanvasFrame()
    if (!frame) return
    // Content dimensions at 100% zoom
    const contentW = frame.width / (zoom / 100)
    const contentH = frame.height / (zoom / 100)
    const newGuides: Guide[] = []

    const mFracW = contentW > 0 ? layoutMargin / contentW : 0
    const mFracH = contentH > 0 ? layoutMargin / contentH : 0

    if (layoutColumns > 1) {
      const usable = 1 - mFracW * 2
      const step = usable / layoutColumns
      for (let i = 1; i < layoutColumns; i++) {
        newGuides.push({ axis: 'y', position: mFracW + step * i })
      }
    }

    if (layoutRows > 1) {
      const usable = 1 - mFracH * 2
      const step = usable / layoutRows
      for (let i = 1; i < layoutRows; i++) {
        newGuides.push({ axis: 'x', position: mFracH + step * i })
      }
    }

    if (layoutMargin > 0) {
      newGuides.push({ axis: 'y', position: mFracW })
      newGuides.push({ axis: 'y', position: 1 - mFracW })
      newGuides.push({ axis: 'x', position: mFracH })
      newGuides.push({ axis: 'x', position: 1 - mFracH })
    }

    if (layoutClear) {
      setGuides(newGuides)
    } else {
      setGuides((prev) => [...prev, ...newGuides])
    }
    setGuidesOn(true)
    setGuidesAlwaysVisible(true)
    setAddGuidesOpen(false)
  }

  // ── Font Inspector ───────────────────────────
  const activateFontInspector = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return

    const frameEl = editor.Canvas.getFrameEl()
    const iframeDoc = frameEl?.contentDocument
    if (!iframeDoc) return

    // Clean up any previous badges/tooltip
    iframeDoc.querySelectorAll('.__fi-badge').forEach((el) => el.remove())
    const existingTooltip = iframeDoc.querySelector('.__fi-tooltip')
    if (existingTooltip) existingTooltip.remove()

    const TEXT_TAGS = ['H1','H2','H3','H4','H5','H6','P','SPAN','A','LI','BLOCKQUOTE','LABEL','BUTTON','TD','TH']

    // Inject badge style
    let styleEl = iframeDoc.querySelector('#__fi-styles') as HTMLStyleElement | null
    if (!styleEl) {
      styleEl = iframeDoc.createElement('style')
      styleEl.id = '__fi-styles'
      iframeDoc.head.appendChild(styleEl)
    }
    styleEl.textContent = `
      .__fi-badge {
        position: absolute;
        top: 0;
        right: 0;
        background: rgba(0,0,0,0.75);
        color: #fff;
        font-size: 9px;
        padding: 1px 4px;
        border-radius: 3px;
        pointer-events: none;
        z-index: 999999;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        line-height: 1.3;
        white-space: nowrap;
      }
      .__fi-tooltip {
        position: absolute;
        background: #1a1a1a;
        color: #fff;
        font-size: 11px;
        padding: 6px 8px;
        border-radius: 4px;
        z-index: 9999999;
        pointer-events: none;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        line-height: 1.5;
        white-space: nowrap;
        box-shadow: 0 2px 8px rgba(0,0,0,0.5);
        border: 1px solid #333;
      }
      .__fi-tooltip-swatch {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 2px;
        border: 1px solid rgba(255,255,255,0.3);
        vertical-align: middle;
        margin-right: 4px;
      }
    `

    // Walk DOM and inject badges
    const elements = iframeDoc.querySelectorAll(TEXT_TAGS.join(','))
    const processedSet = new Set<Element>()

    elements.forEach((el) => {
      if (processedSet.has(el)) return
      processedSet.add(el)
      const htmlEl = el as HTMLElement
      const cs = iframeDoc.defaultView?.getComputedStyle(htmlEl)
      if (!cs) return

      const fontFamily = cs.fontFamily
      const shortFont = fontFamily.split(',')[0].replace(/['"]/g, '').trim()
      if (!shortFont) return

      // Make the element position relative if static so badge can position absolutely
      const pos = cs.position
      if (pos === 'static') {
        htmlEl.style.position = 'relative'
        htmlEl.setAttribute('data-fi-was-static', 'true')
      }

      const badge = iframeDoc.createElement('span')
      badge.className = '__fi-badge'
      badge.textContent = shortFont
      htmlEl.appendChild(badge)
    })

    // Also check divs with direct text content
    iframeDoc.querySelectorAll('div').forEach((el) => {
      if (processedSet.has(el)) return
      // Check if div has direct text nodes
      let hasDirectText = false
      el.childNodes.forEach((child) => {
        if (child.nodeType === 3 && child.textContent && child.textContent.trim().length > 0) {
          hasDirectText = true
        }
      })
      if (!hasDirectText) return
      processedSet.add(el)
      const htmlEl = el as HTMLElement
      const cs = iframeDoc.defaultView?.getComputedStyle(htmlEl)
      if (!cs) return
      const fontFamily = cs.fontFamily
      const shortFont = fontFamily.split(',')[0].replace(/['"]/g, '').trim()
      if (!shortFont) return
      const pos = cs.position
      if (pos === 'static') {
        htmlEl.style.position = 'relative'
        htmlEl.setAttribute('data-fi-was-static', 'true')
      }
      const badge = iframeDoc.createElement('span')
      badge.className = '__fi-badge'
      badge.textContent = shortFont
      htmlEl.appendChild(badge)
    })

    // Create tooltip element
    const tooltip = iframeDoc.createElement('div')
    tooltip.className = '__fi-tooltip'
    tooltip.style.display = 'none'
    iframeDoc.body.appendChild(tooltip)

    // Hover handlers
    const onMouseOver = (e: Event) => {
      const target = e.target as HTMLElement
      if (!target || target.classList.contains('__fi-badge') || target.classList.contains('__fi-tooltip')) return
      const tagName = target.tagName
      const isTextEl = TEXT_TAGS.includes(tagName) ||
        (tagName === 'DIV' && (() => {
          let has = false
          target.childNodes.forEach((c) => { if (c.nodeType === 3 && c.textContent?.trim()) has = true })
          return has
        })())
      if (!isTextEl) return

      const cs = iframeDoc.defaultView?.getComputedStyle(target)
      if (!cs) return

      const rect = target.getBoundingClientRect()
      const tag = target.tagName.toLowerCase()
      const filteredClasses = Array.from(target.classList).filter(c => !c.startsWith('__fi-'))
      const cls = filteredClasses.length > 0
        ? '.' + filteredClasses.join('.')
        : ''
      const selector = tag + cls
      const dims = `${rect.width.toFixed(2)} \u00d7 ${rect.height.toFixed(2)}`
      const color = cs.color
      const fontSize = cs.fontSize
      const fontFamily = cs.fontFamily

      tooltip.innerHTML = `
        <div style="font-weight:600;margin-bottom:2px">${selector}</div>
        <div>${dims}</div>
        <div><span class="__fi-tooltip-swatch" style="background:${color}"></span>${color}</div>
        <div>${fontSize} ${fontFamily}</div>
      `
      tooltip.style.display = 'block'

      // Position the tooltip
      const scrollX = iframeDoc.defaultView?.scrollX || 0
      const scrollY = iframeDoc.defaultView?.scrollY || 0
      let tipX = rect.left + scrollX
      let tipY = rect.top + scrollY - tooltip.offsetHeight - 6
      if (tipY < scrollY) tipY = rect.bottom + scrollY + 6
      tooltip.style.left = tipX + 'px'
      tooltip.style.top = tipY + 'px'
    }

    const onMouseOut = (e: Event) => {
      const target = e.target as HTMLElement
      if (!target || target.classList.contains('__fi-tooltip')) return
      tooltip.style.display = 'none'
    }

    iframeDoc.addEventListener('mouseover', onMouseOver, true)
    iframeDoc.addEventListener('mouseout', onMouseOut, true)

    // Return cleanup function
    const cleanup = () => {
      iframeDoc.removeEventListener('mouseover', onMouseOver, true)
      iframeDoc.removeEventListener('mouseout', onMouseOut, true)
      iframeDoc.querySelectorAll('.__fi-badge').forEach((el) => el.remove())
      const tip = iframeDoc.querySelector('.__fi-tooltip')
      if (tip) tip.remove()
      const style = iframeDoc.querySelector('#__fi-styles')
      if (style) style.remove()
      // Restore position:static
      iframeDoc.querySelectorAll('[data-fi-was-static]').forEach((el) => {
        ;(el as HTMLElement).style.position = ''
        el.removeAttribute('data-fi-was-static')
      })
    }

    fontInspectorCleanupRef.current = cleanup
  }, [])

  const deactivateFontInspector = useCallback(() => {
    if (fontInspectorCleanupRef.current) {
      fontInspectorCleanupRef.current()
      fontInspectorCleanupRef.current = null
    }
  }, [])

  useEffect(() => {
    if (fontInspectorOn) {
      // Small delay to ensure iframe is loaded
      const timer = setTimeout(() => activateFontInspector(), 100)
      return () => clearTimeout(timer)
    } else {
      deactivateFontInspector()
    }
  }, [fontInspectorOn, activateFontInspector, deactivateFontInspector])

  // Clean up font inspector when editor changes
  useEffect(() => {
    return () => {
      deactivateFontInspector()
    }
  }, [html, deactivateFontInspector])

  const toggleFontInspector = () => {
    setFontInspectorOn((prev) => !prev)
  }

  // ── Keep bdOptsRef in sync and trigger redraw ──
  useEffect(() => {
    bdOptsRef.current = { showMargins, showPaddings, showDimensions, showGaps }
    if (boundariesOn && bdRedrawRef.current) {
      bdRedrawRef.current()
    }
  }, [showMargins, showPaddings, showDimensions, showGaps, boundariesOn])

  // ── Boundaries dropdown: close on outside click ──
  useEffect(() => {
    if (!boundariesDropdownOpen) return
    const onClick = (e: MouseEvent) => {
      if (boundariesDropdownRef.current && !boundariesDropdownRef.current.contains(e.target as Node)) {
        setBoundariesDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [boundariesDropdownOpen])

  // ── Boundaries inspector ─────────────────────
  const activateBoundaries = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    const frameEl = editor.Canvas.getFrameEl()
    const iframeDoc = frameEl?.contentDocument
    if (!iframeDoc) return

    // Clean up any previous
    iframeDoc.querySelectorAll('.__bd-container').forEach((el) => el.remove())
    const oldStyle = iframeDoc.querySelector('#__bd-styles')
    if (oldStyle) oldStyle.remove()

    // Inject styles into iframe
    const styleEl = iframeDoc.createElement('style')
    styleEl.id = '__bd-styles'
    styleEl.textContent = `
      .__bd-margin { background: rgba(255, 165, 0, 0.15); }
      .__bd-padding { background: rgba(0, 200, 83, 0.15); }
      .__bd-content { background: rgba(76, 139, 245, 0.1); }
      .__bd-label {
        position: absolute;
        color: #fff;
        font-size: 10px;
        padding: 1px 4px;
        border-radius: 2px;
        white-space: nowrap;
        pointer-events: none;
        z-index: 999999;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        line-height: 1.4;
      }
      .__bd-dim-label { background: rgba(76, 139, 245, 0.9); }
      .__bd-margin-label { background: rgba(255, 165, 0, 0.9); }
      .__bd-padding-label { background: rgba(0, 200, 83, 0.9); color: #000; }
      .__bd-gap-label { background: rgba(255, 80, 80, 0.9); }
      .__bd-outline { position: absolute; pointer-events: none; border: 1px solid rgba(76, 139, 245, 0.6); z-index: 999998; }
    `
    iframeDoc.head.appendChild(styleEl)

    // Container for overlays
    const container = iframeDoc.createElement('div')
    container.className = '__bd-container'
    container.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;pointer-events:none;z-index:999998;'
    iframeDoc.body.appendChild(container)

    bdContainerRef.current = container
    bdDocRef.current = iframeDoc
    bdLockedRef.current = null
    bdHoveredRef.current = null

    const mkDiv = (cls: string, l: number, t: number, w: number, h: number) => {
      const d = iframeDoc.createElement('div')
      d.className = cls
      d.style.cssText = `position:absolute;left:${l}px;top:${t}px;width:${Math.max(0, w)}px;height:${Math.max(0, h)}px;pointer-events:none;`
      container.appendChild(d)
    }

    const mkLabel = (cls: string, text: string, l: number, t: number) => {
      const d = iframeDoc.createElement('div')
      d.className = `__bd-label ${cls}`
      d.textContent = text
      d.style.cssText = `position:absolute;left:${l}px;top:${t}px;pointer-events:none;z-index:999999;`
      container.appendChild(d)
    }

    const drawBounds = (el: HTMLElement) => {
      const cs = iframeDoc.defaultView?.getComputedStyle(el)
      if (!cs) return
      const opts = bdOptsRef.current

      const rect = el.getBoundingClientRect()
      const sx = iframeDoc.defaultView?.scrollX || 0
      const sy = iframeDoc.defaultView?.scrollY || 0

      const mt = parseFloat(cs.marginTop) || 0
      const mr = parseFloat(cs.marginRight) || 0
      const mb = parseFloat(cs.marginBottom) || 0
      const ml = parseFloat(cs.marginLeft) || 0
      const pt = parseFloat(cs.paddingTop) || 0
      const pr = parseFloat(cs.paddingRight) || 0
      const pb = parseFloat(cs.paddingBottom) || 0
      const pl = parseFloat(cs.paddingLeft) || 0
      const bt = parseFloat(cs.borderTopWidth) || 0
      const brw = parseFloat(cs.borderRightWidth) || 0
      const bb = parseFloat(cs.borderBottomWidth) || 0
      const blw = parseFloat(cs.borderLeftWidth) || 0

      const x = rect.left + sx
      const y = rect.top + sy
      const w = rect.width
      const h = rect.height

      // Blue outline around element
      mkDiv('__bd-outline', x, y, w, h)

      if (opts.showMargins) {
        if (mt > 0) { mkDiv('__bd-margin', x, y - mt, w, mt); mkLabel('__bd-margin-label', String(Math.round(mt)), x + w / 2 - 8, y - mt + mt / 2 - 7) }
        if (mb > 0) { mkDiv('__bd-margin', x, y + h, w, mb); mkLabel('__bd-margin-label', String(Math.round(mb)), x + w / 2 - 8, y + h + mb / 2 - 7) }
        if (ml > 0) { mkDiv('__bd-margin', x - ml, y, ml, h); mkLabel('__bd-margin-label', String(Math.round(ml)), x - ml + ml / 2 - 8, y + h / 2 - 7) }
        if (mr > 0) { mkDiv('__bd-margin', x + w, y, mr, h); mkLabel('__bd-margin-label', String(Math.round(mr)), x + w + mr / 2 - 8, y + h / 2 - 7) }
      }

      if (opts.showPaddings) {
        const ix = x + blw
        const iy = y + bt
        const iw = w - blw - brw
        const ih = h - bt - bb
        if (pt > 0) { mkDiv('__bd-padding', ix, iy, iw, pt); mkLabel('__bd-padding-label', String(Math.round(pt)), ix + iw / 2 - 8, iy + pt / 2 - 7) }
        if (pb > 0) { mkDiv('__bd-padding', ix, iy + ih - pb, iw, pb); mkLabel('__bd-padding-label', String(Math.round(pb)), ix + iw / 2 - 8, iy + ih - pb + pb / 2 - 7) }
        if (pl > 0) { mkDiv('__bd-padding', ix, iy + pt, pl, ih - pt - pb); mkLabel('__bd-padding-label', String(Math.round(pl)), ix + pl / 2 - 8, iy + ih / 2 - 7) }
        if (pr > 0) { mkDiv('__bd-padding', ix + iw - pr, iy + pt, pr, ih - pt - pb); mkLabel('__bd-padding-label', String(Math.round(pr)), ix + iw - pr + pr / 2 - 8, iy + ih / 2 - 7) }
      }

      if (opts.showDimensions) {
        const cw = w - blw - brw - pl - pr
        const ch = h - bt - bb - pt - pb
        mkDiv('__bd-content', x + blw + pl, y + bt + pt, cw, ch)
        mkLabel('__bd-dim-label', `${Math.round(w)} \u00d7 ${Math.round(h)}`, x + w / 2 - 20, y - 18)
      }
    }

    const drawGapLines = (el1: HTMLElement, el2: HTMLElement) => {
      const r1 = el1.getBoundingClientRect()
      const r2 = el2.getBoundingClientRect()
      const sx = iframeDoc.defaultView?.scrollX || 0
      const sy = iframeDoc.defaultView?.scrollY || 0

      const cy1 = r1.top + r1.height / 2 + sy
      const cx1 = r1.left + r1.width / 2 + sx
      const cy2 = r2.top + r2.height / 2 + sy
      const cx2 = r2.left + r2.width / 2 + sx
      const midY = (cy1 + cy2) / 2
      const midX = (cx1 + cx2) / 2

      let hGap = 0, hStart = 0
      if (r2.left > r1.right) { hGap = r2.left - r1.right; hStart = r1.right + sx }
      else if (r1.left > r2.right) { hGap = r1.left - r2.right; hStart = r2.right + sx }

      let vGap = 0, vStart = 0
      if (r2.top > r1.bottom) { vGap = r2.top - r1.bottom; vStart = r1.bottom + sy }
      else if (r1.top > r2.bottom) { vGap = r1.top - r2.bottom; vStart = r2.bottom + sy }

      const mkLine = (l: number, t: number, lw: number, lh: number, dashed: boolean) => {
        const d = iframeDoc.createElement('div')
        d.style.cssText = `position:absolute;left:${l}px;top:${t}px;width:${lw}px;height:${lh}px;pointer-events:none;z-index:999999;`
        if (lw > 0 && lh === 0) d.style.borderTop = dashed ? '1px dashed rgba(255,80,80,0.9)' : '1px solid rgba(255,80,80,0.9)'
        if (lh > 0 && lw === 0) d.style.borderLeft = dashed ? '1px dashed rgba(255,80,80,0.9)' : '1px solid rgba(255,80,80,0.9)'
        container.appendChild(d)
      }

      if (hGap > 0) {
        mkLine(hStart, midY, hGap, 0, true)
        mkLine(hStart, midY - 4, 0, 8, false)
        mkLine(hStart + hGap, midY - 4, 0, 8, false)
        mkLabel('__bd-gap-label', `${Math.round(hGap)}px`, hStart + hGap / 2 - 15, midY - 18)
      }

      if (vGap > 0) {
        mkLine(midX, vStart, 0, vGap, true)
        mkLine(midX - 4, vStart, 8, 0, false)
        mkLine(midX - 4, vStart + vGap, 8, 0, false)
        mkLabel('__bd-gap-label', `${Math.round(vGap)}px`, midX + 6, vStart + vGap / 2 - 7)
      }

      if (hGap === 0 && vGap === 0) {
        const dx = Math.abs(cx1 - cx2)
        const dy = Math.abs(cy1 - cy2)
        if (dx > 1) {
          mkLine(Math.min(cx1, cx2), midY, dx, 0, true)
          mkLabel('__bd-gap-label', `${Math.round(dx)}px`, Math.min(cx1, cx2) + dx / 2 - 15, midY - 18)
        }
        if (dy > 1) {
          mkLine(midX, Math.min(cy1, cy2), 0, dy, true)
          mkLabel('__bd-gap-label', `${Math.round(dy)}px`, midX + 6, Math.min(cy1, cy2) + dy / 2 - 7)
        }
      }
    }

    const redraw = () => {
      container.innerHTML = ''
      const locked = bdLockedRef.current
      const hovered = bdHoveredRef.current
      if (locked && !iframeDoc.contains(locked)) { bdLockedRef.current = null; return }
      if (locked) drawBounds(locked)
      if (hovered && hovered !== locked && iframeDoc.contains(hovered)) drawBounds(hovered)
      if (locked && hovered && hovered !== locked && iframeDoc.contains(hovered) && bdOptsRef.current.showGaps) {
        drawGapLines(locked, hovered)
      }
    }

    bdRedrawRef.current = redraw

    const onMouseOver = (e: Event) => {
      const target = e.target as HTMLElement
      if (!target || target.closest('.__bd-container') || target.tagName === 'HTML' || target.tagName === 'BODY') return
      bdHoveredRef.current = target
      redraw()
    }

    const onMouseOut = () => {
      bdHoveredRef.current = null
      redraw()
    }

    const onClick = (e: Event) => {
      const me = e as MouseEvent
      const target = me.target as HTMLElement
      if (!target || target.closest('.__bd-container') || target.tagName === 'HTML' || target.tagName === 'BODY') return
      if (me.shiftKey && bdLockedRef.current) {
        bdHoveredRef.current = target
      } else {
        bdLockedRef.current = target
        bdHoveredRef.current = null
      }
      redraw()
    }

    iframeDoc.addEventListener('mouseover', onMouseOver, true)
    iframeDoc.addEventListener('mouseout', onMouseOut, true)
    iframeDoc.addEventListener('click', onClick, true)

    boundariesCleanupRef.current = () => {
      iframeDoc.removeEventListener('mouseover', onMouseOver, true)
      iframeDoc.removeEventListener('mouseout', onMouseOut, true)
      iframeDoc.removeEventListener('click', onClick, true)
      container.remove()
      const style = iframeDoc.querySelector('#__bd-styles')
      if (style) style.remove()
      bdContainerRef.current = null
      bdDocRef.current = null
      bdLockedRef.current = null
      bdHoveredRef.current = null
      bdRedrawRef.current = null
    }
  }, [])

  const deactivateBoundaries = useCallback(() => {
    if (boundariesCleanupRef.current) {
      boundariesCleanupRef.current()
      boundariesCleanupRef.current = null
    }
  }, [])

  useEffect(() => {
    if (boundariesOn) {
      const timer = setTimeout(() => activateBoundaries(), 100)
      return () => clearTimeout(timer)
    } else {
      deactivateBoundaries()
    }
  }, [boundariesOn, activateBoundaries, deactivateBoundaries])

  useEffect(() => {
    return () => { deactivateBoundaries() }
  }, [html, deactivateBoundaries])

  // ── Color palette: scan all colors from iframe ──
  const rgbToHex = (r: number, g: number, b: number): string => {
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
  }

  const parseColor = (c: string): string | null => {
    if (!c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)' || c === 'inherit' || c === 'initial') return null
    const rgbMatch = c.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/)
    if (rgbMatch) return rgbToHex(+rgbMatch[1], +rgbMatch[2], +rgbMatch[3])
    if (c.startsWith('#')) return c.length === 4
      ? '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3]
      : c.slice(0, 7).toLowerCase()
    return null
  }

  const scanPageColors = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    const iframeDoc = editor.Canvas.getDocument()
    if (!iframeDoc) return
    const win = iframeDoc.defaultView
    if (!win) return

    const colorMap = new Map<string, number>()
    iframeDoc.querySelectorAll('*').forEach((el) => {
      const cs = win.getComputedStyle(el as HTMLElement)
      for (const prop of ['color', 'backgroundColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor']) {
        const hex = parseColor(cs[prop as any])
        if (hex) {
          colorMap.set(hex, (colorMap.get(hex) || 0) + 1)
        }
      }
    })

    // Also include #000 and #fff but at lower priority
    const bgHex = parseColor(win.getComputedStyle(iframeDoc.body).backgroundColor)
    if (bgHex) colorMap.set(bgHex, (colorMap.get(bgHex) || 0) + 100)

    const sorted = [...colorMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([hex, count]) => ({ hex, count }))

    setPageColors(sorted)
  }, [])

  // Scan colors when editor loads
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const onLoad = () => { setTimeout(scanPageColors, 2000) }
    editor.on('load', onLoad)
    return () => { editor.off('load', onLoad) }
  }, [html, scanPageColors])

  const toggleColorSelection = (hex: string) => {
    setSelectedColors((prev) => {
      const next = new Set(prev)
      if (next.has(hex)) next.delete(hex)
      else next.add(hex)
      return next
    })
  }

  // ── Grayscale + color highlight effect ──
  // CSS filter on a parent always applies to all children — you can't "un-grayscale"
  // a child element. So we: (1) apply grayscale to <body>, (2) create a highlight
  // overlay as a sibling of <body> (child of <html>) that's OUTSIDE the filter,
  // with colored outlines showing which elements use the selected colors.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const iframeDoc = editor.Canvas.getDocument()
    if (!iframeDoc) return
    const win = iframeDoc.defaultView
    if (!win) return

    // Cleanup previous
    const oldOverlay = iframeDoc.getElementById('__color-highlight-overlay')
    if (oldOverlay) oldOverlay.remove()
    iframeDoc.body.style.removeProperty('filter')

    if (selectedColors.size === 0) return

    // 1. Grayscale the body (all content inside is desaturated)
    iframeDoc.body.style.setProperty('filter', 'grayscale(100%)', 'important')

    // 2. Create overlay container as child of <html>, sibling of <body> — NOT affected by body filter
    const overlay = iframeDoc.createElement('div')
    overlay.id = '__color-highlight-overlay'
    overlay.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;pointer-events:none;z-index:999999;'
    iframeDoc.documentElement.appendChild(overlay)

    // 3. Walk elements and create colored highlight boxes for matching ones
    const hexSet = selectedColors
    const COLOR_PROPS = ['color', 'backgroundColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor']
    const sx = win.scrollX || 0
    const sy = win.scrollY || 0

    iframeDoc.querySelectorAll('*').forEach((el) => {
      const htmlEl = el as HTMLElement
      if (htmlEl.tagName === 'SCRIPT' || htmlEl.tagName === 'STYLE' || htmlEl.tagName === 'LINK' || htmlEl.tagName === 'HEAD') return
      const cs = win.getComputedStyle(htmlEl)

      let matchedHex: string | null = null
      for (const prop of COLOR_PROPS) {
        const hex = parseColor(cs[prop as any])
        if (hex && hexSet.has(hex)) { matchedHex = hex; break }
      }

      if (matchedHex) {
        const rect = htmlEl.getBoundingClientRect()
        if (rect.width < 1 || rect.height < 1) return
        const highlight = iframeDoc.createElement('div')
        highlight.style.cssText = `position:absolute;left:${rect.left + sx}px;top:${rect.top + sy}px;width:${rect.width}px;height:${rect.height}px;outline:2px solid ${matchedHex};background:${matchedHex}18;pointer-events:none;z-index:999999;border-radius:2px;`
        overlay.appendChild(highlight)
      }
    })

    // Also grayscale images that don't match
    iframeDoc.querySelectorAll('img, video, svg').forEach((el) => {
      const htmlEl = el as HTMLElement
      const cs = win.getComputedStyle(htmlEl)
      let hasMatch = false
      for (const prop of COLOR_PROPS) {
        const hex = parseColor(cs[prop as any])
        if (hex && hexSet.has(hex)) { hasMatch = true; break }
      }
      if (!hasMatch) {
        htmlEl.setAttribute('data-gs-img', '1')
      }
    })

    return () => {
      const ov = iframeDoc.getElementById('__color-highlight-overlay')
      if (ov) ov.remove()
      iframeDoc.body.style.removeProperty('filter')
      iframeDoc.querySelectorAll('[data-gs-img]').forEach((el) => {
        el.removeAttribute('data-gs-img')
      })
    }
  }, [selectedColors])

  return (
    <div className="editor-workspace">
      {/* ── Top toolbar ──────────────────────────── */}
      <div className="editor-toolbar">
        <div className="toolbar-left">
          <button className="toolbar-btn" onClick={onNewCapture} title="Back to dashboard">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 3L5 8l5 5" />
            </svg>
          </button>
          <span className="toolbar-url" title={sourceUrl}>
            {(() => { try { return new URL(sourceUrl).hostname } catch { return sourceUrl } })()}
          </span>
        </div>

        {/* Center: viewport controls */}
        <div className="toolbar-center">
          <div className="viewport-controls">
            {/* Free-transform toggle */}
            <button
              className={`device-btn ${mode === 'free' ? 'active' : ''}`}
              onClick={enterFreeMode}
              title="Free transform"
            >
              {/* resize / free-transform icon */}
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
              </svg>
            </button>

            <div className="toolbar-divider" />

            {/* Device presets */}
            <div className="device-switcher">
              <button
                className={`device-btn ${mode === 'preset' && activePreset === 'Desktop' ? 'active' : ''}`}
                onClick={() => switchPreset('Desktop')}
                title={`Desktop (${PRESETS.Desktop.label})`}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="3" width="20" height="14" rx="2" />
                  <path d="M8 21h8m-4-4v4" />
                </svg>
              </button>
              <button
                className={`device-btn ${mode === 'preset' && activePreset === 'Tablet' ? 'active' : ''}`}
                onClick={() => switchPreset('Tablet')}
                title={`Tablet (${PRESETS.Tablet.label})`}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="4" y="2" width="16" height="20" rx="2" />
                  <circle cx="12" cy="18" r="1" fill="currentColor" />
                </svg>
              </button>
              <button
                className={`device-btn ${mode === 'preset' && activePreset === 'Mobile' ? 'active' : ''}`}
                onClick={() => switchPreset('Mobile')}
                title={`Mobile (${PRESETS.Mobile.label})`}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="6" y="2" width="12" height="20" rx="2" />
                  <circle cx="12" cy="18" r="1" fill="currentColor" />
                </svg>
              </button>
            </div>

            <div className="toolbar-divider" />

            {/* Custom dimension inputs */}
            <div className="dimension-inputs">
              <label className="dim-label">W</label>
              <input
                className="dim-input"
                type="number"
                min={100}
                value={vpWidth}
                onChange={(e) => setVpWidth(Number(e.target.value))}
                onBlur={(e) => commitWidth(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && commitWidth((e.target as HTMLInputElement).value)}
              />
              <button className="dim-swap" onClick={swapDimensions} title="Swap dimensions">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" />
                </svg>
              </button>
              <label className="dim-label">H</label>
              <input
                className="dim-input"
                type="number"
                min={100}
                value={vpHeight}
                onChange={(e) => setVpHeight(Number(e.target.value))}
                onBlur={(e) => commitHeight(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && commitHeight((e.target as HTMLInputElement).value)}
              />
            </div>

            <div className="toolbar-divider" />

            {/* Zoom controls */}
            <div className="zoom-controls">
              <button className="zoom-btn" onClick={zoomOut} title="Zoom out">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M3 8h10" />
                </svg>
              </button>
              <button className="zoom-level" onClick={zoomFit} title="Reset to 100%">
                {zoom}%
              </button>
              <button className="zoom-btn" onClick={zoomIn} title="Zoom in">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M8 3v10M3 8h10" />
                </svg>
              </button>
            </div>

            <div className="toolbar-divider" />

            {/* Ruler & guides dropdown */}
            <div className="ruler-dropdown-wrap" ref={rulerDropdownRef}>
              <button
                className={`device-btn ${rulersOn || guides.length > 0 ? 'active' : ''}`}
                onClick={() => setRulerDropdownOpen((p) => !p)}
                title="Rulers & Guides"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="2" y="4" width="20" height="16" rx="1"/>
                  <path d="M6 4v4M10 4v6M14 4v4M18 4v6"/>
                </svg>
              </button>
              {rulerDropdownOpen && (
                <div className="ruler-dropdown">
                  <label className="ruler-dd-item ruler-dd-check">
                    <input type="checkbox" checked={rulersOn} onChange={(e) => setRulersOn(e.target.checked)} />
                    <span>Rulers</span>
                  </label>
                  <label className="ruler-dd-item ruler-dd-check">
                    <input type="checkbox" checked={guidesOn} onChange={(e) => setGuidesOn(e.target.checked)} />
                    <span>Guides</span>
                  </label>
                  <div className="ruler-dd-divider" />
                  <button className="ruler-dd-item" onClick={() => { setAddGuidesOpen(true); setRulerDropdownOpen(false) }}>
                    Add Guides...
                  </button>
                  <button
                    className="ruler-dd-item ruler-dd-danger"
                    onClick={() => { setGuides([]); setRulerDropdownOpen(false) }}
                    disabled={guides.length === 0}
                  >
                    Delete Guides
                  </button>
                  <div className="ruler-dd-divider" />
                  <label className="ruler-dd-item ruler-dd-check">
                    <input type="checkbox" checked={guidesAlwaysVisible} onChange={(e) => setGuidesAlwaysVisible(e.target.checked)} />
                    <span>Show Guides</span>
                  </label>
                </div>
              )}
            </div>

            {/* Font inspector toggle */}
            <button
              className={`device-btn ${fontInspectorOn ? 'active' : ''}`}
              onClick={toggleFontInspector}
              title="Font inspector"
            >
              <span style={{ fontSize: '13px', fontWeight: 600 }}>Aa</span>
            </button>

            {/* Boundaries (element inspection) dropdown */}
            <div className="ruler-dropdown-wrap" ref={boundariesDropdownRef}>
              <button
                className={`device-btn ${boundariesOn ? 'active' : ''}`}
                onClick={() => setBoundariesDropdownOpen((p) => !p)}
                title="Boundaries"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="1"/>
                  <rect x="7" y="7" width="10" height="10" rx="0.5" strokeDasharray="2 2"/>
                </svg>
              </button>
              {boundariesDropdownOpen && (
                <div className="ruler-dropdown">
                  <label className="ruler-dd-item ruler-dd-check">
                    <input type="checkbox" checked={boundariesOn} onChange={(e) => setBoundariesOn(e.target.checked)} />
                    <span>Boundaries</span>
                  </label>
                  <div className="ruler-dd-divider" />
                  <label className="ruler-dd-item ruler-dd-check">
                    <input type="checkbox" checked={showMargins} onChange={(e) => setShowMargins(e.target.checked)} />
                    <span>Show Margins</span>
                  </label>
                  <label className="ruler-dd-item ruler-dd-check">
                    <input type="checkbox" checked={showPaddings} onChange={(e) => setShowPaddings(e.target.checked)} />
                    <span>Show Paddings</span>
                  </label>
                  <label className="ruler-dd-item ruler-dd-check">
                    <input type="checkbox" checked={showDimensions} onChange={(e) => setShowDimensions(e.target.checked)} />
                    <span>Show Dimensions</span>
                  </label>
                  <label className="ruler-dd-item ruler-dd-check">
                    <input type="checkbox" checked={showGaps} onChange={(e) => setShowGaps(e.target.checked)} />
                    <span>Show Gaps</span>
                  </label>
                </div>
              )}
            </div>

          </div>
        </div>

        <div className="toolbar-right">
          <button
            className="toolbar-btn refresh-btn"
            onClick={handleReset}
            disabled={resetting}
            title="Hard refresh (F5)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 4v6h6" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
            <span>{resetting ? 'Refreshing...' : 'Refresh'}</span>
          </button>
        </div>
      </div>

      {/* ── Editor body ──────────────────────────── */}
      <div className="editor-body">
        <div className="editor-panel panel-left" style={{ width: leftPanelWidth }}>
          <div className="panel-header">Layers</div>
          <div id="layers-container" className="panel-content" />
        </div>
        <div className="panel-resize-handle" onMouseDown={(e) => onPanelResizeStart('left', e)} />

        {/* Canvas with optional rulers, guides, and free-transform handles */}
        <div className="editor-canvas-wrap" ref={canvasWrapRef}>
          {/* Horizontal ruler */}
          {rulersOn && (
            <div className="ruler-h-container">
              <div className="ruler-corner" />
              <canvas
                ref={hRulerRef}
                className="ruler-h"
                onMouseDown={onHRulerMouseDown}
              />
            </div>
          )}

          <div className="canvas-with-vruler">
            {/* Vertical ruler */}
            {rulersOn && (
              <canvas
                ref={vRulerRef}
                className="ruler-v"
                onMouseDown={onVRulerMouseDown}
              />
            )}

            <div className="canvas-inner" ref={canvasInnerRef} style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
              {missingFonts.length > 0 && (
                <div className={`font-notice ${fontsAttempted ? 'font-notice-warn' : ''}`}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 8v4m0 4h.01" />
                  </svg>
                  <span className="font-notice-text">
                    {fontsAttempted ? 'Fonts not found: ' : 'Missing fonts: '}
                    <strong>{missingFonts.join(', ')}</strong>
                  </span>
                  {!fontsAttempted && (
                    <button
                      className="font-notice-btn font-notice-load"
                      onClick={handleLoadFonts}
                      disabled={loadingFonts}
                    >
                      {loadingFonts ? 'Loading...' : 'Load Fonts'}
                    </button>
                  )}
                  <button
                    className="font-notice-btn font-notice-dismiss"
                    onClick={() => { setMissingFonts([]); setFontsAttempted(false) }}
                    title="Dismiss"
                  >
                    &times;
                  </button>
                </div>
              )}
              {mode === 'free' && frameRect && (
                <div
                  className="ft-overlay"
                  style={{
                    top: frameRect.top,
                    left: frameRect.left,
                    width: frameRect.width,
                    height: frameRect.height
                  }}
                >
                  <div className="ft-handle ft-top" onMouseDown={(e) => onHandleMouseDown('top', e)} />
                  <div className="ft-handle ft-right" onMouseDown={(e) => onHandleMouseDown('right', e)} />
                  <div className="ft-handle ft-bottom" onMouseDown={(e) => onHandleMouseDown('bottom', e)} />
                  <div className="ft-handle ft-left" onMouseDown={(e) => onHandleMouseDown('left', e)} />
                </div>
              )}

              <div className="editor-canvas" ref={containerRef} />

              {/* Guides overlay — positioned to match iframe, so guides scale with zoom */}
              {canvasFrame && (
                <div className="guides-overlay" style={{
                  left: canvasFrame.left,
                  top: canvasFrame.top,
                  width: canvasFrame.width,
                  height: canvasFrame.height,
                }}>
                  {guidesOn && guides.map((g, i) => (
                    <div
                      key={i}
                      className={`guide-line guide-${g.axis}`}
                      style={g.axis === 'x'
                        ? { top: `${g.position * 100}%`, left: -canvasFrame.left, width: `calc(100% + ${canvasFrame.left}px + ${canvasFrame.left}px)`, opacity: guidesAlwaysVisible ? 1 : 0 }
                        : { left: `${g.position * 100}%`, top: -canvasFrame.top, height: `calc(100% + ${canvasFrame.top}px + ${canvasFrame.top}px)`, opacity: guidesAlwaysVisible ? 1 : 0 }
                      }
                      onDoubleClick={() => removeGuide(i)}
                    />
                  ))}
                  {draggingGuide && (
                    <div
                      className={`guide-line guide-${draggingGuide.axis}`}
                      style={draggingGuide.axis === 'x'
                        ? { top: `${draggingGuide.position * 100}%`, left: -canvasFrame.left, width: `calc(100% + ${canvasFrame.left}px + ${canvasFrame.left}px)` }
                        : { left: `${draggingGuide.position * 100}%`, top: -canvasFrame.top, height: `calc(100% + ${canvasFrame.top}px + ${canvasFrame.top}px)` }
                      }
                    />
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="panel-resize-handle" onMouseDown={(e) => onPanelResizeStart('right', e)} />
        <div className="editor-panel panel-right" style={{ width: rightPanelWidth }}>
          <div className="panel-header">Selectors</div>
          <div id="selector-container" className="panel-content" />
          <div className="panel-header">Style</div>
          <div id="style-manager-container" className="panel-content" />
          <div className="panel-header color-palette-header">
            <span>Colors</span>
            <button className="color-scan-btn" onClick={scanPageColors} title="Rescan page colors">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 4v6h6" />
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
            </button>
            {selectedColors.size > 0 && (
              <button className="color-clear-btn" onClick={() => setSelectedColors(new Set())} title="Clear selection">
                Clear
              </button>
            )}
          </div>
          <div className="panel-content color-palette-content">
            {pageColors.length === 0 ? (
              <div className="color-palette-empty">No colors detected yet</div>
            ) : (
              <div className="color-palette-grid">
                {pageColors.map(({ hex, count }) => (
                  <button
                    key={hex}
                    className={`color-swatch-btn ${selectedColors.has(hex) ? 'active' : ''}`}
                    onClick={() => toggleColorSelection(hex)}
                    title={`${hex} (${count} uses)`}
                  >
                    <span className="color-swatch-preview" style={{ background: hex }} />
                    <span className="color-swatch-hex">{hex}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Add Guides dialog */}
      {addGuidesOpen && (
        <div className="add-guides-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setAddGuidesOpen(false) }}>
          <div className="add-guides-dialog">
            <div className="add-guides-title">New Guide Layout</div>
            <div className="add-guides-row">
              <label>Columns</label>
              <input
                type="number" min={0} max={50}
                value={layoutColumns}
                onChange={(e) => setLayoutColumns(Math.max(0, Number(e.target.value)))}
              />
            </div>
            <div className="add-guides-row">
              <label>Rows</label>
              <input
                type="number" min={0} max={50}
                value={layoutRows}
                onChange={(e) => setLayoutRows(Math.max(0, Number(e.target.value)))}
              />
            </div>
            <div className="add-guides-row">
              <label>Margin (px)</label>
              <input
                type="number" min={0}
                value={layoutMargin}
                onChange={(e) => setLayoutMargin(Math.max(0, Number(e.target.value)))}
              />
            </div>
            <label className="add-guides-check">
              <input
                type="checkbox"
                checked={layoutClear}
                onChange={(e) => setLayoutClear(e.target.checked)}
              />
              <span>Clear existing guides</span>
            </label>
            <div className="add-guides-actions">
              <button className="add-guides-cancel" onClick={() => setAddGuidesOpen(false)}>Cancel</button>
              <button className="add-guides-ok" onClick={addGuideLayout}>OK</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
