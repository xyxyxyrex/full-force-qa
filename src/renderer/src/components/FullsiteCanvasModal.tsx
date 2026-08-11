import React, { useState, useRef, useEffect } from 'react'
import {
  generateEphemeralLink,
  normalizeSiteSlug,
  updateMasterAnnotations,
  uploadMasterImage,
  type MasterUploadResult,
} from '../services/ephemeralLinkService'
import { RichTextContent, RichTextEditor, plainTextFromRichText } from './RichTextEditor'
import './FullsiteCanvasModal.css'

export interface CanvasSelectionBox {
  id: string
  badgeNumber: number
  title: string
  notes: string
  color: string
  type?: 'box' | 'arrow' | 'rect' | 'circle' | 'pen' | 'text' | 'blur'
  elementPath?: string
  arrowPct?: { startX: number; startY: number; endX: number; endY: number }
  pointsPct?: Array<{ x: number; y: number }>
  coordinateSpace?: 'page'
  // Absolute document pixel coordinates
  xPx?: number
  yPagePx?: number
  topPagePx?: number
  widthPx?: number
  heightPx?: number
  viewportWidth?: number
  viewportHeight?: number
  viewportKey?: string
  deviceFrameId?: string
  deviceName?: string
  deviceType?: 'desktop' | 'tablet' | 'mobile' | 'custom'
  // Rect in normalized percentages (0.0 to 100.0) relative to image width/height
  rectPct: {
    x: number
    y: number
    width: number
    height: number
  }
  ephemeralUrl?: string
}

export interface CaptureInspectionOverlay {
  id: string
  kind: 'font' | 'boundary' | 'guide' | 'ruler-top' | 'ruler-left'
  text?: string
  color?: string
  coordinateSpace?: 'page' | 'image-percent'
  xPx?: number
  yPagePx?: number
  widthPx?: number
  heightPx?: number
  viewportWidth?: number
  viewportHeight?: number
  rectPct?: { x: number; y: number; width: number; height: number }
}

export interface CaptureViewportInfo {
  key: string
  name: string
  width: number
  height: number
  deviceType: 'desktop' | 'tablet' | 'mobile' | 'custom'
}

interface Props {
  isOpen: boolean
  onClose: () => void
  masterDataUrl: string
  pageTitle?: string
  initialBoxes?: CanvasSelectionBox[]
  captureViewport?: CaptureViewportInfo
  inspectionOverlays?: CaptureInspectionOverlay[]
  expiresInSeconds?: number
  onItemsGenerated?: (items: CanvasSelectionBox[]) => void
}

const CanvasAnnotationShape: React.FC<{ box: CanvasSelectionBox }> = ({ box }) => {
  if (box.type === 'arrow') {
    const arrow = box.arrowPct || { startX: 0, startY: 100, endX: 100, endY: 0 }
    const markerId = `canvas-arrow-${box.id.replace(/[^a-z0-9_-]/gi, '')}`
    return (
      <svg className="canvas-annotation-vector">
        <defs><marker id={markerId} viewBox="0 0 12 12" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="userSpaceOnUse"><path d="M1,1 L11,6 L1,11 Z" fill={box.color} /></marker></defs>
        <line x1={`${arrow.startX}%`} y1={`${arrow.startY}%`} x2={`${arrow.endX}%`} y2={`${arrow.endY}%`} stroke={box.color} strokeWidth="3" vectorEffect="non-scaling-stroke" markerEnd={`url(#${markerId})`} />
      </svg>
    )
  }
  if (box.type === 'pen') {
    return (
      <svg className="canvas-annotation-vector" viewBox="0 0 100 100" preserveAspectRatio="none">
        <polyline points={(box.pointsPct || []).map((point) => `${point.x},${point.y}`).join(' ')} fill="none" stroke={box.color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
    )
  }
  if (box.type === 'text') return <div className="canvas-annotation-text">{plainTextFromRichText(box.notes) || box.title}</div>
  if (box.type === 'blur') return <div className="canvas-annotation-blur" />
  return null
}

export const FullsiteCanvasModal: React.FC<Props> = ({
  isOpen,
  onClose,
  masterDataUrl,
  pageTitle = 'Staging Page Full-Site Capture',
  initialBoxes = [],
  captureViewport,
  inspectionOverlays = [],
  expiresInSeconds = 604800,
  onItemsGenerated,
}) => {
  const [zoom, setZoom] = useState<number>(0.5) // Default 50% zoom for long sites
  const [boxes, setBoxes] = useState<CanvasSelectionBox[]>(initialBoxes)
  const [selectedBoxId, setSelectedBoxId] = useState<string | null>(null)
  const [isDrawing, setIsDrawing] = useState<boolean>(false)
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null)
  const [drawCurrent, setDrawCurrent] = useState<{ x: number; y: number } | null>(null)
  const [activeTool, setActiveTool] = useState<'box' | 'arrow' | 'rect' | 'circle' | 'pen' | 'text' | 'blur'>('box')
  const [selectedColor, setSelectedColor] = useState<string>('#ff0055')
  const [toastMsg, setToastMsg] = useState<string | null>(null)
  const [generatingLinkId, setGeneratingLinkId] = useState<string | null>(null)
  const [imgNaturalSize, setImgNaturalSize] = useState<{ w: number; h: number } | null>(null)
  const [masterUpload, setMasterUpload] = useState<
    { status: 'idle' | 'uploading' | 'ready' | 'error'; result?: MasterUploadResult; error?: string }
  >({ status: 'idle' })

  // Unique random session ID for every capture
  const [masterId] = useState<string>(
    () => `snap_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`
  )

  const imgRef = useRef<HTMLImageElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const autoGenerationStartedRef = useRef(false)
  const siteSlug = normalizeSiteSlug(pageTitle)
  const viewerBaseUrl = import.meta.env?.VITE_EPHEMERAL_VIEWER_URL || 'https://parity-rz8.pages.dev'

  const withInspectionManifest = (
    annotations: CanvasSelectionBox[],
    overlays: CaptureInspectionOverlay[] = inspectionOverlays,
  ) =>
    overlays.length
      ? [
          ...annotations,
          {
            id: '__inspection_manifest__',
            kind: 'inspection-manifest',
            overlays,
            viewport: captureViewport,
          },
        ]
      : annotations

  const buildMasterSiteUrl = (_result?: MasterUploadResult) => {
    const params = new URLSearchParams({ site: siteSlug, id: masterId })
    return `${viewerBaseUrl}/?${params.toString()}`
  }

  const performMasterUpload = async (annotations: CanvasSelectionBox[]) => {
    setMasterUpload({ status: 'uploading' })
    const result = await uploadMasterImage(
      masterDataUrl,
      siteSlug,
      masterId,
      withInspectionManifest(annotations),
      expiresInSeconds,
    )
    setMasterUpload(
      result.success
        ? { status: 'ready', result }
        : { status: 'error', result, error: result.error || 'Master upload failed.' },
    )
    return result
  }

  useEffect(() => {
    if (initialBoxes && initialBoxes.length > 0) {
      setBoxes(initialBoxes)
    }
  }, [initialBoxes])

  useEffect(() => {
    if (!isOpen || !masterDataUrl || !masterId) return
    let cancelled = false
    setMasterUpload({ status: 'uploading' })
    void uploadMasterImage(
      masterDataUrl,
      siteSlug,
      masterId,
      withInspectionManifest(initialBoxes),
      expiresInSeconds,
    ).then((result) => {
      if (cancelled) return
      setMasterUpload(
        result.success
          ? { status: 'ready', result }
          : { status: 'error', result, error: result.error || 'Master upload failed.' },
      )
    })
    return () => {
      cancelled = true
    }
  }, [isOpen, masterDataUrl, masterId, siteSlug, inspectionOverlays, expiresInSeconds])

  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget
    if (img.naturalWidth && img.naturalHeight) {
      setImgNaturalSize({ w: img.naturalWidth, h: img.naturalHeight })
    }
  }

  const showToast = (msg: string) => {
    setToastMsg(msg)
    setTimeout(() => setToastMsg(null), 3000)
  }

  const masterSiteUrl = buildMasterSiteUrl(masterUpload.result)

  const getBoxImageRect = (box: CanvasSelectionBox) => {
    const naturalW = imgNaturalSize?.w || imgRef.current?.naturalWidth || 1
    const naturalH = imgNaturalSize?.h || imgRef.current?.naturalHeight || 1
    const hasPageCoordinates =
      box.coordinateSpace === 'page' &&
      box.xPx !== undefined &&
      box.yPagePx !== undefined &&
      box.widthPx !== undefined &&
      box.heightPx !== undefined

    if (hasPageCoordinates) {
      // Full-page captures use one uniform device scale. Deriving it from the
      // viewport width keeps document Y/height accurate even for long pages.
      const captureScale = naturalW / Math.max(1, box.viewportWidth || naturalW)
      return {
        x: box.xPx! * captureScale,
        y: box.yPagePx! * captureScale,
        width: box.widthPx! * captureScale,
        height: box.heightPx! * captureScale,
      }
    }

    return {
      x: (box.rectPct.x / 100) * naturalW,
      y: (box.rectPct.y / 100) * naturalH,
      width: (box.rectPct.width / 100) * naturalW,
      height: (box.rectPct.height / 100) * naturalH,
    }
  }

  const getInspectionImageRect = (overlay: CaptureInspectionOverlay) => {
    const naturalW = imgNaturalSize?.w || imgRef.current?.naturalWidth || 1
    const naturalH = imgNaturalSize?.h || imgRef.current?.naturalHeight || 1
    if (overlay.coordinateSpace === 'image-percent' && overlay.rectPct) {
      return {
        x: (overlay.rectPct.x / 100) * naturalW,
        y: (overlay.rectPct.y / 100) * naturalH,
        width: (overlay.rectPct.width / 100) * naturalW,
        height: (overlay.rectPct.height / 100) * naturalH,
      }
    }
    const captureScale = naturalW / Math.max(1, overlay.viewportWidth || captureViewport?.width || naturalW)
    return {
      x: (overlay.xPx || 0) * captureScale,
      y: (overlay.yPagePx || 0) * captureScale,
      width: (overlay.widthPx || 0) * captureScale,
      height: (overlay.heightPx || 0) * captureScale,
    }
  }

  const inspectionOverlaysForCrop = (box: CanvasSelectionBox) => {
    const crop = getBoxImageRect(box)
    return inspectionOverlays.flatMap((overlay) => {
      const rect = getInspectionImageRect(overlay)
      const left = Math.max(crop.x, rect.x)
      const top = Math.max(crop.y, rect.y)
      const right = Math.min(crop.x + crop.width, rect.x + rect.width)
      const bottom = Math.min(crop.y + crop.height, rect.y + rect.height)
      if (right <= left || bottom <= top) return []
      return [{
        ...overlay,
        coordinateSpace: 'image-percent' as const,
        rectPct: {
          x: ((rect.x - crop.x) / crop.width) * 100,
          y: ((rect.y - crop.y) / crop.height) * 100,
          width: (rect.width / crop.width) * 100,
          height: (rect.height / crop.height) * 100,
        },
      }]
    })
  }

  const generateBoxLink = (box: CanvasSelectionBox) =>
    generateEphemeralLink({
      masterDataUrl,
      cropRect: getBoxImageRect(box),
      badgeNumber: box.badgeNumber,
      title: box.title,
      notes: box.notes,
      color: box.color,
      siteSlug,
      masterId,
      annotation: box as unknown as Record<string, unknown>,
      inspectionOverlays: inspectionOverlaysForCrop(box),
      viewport: captureViewport,
      expiresInSeconds,
    })

  useEffect(() => {
    if (
      !isOpen ||
      !imgNaturalSize ||
      !imgRef.current ||
      masterUpload.status !== 'ready' ||
      !masterUpload.result?.success ||
      !boxes.length ||
      autoGenerationStartedRef.current
    ) return

    autoGenerationStartedRef.current = true
    setGeneratingLinkId('all')
    void (async () => {
      const generatedBoxes: CanvasSelectionBox[] = []
      const failures: string[] = []

      for (const box of boxes) {
        if (box.ephemeralUrl) {
          generatedBoxes.push(box)
          continue
        }
        try {
          const result = await generateBoxLink(box)
          if (!result.success || !result.shareUrl) {
            throw new Error(result.error || 'Item link generation failed.')
          }
          generatedBoxes.push({ ...box, ephemeralUrl: result.shareUrl })
        } catch (error: any) {
          generatedBoxes.push(box)
          failures.push(`#${box.badgeNumber}: ${error?.message || 'Item link generation failed.'}`)
        }
      }

      setBoxes(generatedBoxes)
      const successfulBoxes = generatedBoxes.filter((box) => box.ephemeralUrl)
      if (successfulBoxes.length) onItemsGenerated?.(successfulBoxes)
      if (failures.length) {
        showToast(`${successfulBoxes.length} item link${successfulBoxes.length === 1 ? '' : 's'} generated; ${failures.length} failed. Use Copy All to retry.`)
      } else {
        showToast(`${successfulBoxes.length} item${successfulBoxes.length === 1 ? '' : 's'} added to Mock Sheets.`)
      }
    })().finally(() => setGeneratingLinkId(null))
  }, [isOpen, imgNaturalSize, masterUpload.status, masterUpload.result, boxes, onItemsGenerated])

  const handleCopyMasterLink = async () => {
    try {
      let result = masterUpload.result
      if (masterUpload.status !== 'ready' || !result?.success) {
        result = await performMasterUpload(boxes)
      } else if (result.objectPath && result.expiresAt) {
        const metadataResult = await updateMasterAnnotations({
          siteSlug,
          masterId,
          objectPath: result.objectPath,
          annotations: withInspectionManifest(boxes),
          expiresAt: result.expiresAt,
        })
        if (!metadataResult.success) throw new Error(metadataResult.error)
      }
      if (!result?.success) throw new Error(result?.error || 'Master upload failed.')
      await navigator.clipboard.writeText(buildMasterSiteUrl(result))
      showToast('Master page link copied to clipboard!')
    } catch (err: any) {
      showToast(err?.message || 'Failed to copy master link')
    }
  }

  const handleCopyAllLinks = async () => {
    if (!imgRef.current) {
      showToast('The capture is still loading. Please try again.')
      return
    }

    setGeneratingLinkId('all')
    try {
      let masterResult = masterUpload.result
      if (masterUpload.status !== 'ready' || !masterResult?.success) {
        masterResult = await performMasterUpload(boxes)
      } else if (masterResult.objectPath && masterResult.expiresAt) {
        const metadataResult = await updateMasterAnnotations({
          siteSlug,
          masterId,
          objectPath: masterResult.objectPath,
          annotations: withInspectionManifest(boxes),
          expiresAt: masterResult.expiresAt,
        })
        if (!metadataResult.success) throw new Error(metadataResult.error)
      }
      if (!masterResult?.success) throw new Error(masterResult?.error || 'Master upload failed.')

      const generatedBoxes = await Promise.all(
        boxes.map(async (box) => {
          if (box.ephemeralUrl) return box
          const result = await generateBoxLink(box)
          if (!result.success || !result.shareUrl) {
            throw new Error(`#${box.badgeNumber}: ${result.error || 'Item link generation failed.'}`)
          }
          return { ...box, ephemeralUrl: result.shareUrl }
        }),
      )
      setBoxes(generatedBoxes)
      onItemsGenerated?.(generatedBoxes)

      let text = `Master Site Link:\n${buildMasterSiteUrl(masterResult)}\n\nAnnotated Items (${generatedBoxes.length}):\n`
      generatedBoxes.forEach((b) => {
        const itemUrl = b.ephemeralUrl!
        text += `- #${b.badgeNumber} ${b.title}: ${itemUrl}\n`
      })
      await navigator.clipboard.writeText(text)
      showToast('All master & item links copied!')
    } catch (err: any) {
      showToast(err?.message || 'Failed to generate all links')
    } finally {
      setGeneratingLinkId(null)
    }
  }

  const handleScrollToBox = (box: CanvasSelectionBox) => {
    setSelectedBoxId(box.id)
    if (containerRef.current && viewportRef.current) {
      const boxTopPx = getBoxImageRect(box).y * zoom
      viewportRef.current.scrollTo({
        top: Math.max(0, boxTopPx - 120),
        behavior: 'smooth'
      })
    }
  }

  // Handle Mouse Down on Master Image Container to start drawing a selection box
  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / Math.max(1, rect.width)) * containerRef.current.clientWidth
    const y = ((e.clientY - rect.top) / Math.max(1, rect.height)) * containerRef.current.clientHeight

    setIsDrawing(true)
    setDrawStart({ x, y })
    setDrawCurrent({ x, y })
    setSelectedBoxId(null)
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDrawing || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const x = Math.max(0, Math.min(
      containerRef.current.clientWidth,
      ((e.clientX - rect.left) / Math.max(1, rect.width)) * containerRef.current.clientWidth
    ))
    const y = Math.max(0, Math.min(
      containerRef.current.clientHeight,
      ((e.clientY - rect.top) / Math.max(1, rect.height)) * containerRef.current.clientHeight
    ))
    setDrawCurrent({ x, y })
  }

  const handleMouseUp = () => {
    if (!isDrawing || !drawStart || !drawCurrent || !containerRef.current || !imgRef.current) {
      setIsDrawing(false)
      return
    }

    setIsDrawing(false)
    const leftPx = Math.min(drawStart.x, drawCurrent.x)
    const topPx = Math.min(drawStart.y, drawCurrent.y)
    const widthPx = Math.abs(drawCurrent.x - drawStart.x)
    const heightPx = Math.abs(drawCurrent.y - drawStart.y)

    // Ignore tiny accidental clicks
    if (widthPx < 20 || heightPx < 20) {
      setDrawStart(null)
      setDrawCurrent(null)
      return
    }

    const currentDisplayW = containerRef.current.clientWidth
    const currentDisplayH = containerRef.current.clientHeight

    const newBox: CanvasSelectionBox = {
      id: `box_${Date.now()}`,
      badgeNumber: boxes.length + 1,
      title: `Issue Section #${boxes.length + 1}`,
      notes: '',
      color: selectedColor || '#ff0055',
      type: activeTool,
      coordinateSpace: 'page',
      xPx: leftPx,
      yPagePx: topPx,
      widthPx,
      heightPx,
      viewportWidth: currentDisplayW,
      viewportHeight: currentDisplayH,
      viewportKey: captureViewport?.key || `${currentDisplayW}x${currentDisplayH}`,
      deviceName: captureViewport?.name || 'Custom',
      deviceType: captureViewport?.deviceType || 'custom',
      rectPct: {
        x: (leftPx / currentDisplayW) * 100,
        y: (topPx / currentDisplayH) * 100,
        width: (widthPx / currentDisplayW) * 100,
        height: (heightPx / currentDisplayH) * 100
      }
    }

    setBoxes((prev) => [...prev, newBox])
    setSelectedBoxId(newBox.id)
    setDrawStart(null)
    setDrawCurrent(null)
  }

  const handleDeleteBox = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setBoxes((prev) => prev.filter((b) => b.id !== id))
    if (selectedBoxId === id) setSelectedBoxId(null)
  }

  // Generate and copy link for a specific selection box
  const handleCopyLink = async (box: CanvasSelectionBox, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!imgRef.current) return

    setGeneratingLinkId(box.id)
    try {
      const res = await generateBoxLink(box)

      if (res.success && res.shareUrl) {
        await navigator.clipboard.writeText(res.shareUrl)
        const updatedBox = { ...box, ephemeralUrl: res.shareUrl }
        setBoxes((prev) =>
          prev.map((b) => (b.id === box.id ? updatedBox : b))
        )
        onItemsGenerated?.([updatedBox])
        showToast('Link copied to clipboard')
      } else {
        showToast(`Failed: ${res.error || 'Could not generate link'}`)
      }
    } catch (err: any) {
      console.error(err)
      showToast(err?.message || 'Error generating link')
    } finally {
      setGeneratingLinkId(null)
    }
  }

  // Active drawing rectangle dimensions
  let drawingStyle: React.CSSProperties | null = null
  if (isDrawing && drawStart && drawCurrent && containerRef.current) {
    const left = Math.min(drawStart.x, drawCurrent.x)
    const top = Math.min(drawStart.y, drawCurrent.y)
    const width = Math.abs(drawCurrent.x - drawStart.x)
    const height = Math.abs(drawCurrent.y - drawStart.y)
    drawingStyle = {
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`
    }
  }

  if (!isOpen || !masterDataUrl) return null

  return (
    <div className="fullsite-canvas-modal-overlay">
      {/* Top Controls Toolbar */}
      <div className="fullsite-top-bar">
        <div className="fullsite-title-area">
          <div className="fullsite-logo-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M3 9h18" />
              <path d="M9 21V9" />
            </svg>
          </div>
          <div className="fullsite-title-text">
            <h2>{pageTitle}</h2>
            <span>Generate Items & Links: Full site capture with annotated item navigation</span>
          </div>
        </div>

        <div className="fullsite-controls-group">
          <button className="canvas-btn" onClick={() => setZoom((z) => Math.max(0.1, z - 0.1))}>
            - Zoom
          </button>
          <span className="zoom-level-badge">{Math.round(zoom * 100)}%</span>
          <button className="canvas-btn" onClick={() => setZoom((z) => Math.min(2.0, z + 0.1))}>
            + Zoom
          </button>

          <button className="canvas-btn" onClick={() => setZoom(0.5)} title="Reset View">
            Reset 50%
          </button>

          <button className="canvas-btn canvas-btn-primary" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
            <span>Close</span>
          </button>
        </div>
      </div>

      {/* Main Horizontal Layout: Left Sidebar + Viewport */}
      <div className="fullsite-main-layout">
        {/* Left Sidebar Panel */}
        <div className="fullsite-left-sidebar">
          {/* Master Site Link Section */}
          <div className="sidebar-section">
            <span className="sidebar-section-title">Master Page Link</span>
            <div className="sidebar-master-card">
              <div className="capture-dimensions-card">
                <strong>{captureViewport?.name || 'Captured viewport'}</strong>
                <span>
                  {captureViewport
                    ? `${captureViewport.width} × ${captureViewport.height} viewport`
                    : 'Viewport dimensions unavailable'}
                </span>
                {imgNaturalSize && (
                  <span>{imgNaturalSize.w} × {imgNaturalSize.h} full capture</span>
                )}
              </div>
              <div className="master-url-text">{masterSiteUrl}</div>
              <div className={`master-upload-status ${masterUpload.status}`} role="status">
                {masterUpload.status === 'uploading' && 'Uploading capture and annotations…'}
                {masterUpload.status === 'ready' && 'Capture ready to share'}
                {masterUpload.status === 'error' && (masterUpload.error || 'Upload failed')}
              </div>
              <button
                className="canvas-btn canvas-btn-primary"
                onClick={handleCopyMasterLink}
                disabled={masterUpload.status === 'uploading'}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
                <span>{masterUpload.status === 'uploading' ? 'Preparing…' : masterUpload.status === 'error' ? 'Retry Upload' : 'Copy Master Link'}</span>
              </button>
              {boxes.length > 0 && (
                <button
                  className="canvas-btn"
                  onClick={handleCopyAllLinks}
                  disabled={masterUpload.status === 'uploading' || generatingLinkId === 'all'}
                >
                  <span>{generatingLinkId === 'all' ? 'Generating All…' : `Copy All Links (${boxes.length + 1})`}</span>
                </button>
              )}
            </div>
          </div>

          {/* Annotated Items Navigation Section */}
          <div className="sidebar-section">
            <span className="sidebar-section-title">
              Annotated Items ({boxes.length})
            </span>
            {boxes.length === 0 ? (
              <div style={{ fontSize: 11, color: '#71717a', padding: '12px 0' }}>
                No annotated items drawn yet. Click & drag anywhere on the canvas layout to create issue containers.
              </div>
            ) : (
              boxes.map((box) => {
                const isSelected = selectedBoxId === box.id
                return (
                  <div
                    key={box.id}
                    className={`sidebar-item-card ${isSelected ? 'active' : ''}`}
                    onClick={() => handleScrollToBox(box)}
                  >
                    <div className="sidebar-item-header">
                      <span className="sidebar-item-badge" style={{ backgroundColor: box.color }}>
                        #{box.badgeNumber}
                      </span>
                      <strong style={{ fontSize: 12, color: '#fff', flex: 1 }}>{box.title}</strong>
                    </div>

                    {box.notes && <RichTextContent className="sidebar-item-notes rich-text-content" html={box.notes} />}

                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
                      <button
                        className="canvas-btn"
                        style={{ fontSize: 10, padding: '4px 8px' }}
                        onClick={(e) => handleCopyLink(box, e)}
                        disabled={generatingLinkId === box.id}
                      >
                        {generatingLinkId === box.id ? 'Generating...' : 'Copy Item Link'}
                      </button>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>

        {/* Main Zoomable Workspace Viewport */}
        <div ref={viewportRef} className="fullsite-viewport">
          <div
            ref={containerRef}
            className="master-image-container"
            style={{ transform: `scale(${zoom})` }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
          >
            <img ref={imgRef} src={masterDataUrl} alt="Fullsite Master Capture" onLoad={handleImageLoad} />

            <div
              className="inspection-html-layer"
              aria-label="Captured inspection properties"
              style={{ '--inspection-inverse-zoom': String(1 / Math.max(.1, zoom)) } as React.CSSProperties}
            >
              {inspectionOverlays.map((overlay) => {
                const rect = getInspectionImageRect(overlay)
                const naturalW = imgNaturalSize?.w || 1
                const naturalH = imgNaturalSize?.h || 1
                const style: React.CSSProperties = {
                  left: `${(rect.x / naturalW) * 100}%`,
                  top: `${(rect.y / naturalH) * 100}%`,
                  width: `${(rect.width / naturalW) * 100}%`,
                  height: `${(rect.height / naturalH) * 100}%`,
                }
                return (
                  <div
                    key={overlay.id}
                    className={`inspection-html-overlay ${overlay.kind}`}
                    style={style}
                  >
                    {(overlay.kind === 'font' || overlay.kind === 'boundary') && (
                      <span>{overlay.text}</span>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Active drawing selection box */}
            {isDrawing && drawingStyle && (
              <div className="selection-box-overlay" style={drawingStyle} />
            )}

            {/* Rendered Selection Containers */}
            {boxes.map((box) => {
              const isSelected = selectedBoxId === box.id
              const imageRect = getBoxImageRect(box)
              const naturalW = imgNaturalSize?.w || 1
              const naturalH = imgNaturalSize?.h || 1

              const boxStyle: React.CSSProperties = {
                left: `${(imageRect.x / naturalW) * 100}%`,
                top: `${(imageRect.y / naturalH) * 100}%`,
                width: `${(imageRect.width / naturalW) * 100}%`,
                height: `${(imageRect.height / naturalH) * 100}%`,
                borderColor: box.color
              }

              return (
                <div
                  key={box.id}
                  className={`selection-box-overlay annotation-type-${box.type || 'box'} ${isSelected ? 'selection-box-active' : ''}`}
                  style={{
                    ...boxStyle,
                    border:
                      (box.type || 'box') === 'box'
                        ? `2px dashed ${box.color}`
                        : ['rect', 'circle'].includes(box.type || '')
                          ? `2px solid ${box.color}`
                          : 'none',
                    borderRadius: box.type === 'circle' ? '50%' : 4,
                  }}
                  onMouseDown={(e) => {
                    e.stopPropagation()
                    setSelectedBoxId(box.id)
                  }}
                  onMouseUp={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    setSelectedBoxId(box.id)
                  }}
                >
                  <CanvasAnnotationShape box={box} />
                  <div className="box-header-badge" style={{ backgroundColor: box.color }}>
                    <span>#{box.badgeNumber} {box.title}</span>
                  </div>

                  {/* Popover editor for selected box */}
                  {isSelected && (
                    <div
                      className="box-action-popover"
                      onMouseDown={(e) => e.stopPropagation()}
                      onMouseUp={(e) => e.stopPropagation()}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="text"
                        className="box-input"
                        value={box.title}
                        placeholder="Title (e.g. Hero Spacing)"
                        onChange={(e) => {
                          const val = e.target.value
                          setBoxes((prev) =>
                            prev.map((b) => (b.id === box.id ? { ...b, title: val } : b))
                          )
                        }}
                      />
                      <RichTextEditor
                        value={box.notes}
                        placeholder="Notes / Issue description..."
                        compact
                        ariaLabel={`Description for ${box.title}`}
                        onChange={(val) => {
                          setBoxes((prev) =>
                            prev.map((b) => (b.id === box.id ? { ...b, notes: val } : b))
                          )
                        }}
                      />

                      <div className="box-actions-row">
                        <button
                          className="btn-confirm-box"
                          onClick={(e) => {
                            e.stopPropagation()
                            setSelectedBoxId(null)
                          }}
                        >
                          Confirm
                        </button>

                        <button
                          className="canvas-btn canvas-btn-primary"
                          onClick={(e) => handleCopyLink(box, e)}
                          disabled={generatingLinkId === box.id}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                          </svg>
                          <span>{generatingLinkId === box.id ? 'Generating…' : 'Copy link'}</span>
                        </button>

                        <button className="btn-delete-box" onClick={(e) => handleDeleteBox(box.id, e)}>
                          Delete
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {toastMsg && <div className="toast-canvas">{toastMsg}</div>}
    </div>
  )
}
