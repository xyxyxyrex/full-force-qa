import { useEffect, useMemo, useRef, useState } from 'react'
import type { AutomateRunSummary, FindingTriageMap, FindingTriageState, PageSection } from '../../../shared/types'
import { extractSemanticAnchors, findingToAnnotationSpec, semanticFindings, stableId, type AnnotationFromFindingSpec, type ComparedRegion, type DomNode, type Finding, type TokenAssertion } from '../utils/visualCompare'
import './AutomateWorkspace.css'

interface FrameSummary { id: string; name: string; type: string; pageName: string; path?: string; width: number; height: number }

interface Props {
  sourceUrl: string
  figmaUrl?: string
  projectId: string
  onOpenSettings?: () => void
  onCreateAnnotation?: (spec: AnnotationFromFindingSpec) => string
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = src
  })
}

async function isRepeatedViewportCapture(dataUrl: string, documentHeight: number, viewportHeight: number) {
  if (!dataUrl || documentHeight < viewportHeight * 2.4) return false
  const image = await loadImage(dataUrl)
  const sourceTileHeight = viewportHeight * image.naturalHeight / documentHeight
  if (sourceTileHeight < 20 || sourceTileHeight >= image.naturalHeight * .48) return false
  const canvas = document.createElement('canvas'); canvas.width = 48; canvas.height = 48
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  const signature = (tileIndex: number) => {
    const y = Math.min(image.naturalHeight - sourceTileHeight, sourceTileHeight * tileIndex)
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, y, image.naturalWidth, sourceTileHeight, 0, 0, canvas.width, canvas.height)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    return pixels
  }
  const difference = (left: any, right: any) => {
    let total = 0
    for (let index = 0; index < left.length; index++) total += Math.abs(left[index] - right[index])
    return total / left.length
  }
  const first = signature(0); const second = signature(1); const third = signature(2)
  const fourth = documentHeight >= viewportHeight * 3.6 ? signature(3) : null
  const firstRepeated = difference(first, second) < 2.2 && difference(first, third) < 2.2
  const laterRepeated = difference(second, third) < 2.2 && (!fourth || difference(third, fourth) < 2.2)
  return firstRepeated || laterRepeated
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(message)), milliseconds)
    promise.then((value) => { clearTimeout(timeout); resolve(value) }, (error) => { clearTimeout(timeout); reject(error) })
  })
}

async function captureFullPage(view: any, viewportWidth: number, viewportHeight: number, onProgress: (percent: number, detail: string) => void, isCancelled: () => boolean) {
  const metrics = await withTimeout(view.executeJavaScript(`(async () => {
    const freeze = document.createElement('style');
    freeze.id = '__qaAutomateFreeze';
    freeze.textContent = '*, *::before, *::after { animation-play-state: paused !important; transition: none !important; caret-color: transparent !important; } html, body { scrollbar-width: none !important; } ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }';
    document.head?.appendChild(freeze);
    const animations = document.getAnimations().map((animation) => ({ animation, playState: animation.playState }));
    for (const item of animations) { try { item.animation.pause(); } catch {} }
    // Wait for the page to actually be ready to photograph — fonts and
    // in-flight images — rather than trusting a flat delay was long enough.
    try { await Promise.race([(document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve(), new Promise((resolve) => setTimeout(resolve, 3000))]); } catch {}
    const pendingImages = Array.from(document.images || []).slice(0, 400).filter((img) => !img.complete);
    await Promise.all(pendingImages.map((img) => new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
      setTimeout(resolve, 4000);
    })));
    const root = document.documentElement; const body = document.body;
    const documentScroller = document.scrollingElement || root;
    const candidates = [documentScroller, ...Array.from(document.body?.querySelectorAll('*') || []).filter((element) => {
      const style = getComputedStyle(element); const range = element.scrollHeight - element.clientHeight;
      return range > 100 && /(auto|scroll|overlay)/.test(style.overflowY);
    })];
    let scroller = documentScroller; let bestRange = -1;
    for (const candidate of candidates) {
      const range = candidate.scrollHeight - candidate.clientHeight;
      const previous = candidate.scrollTop; const behavior = candidate.style.scrollBehavior; const snap = candidate.style.scrollSnapType;
      candidate.style.setProperty('scroll-behavior', 'auto', 'important'); candidate.style.setProperty('scroll-snap-type', 'none', 'important');
      candidate.scrollTop = Math.min(137, Math.max(0, range)); const moved = candidate.scrollTop;
      candidate.scrollTop = previous; candidate.style.scrollBehavior = behavior; candidate.style.scrollSnapType = snap;
      if (moved > 50 && range > bestRange) { scroller = candidate; bestRange = range; }
    }
    const height = Math.max(scroller.scrollHeight, scroller.clientHeight);
    window.__qaAutomateCapture = { x: scrollX, y: scrollY, scroller, scrollTop: scroller.scrollTop, scrollBehavior: scroller.style.scrollBehavior, scrollSnapType: scroller.style.scrollSnapType, overflowAnchor: scroller.style.overflowAnchor, positioned: [], animations };
    scroller.style.setProperty('scroll-behavior', 'auto', 'important');
    scroller.style.setProperty('scroll-snap-type', 'none', 'important');
    scroller.style.setProperty('overflow-anchor', 'none', 'important');
    for (const element of Array.from(document.body?.querySelectorAll('*') || [])) {
      const position = getComputedStyle(element).position;
      if (position === 'fixed' || position === 'sticky') {
        window.__qaAutomateCapture.positioned.push({ element, visibility: element.style.visibility });
      }
    }
    scroller.scrollTop = 0; if (scroller === documentScroller) scrollTo(0, 0);
    return { height: Math.ceil(height), width: Math.ceil(Math.max(root.scrollWidth, body?.scrollWidth || 0)), clientHeight: Math.ceil(scroller.clientHeight), scrollRange: Math.ceil(scroller.scrollHeight - scroller.clientHeight), innerHeight: Math.ceil(innerHeight), scrollerTag: scroller.tagName.toLowerCase(), scrollerId: scroller.id || '' };
  })()`, true), 20000, 'Timed out while measuring the live page.') as { height: number; width: number; clientHeight: number; scrollRange: number; innerHeight: number; scrollerTag: string; scrollerId: string }
  const fullHeight = Math.max(viewportHeight, metrics.height)
  const positions: number[] = []
  for (let y = 0; y < fullHeight; y += viewportHeight) positions.push(Math.min(y, Math.max(0, fullHeight - viewportHeight)))
  const uniquePositions = Array.from(new Set(positions))
  let canvas: HTMLCanvasElement | null = null; let context: CanvasRenderingContext2D | null = null; let ratio = 1
  const captureExpandedSurface = async () => {
    onProgress(34, `Expanding Chromium's ${metrics.clientHeight}px guest surface for full-page capture…`)
    const originalHeight = view.style.height
    try {
      view.style.height = `${fullHeight}px`
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      await view.executeJavaScript(`(async () => { const capture = window.__qaAutomateCapture; const scroller = capture?.scroller || document.scrollingElement || document.documentElement; scroller.scrollTop = 0; if (scroller === document.scrollingElement) scrollTo(0, 0); await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); return scroller.scrollTop; })()`, true)
      await wait(320)
      const nativeImage: any = await withTimeout(view.capturePage(), 20_000, 'Timed out capturing the expanded Chromium surface.')
      const expanded = await withTimeout(loadImage(nativeImage.toDataURL()), 10_000, 'Unable to decode the expanded Chromium surface.')
      ratio = expanded.naturalWidth / viewportWidth
      const expectedHeight = Math.max(1, Math.round(fullHeight * ratio))
      if (expanded.naturalHeight < expectedHeight * .9) throw new Error(`Chromium exposed only ${expanded.naturalHeight}px of an expected ${expectedHeight}px expanded surface.`)
      canvas = document.createElement('canvas'); canvas.width = expanded.naturalWidth; canvas.height = expectedHeight; context = canvas.getContext('2d')!
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(expanded, 0, 0, expanded.naturalWidth, Math.min(expanded.naturalHeight, expectedHeight), 0, 0, expanded.naturalWidth, Math.min(expanded.naturalHeight, expectedHeight))
      const dataUrl = canvas.toDataURL('image/png')
      if (await isRepeatedViewportCapture(dataUrl, fullHeight, viewportHeight)) throw new Error('Chromium repeated the first compositor frame inside the expanded surface.')
      return { dataUrl, documentHeight: fullHeight, documentWidth: metrics.width, tiles: 1, mode: 'expanded-surface' }
    } finally {
      view.style.height = originalHeight || `${viewportHeight}px`
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    }
  }
  try {
    if (metrics.scrollRange <= 5 && fullHeight > viewportHeight * 1.5) {
      return await captureExpandedSurface()
    }
    for (let index = 0; index < uniquePositions.length; index++) {
      if (isCancelled()) throw new Error('Comparison cancelled.')
      const y = uniquePositions[index]
      onProgress(28 + index / Math.max(1, uniquePositions.length) * 42, `Capturing live page tile ${index + 1} of ${uniquePositions.length}…`)
      const actualPosition: any = await withTimeout(view.executeJavaScript(`(async () => {
        const capture = window.__qaAutomateCapture;
        for (const item of capture?.positioned || []) item.element.style.visibility = ${y === 0 ? 'item.visibility' : "'hidden'"};
        const scroller = capture?.scroller || document.scrollingElement || document.documentElement;
        scroller.style.setProperty('scroll-behavior', 'auto', 'important');
        scroller.style.setProperty('scroll-snap-type', 'none', 'important');
        scroller.style.setProperty('overflow-anchor', 'none', 'important');
        scroller.scrollTop = ${y}; if (scroller === document.scrollingElement) scrollTo(0, ${y});
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return { x: scrollX, y: scroller.scrollTop, tag: scroller.tagName, id: scroller.id || '' };
      })()`, true), 5000, `Timed out while scrolling to tile ${index + 1}.`)
      if (Math.abs(Number(actualPosition?.y || 0) - y) > 3) {
        if (fullHeight > viewportHeight * 1.5) return await captureExpandedSurface()
        throw new Error(`Chromium stopped at ${Math.round(Number(actualPosition?.y || 0))}px instead of tile ${index + 1} at ${y}px (${metrics.scrollerTag}${metrics.scrollerId ? `#${metrics.scrollerId}` : ''}, client ${metrics.clientHeight}px, range ${metrics.scrollRange}px).`)
      }
      await wait(120)
      const nativeImage: any = await withTimeout(view.capturePage(), 12000, `Timed out capturing live page tile ${index + 1}.`)
      const tile = await withTimeout(loadImage(nativeImage.toDataURL()), 8000, `Unable to decode live page tile ${index + 1}.`)
      if (!canvas) {
        ratio = tile.naturalWidth / viewportWidth
        canvas = document.createElement('canvas'); canvas.width = tile.naturalWidth; canvas.height = Math.max(1, Math.ceil(fullHeight * ratio)); context = canvas.getContext('2d')!
        context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height)
      }
      const destinationY = Math.round(y * ratio); const drawHeight = Math.min(tile.naturalHeight, canvas.height - destinationY)
      context!.drawImage(tile, 0, 0, tile.naturalWidth, drawHeight, 0, destinationY, tile.naturalWidth, drawHeight)
    }
    if (!canvas) throw new Error('The live page capture returned no image data.')
    const dataUrl = canvas.toDataURL('image/png')
    if (await isRepeatedViewportCapture(dataUrl, fullHeight, viewportHeight)) throw new Error('Chromium did not repaint while scrolling. The repeated capture was rejected; keep Automate visible and retry.')
    return { dataUrl, documentHeight: fullHeight, documentWidth: metrics.width, tiles: uniquePositions.length, mode: 'verified-tiles' }
  } finally {
    try {
      await view.executeJavaScript(`(() => { document.getElementById('__qaAutomateFreeze')?.remove(); const capture = window.__qaAutomateCapture; for (const item of capture?.positioned || []) item.element.style.visibility = item.visibility; for (const item of capture?.animations || []) { if (item.playState === 'running') { try { item.animation.play(); } catch {} } } if (capture) { const scroller = capture.scroller || document.scrollingElement || document.documentElement; window.__qaAutomateSemanticScroller = scroller; scroller.style.scrollBehavior = capture.scrollBehavior; scroller.style.scrollSnapType = capture.scrollSnapType; scroller.style.overflowAnchor = capture.overflowAnchor; scroller.scrollTop = capture.scrollTop; if (scroller === document.scrollingElement) scrollTo(capture.x, capture.y); } delete window.__qaAutomateCapture; })()`, true)
    } catch { }
  }
}

async function createVisualDiff(designUrl: string, liveUrl: string) {
  const [design, live] = await Promise.all([loadImage(designUrl), loadImage(liveUrl)])
  const scale = Math.min(1, 900 / design.naturalWidth, 1800 / design.naturalHeight)
  const width = Math.max(1, Math.round(design.naturalWidth * scale)); const height = Math.max(1, Math.round(design.naturalHeight * scale))
  const a = document.createElement('canvas'); const b = document.createElement('canvas'); const out = document.createElement('canvas')
  a.width = b.width = out.width = width; a.height = b.height = out.height = height
  const ac = a.getContext('2d', { willReadFrequently: true })!; const bc = b.getContext('2d', { willReadFrequently: true })!; const oc = out.getContext('2d')!
  ac.fillStyle = '#fff'; bc.fillStyle = '#fff'; ac.fillRect(0, 0, width, height); bc.fillRect(0, 0, width, height)
  ac.drawImage(design, 0, 0, width, height)
  const liveHeight = Math.round(live.naturalHeight * width / Math.max(1, live.naturalWidth))
  bc.drawImage(live, 0, 0, width, liveHeight)
  const ad = ac.getImageData(0, 0, width, height); const bd = bc.getImageData(0, 0, width, height); const diff = oc.createImageData(width, height)
  let changed = 0; let totalDelta = 0
  for (let index = 0; index < ad.data.length; index += 4) {
    const delta = Math.abs(ad.data[index] - bd.data[index]) + Math.abs(ad.data[index + 1] - bd.data[index + 1]) + Math.abs(ad.data[index + 2] - bd.data[index + 2])
    totalDelta += delta
    if (delta > 72) { changed++; diff.data[index] = 255; diff.data[index + 1] = Math.min(150, delta / 3); diff.data[index + 2] = 80; diff.data[index + 3] = 215 }
    else { diff.data[index] = ad.data[index] * .22; diff.data[index + 1] = ad.data[index + 1] * .22; diff.data[index + 2] = ad.data[index + 2] * .22; diff.data[index + 3] = 105 }
  }
  oc.putImageData(diff, 0, 0)
  const pixels = width * height
  return { dataUrl: out.toDataURL('image/png'), changedPercent: changed / pixels * 100, similarity: Math.max(0, 100 - totalDelta / (pixels * 765) * 100) }
}

function FindingComparisonView({ finding, designImage, liveImage, onClose }: { finding: Finding; designImage: string; liveImage: string; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let disposed = false
    Promise.all([loadImage(designImage), loadImage(liveImage)]).then(([design, live]) => {
      if (disposed || !canvasRef.current) return
      const canvas = canvasRef.current; canvas.width = 1200; canvas.height = 560
      const context = canvas.getContext('2d')!; context.fillStyle = '#09090b'; context.fillRect(0, 0, canvas.width, canvas.height)
      const roundedRect = (x: number, y: number, width: number, height: number, radius: number) => {
        context.beginPath(); context.roundRect(x, y, width, height, radius)
      }
      const badge = (text: string, x: number, y: number, color: string) => {
        context.font = '600 13px system-ui'; const width = context.measureText(text).width + 16
        roundedRect(x, y - 20, width, 22, 4); context.fillStyle = color; context.fill(); context.fillStyle = '#fff'; context.fillText(text, x + 8, y - 5)
      }
      const drawPanel = (image: HTMLImageElement, region: ComparedRegion | undefined, panelX: number, title: string, color: string) => {
        const panelY = 58; const panelWidth = 550; const panelHeight = 410
        context.fillStyle = '#18181b'; roundedRect(panelX, panelY, panelWidth, panelHeight, 8); context.fill()
        context.fillStyle = color; context.font = '700 13px system-ui'; context.fillText(title, panelX, 32)
        if (!region) {
          context.fillStyle = '#27272a'; roundedRect(panelX + 14, panelY + 14, panelWidth - 28, panelHeight - 28, 6); context.fill()
          context.fillStyle = '#f87171'; context.font = '650 18px system-ui'; context.textAlign = 'center'; context.fillText('No corresponding element found', panelX + panelWidth / 2, panelY + panelHeight / 2)
          context.fillStyle = '#71717a'; context.font = '12px system-ui'; context.fillText('The matcher could not establish a reliable live pairing.', panelX + panelWidth / 2, panelY + panelHeight / 2 + 25); context.textAlign = 'left'
          return null
        }
        const rect = region.rect;
        const cropWidth = region.pageWidth
        const cropHeight = Math.min(region.pageHeight, Math.max(380, cropWidth * (panelHeight - 28) / (panelWidth - 28)))
        const targetCenterY = rect.y + rect.height / 2
        const cropX = 0
        const cropY = Math.max(0, Math.min(region.pageHeight - cropHeight, targetCenterY - cropHeight / 2))
        const imageScaleX = image.naturalWidth / region.pageWidth; const imageScaleY = image.naturalHeight / region.pageHeight
        const fit = Math.min((panelWidth - 28) / cropWidth, (panelHeight - 28) / cropHeight)
        const drawWidth = cropWidth * fit; const drawHeight = cropHeight * fit; const drawX = panelX + (panelWidth - drawWidth) / 2; const drawY = panelY + (panelHeight - drawHeight) / 2
        context.save(); roundedRect(panelX + 1, panelY + 1, panelWidth - 2, panelHeight - 2, 7); context.clip()
        context.drawImage(image, cropX * imageScaleX, cropY * imageScaleY, cropWidth * imageScaleX, cropHeight * imageScaleY, drawX, drawY, drawWidth, drawHeight); context.restore()
        const boxX = drawX + (rect.x - cropX) * fit; const boxY = drawY + (rect.y - cropY) * fit; const boxWidth = Math.max(2, rect.width * fit); const boxHeight = Math.max(2, rect.height * fit)
        context.strokeStyle = color; context.lineWidth = 3; context.strokeRect(boxX, boxY, boxWidth, boxHeight)
        context.fillStyle = `${color}22`; context.fillRect(boxX, boxY, boxWidth, boxHeight)
        badge(`${Math.round(rect.width)} × ${Math.round(rect.height)} px`, boxX, Math.max(panelY + 25, boxY), color)
        context.fillStyle = '#d4d4d8'; context.font = '11px ui-monospace, monospace'; context.fillText(`X ${Math.round(rect.x)}   Y ${Math.round(rect.y)}`, panelX + 10, panelY + panelHeight + 20)
        context.fillStyle = '#a1a1aa'; context.font = '11px system-ui'; context.fillText(region.label.slice(0, 66), panelX + 10, panelY + panelHeight + 38)
        return { x: boxX + boxWidth, y: boxY + boxHeight / 2, oppositeX: boxX, color }
      }
      const left = drawPanel(design, finding.comparison?.design, 25, 'FIGMA EXPECTED', '#a78bfa')
      const right = drawPanel(live, finding.comparison?.live, 625, 'LIVE CHROMIUM', '#22d3ee')
      if (left && right) {
        context.strokeStyle = '#f8fafc'; context.lineWidth = 2; context.setLineDash([6, 5]); context.beginPath(); context.moveTo(left.x, left.y); context.lineTo(right.oppositeX, right.y); context.stroke(); context.setLineDash([])
        const angle = Math.atan2(right.y - left.y, right.oppositeX - left.x); context.fillStyle = '#f8fafc'; context.beginPath(); context.moveTo(right.oppositeX, right.y); context.lineTo(right.oppositeX - 11 * Math.cos(angle - .45), right.y - 11 * Math.sin(angle - .45)); context.lineTo(right.oppositeX - 11 * Math.cos(angle + .45), right.y - 11 * Math.sin(angle + .45)); context.closePath(); context.fill()
      }
      const delta = finding.comparison?.delta
      if (delta) {
        const values = [delta.x !== undefined ? `ΔX ${Math.round(delta.x)}px` : '', delta.y !== undefined ? `ΔY ${Math.round(delta.y)}px` : '', delta.width !== undefined ? `ΔW ${Math.round(delta.width)}px` : '', delta.height !== undefined ? `ΔH ${Math.round(delta.height)}px` : '', delta.fontSize !== undefined ? `Δ font ${Math.round(delta.fontSize * 10) / 10}px` : ''].filter(Boolean).join('    ')
        context.fillStyle = '#fbbf24'; context.font = '650 12px ui-monospace, monospace'; context.textAlign = 'center'; context.fillText(values, 600, 548); context.textAlign = 'left'
      }
    }).catch(() => { })
    return () => { disposed = true }
  }, [designImage, finding, liveImage])
  return (
    <div className="automate-finding-comparison">
      <div className="automate-finding-comparison-head">
        <div>
          <strong>{finding.title}</strong>
          <span>{finding.detail}</span>
        </div>
        <button onClick={onClose} title="Return to visual overview">×</button>
      </div>
      <canvas ref={canvasRef} />
    </div>
  )
}

function ConformanceSparkline({ runs }: { runs: AutomateRunSummary[] }) {
  if (runs.length < 2) return null
  const ordered = [...runs].sort((a, b) => a.at - b.at)
  const width = 160; const height = 28; const pad = 3
  const scores = ordered.map((r) => r.conformanceScore)
  const min = Math.min(...scores); const max = Math.max(...scores)
  const range = Math.max(1, max - min)
  const toPoint = (index: number, score: number) => {
    const x = pad + (index / (ordered.length - 1)) * (width - pad * 2)
    const y = height - pad - ((score - min) / range) * (height - pad * 2)
    return { x, y }
  }
  const points = ordered.map((run, index) => { const p = toPoint(index, run.conformanceScore); return `${p.x.toFixed(1)},${p.y.toFixed(1)}` }).join(' ')
  const last = toPoint(ordered.length - 1, ordered[ordered.length - 1].conformanceScore)
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Conformance trend across recent runs: ${scores.join(', ')}`}>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.8" />
      <circle cx={last.x} cy={last.y} r="2.5" fill="currentColor" />
    </svg>
  )
}

function TokenIconBadge({ token }: { token: TokenAssertion }) {
  const renderIcon = () => {
    switch (token.name) {
      case 'font-size':
        return (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 19L10 5L16 19" />
            <path d="M6 14H14" />
            <path d="M18 19V11" />
            <path d="M16 13C16 11.9 16.9 11 18 11C19.1 11 20 11.9 20 13V19" />
          </svg>
        )
      case 'font-weight':
        return (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" />
            <path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" />
          </svg>
        )
      case 'line-height':
        return (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 6H3" />
            <path d="M21 18H3" />
            <path d="M12 9l-2 3h4l-2-3z" />
            <path d="M12 15l-2-3h4l-2 3z" />
            <path d="M12 9v6" />
          </svg>
        )
      case 'letter-spacing':
        return (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 8L3 12L7 16" />
            <path d="M17 8L21 12L17 16" />
            <path d="M3 12H21" />
          </svg>
        )
      case 'font-family':
        return (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 7 4 4 20 4 20 7" />
            <line x1="9" y1="20" x2="15" y2="20" />
            <line x1="12" y1="4" x2="12" y2="20" />
          </svg>
        )
      case 'color':
        return (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2a10 10 0 0 1 10 10c0 2.5-2 4.5-4.5 4.5H16a2 2 0 0 0-2 2v.5c0 1.4-1.1 2.5-2.5 2.5A10 10 0 0 1 12 2z" />
            <circle cx="7.5" cy="10.5" r="1" fill="currentColor" />
            <circle cx="12" cy="7.5" r="1" fill="currentColor" />
            <circle cx="16.5" cy="10.5" r="1" fill="currentColor" />
          </svg>
        )
      case 'text-align':
        return (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="15" y2="12" />
            <line x1="3" y1="18" x2="18" y2="18" />
          </svg>
        )
      case 'bg-color':
        return (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 11l-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2a2 2 0 0 0 2.8 0L19 11z" />
            <path d="M5 2c0 2 2 4 4 4" />
          </svg>
        )
      case 'border-radius':
        return (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="5" />
          </svg>
        )
      case 'text-case':
        return (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 17L7 7L11 17" />
            <path d="M4.5 13H9.5" />
            <path d="M13 8h5" />
            <path d="M15.5 8v9" />
          </svg>
        )
      case 'font-loaded':
        return (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 19L10 5L16 19" />
            <path d="M6 14H14" />
            <line x1="18" y1="6" x2="22" y2="10" />
            <line x1="22" y1="6" x2="18" y2="10" />
          </svg>
        )
      default:
        return (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="4" />
          </svg>
        )
    }
  }

  const shortName = token.name.replace('font-', '').replace('letter-', '').replace('line-', '')

  if (token.unresolved) {
    return (
      <div className="automate-token-chip unresolved" title={`${token.name}: could not be compared (Figma ${token.figma} vs live "${token.css}")`}>
        <span className="tok-icon">{renderIcon()}</span>
        <span className="tok-label">{shortName}</span>
        <span className="tok-val">unresolved</span>
      </div>
    )
  }

  return token.passed ? (
    <div className="automate-token-chip pass" title={`${token.name}: Figma ${token.figma} = CSS ${token.css}`}>
      <span className="tok-icon">{renderIcon()}</span>
      <span className="tok-label">{shortName}</span>
      <span className="tok-val">{token.css}</span>
    </div>
  ) : (
    <div className="automate-token-chip fail" title={`Mismatch on ${token.name}: Figma ${token.figma} vs Live CSS ${token.css}`}>
      <span className="tok-icon">{renderIcon()}</span>
      <span className="tok-label">{shortName}</span>
      <span className="tok-figma" title="Figma expected">{token.figma}</span>
      <span className="tok-divider">→</span>
      <span className="tok-val" title="Live computed CSS">{token.css}</span>
      <span className="tok-alert" title="Spec mismatch">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      </span>
    </div>
  )
}

export default function AutomateWorkspace({ sourceUrl, figmaUrl = '', projectId, onOpenSettings, onCreateAnnotation }: Props) {
  const webviewRef = useRef<any>(null)
  const [expandedTokensMap, setExpandedTokensMap] = useState<Record<number, boolean>>({})
  const comparisonRunRef = useRef(0)
  const activeVisualJobRef = useRef('')
  const [tokenConfigured, setTokenConfigured] = useState(false); const [token, setToken] = useState(''); const [showToken, setShowToken] = useState(false)
  const [designUrl, setDesignUrl] = useState(() => localStorage.getItem(`qa_${projectId}_automate_figma_url`) || figmaUrl)
  const [frames, setFrames] = useState<FrameSummary[]>([]); const [frameId, setFrameId] = useState(''); const [fileName, setFileName] = useState('')
  const [ready, setReady] = useState(false); const [busy, setBusy] = useState(false); const [status, setStatus] = useState('Connect a Figma frame to begin.'); const [error, setError] = useState('')
  const [designImage, setDesignImage] = useState(''); const [liveImage, setLiveImage] = useState(''); const [diffImage, setDiffImage] = useState('')
  const [similarity, setSimilarity] = useState<number | null>(null); const [changed, setChanged] = useState<number | null>(null); const [view, setView] = useState<'diff' | 'design' | 'live'>('diff')
  const [sections, setSections] = useState<PageSection[]>([])
  const [progress, setProgress] = useState({ percent: 0, detail: '' })
  const [liveDocumentHeight, setLiveDocumentHeight] = useState<number | null>(null)
  const [selectedFindingIndex, setSelectedFindingIndex] = useState<number | null>(null)
  const [visualEngine, setVisualEngine] = useState('')
  const [rawDesignNode, setRawDesignNode] = useState<any>(null)
  const [rawDomNodes, setRawDomNodes] = useState<DomNode[] | null>(null)
  const [rawVisualData, setRawVisualData] = useState<any>(null)
  const [triage, setTriage] = useState<FindingTriageMap>({})
  const [showTriaged, setShowTriaged] = useState(false)
  const [styleNames, setStyleNames] = useState<Record<string, string>>({})
  const [breakpoint, setBreakpoint] = useState<'Desktop' | 'Tablet' | 'Mobile'>('Desktop')
  const [runHistory, setRunHistory] = useState<AutomateRunSummary[]>([])
  const [lastCompletedRunId, setLastCompletedRunId] = useState(0)
  // Session-only: once pinned, the annotation itself is the persistent record —
  // no need for a second persistence layer the way triage state needs one.
  const [pinnedFindingIds, setPinnedFindingIds] = useState<Set<string>>(new Set())
  const selectedFrame = useMemo(() => frames.find((frame) => frame.id === frameId), [frameId, frames])

  useEffect(() => {
    // This tab unmounts and remounts on every click (conditional render in
    // EditorWorkspace), so a live API round-trip here means every click into
    // Automate depends on Figma answering right now. Read the stored-token
    // state instead — instant, no network — and only actually calling Figma
    // (loadFrames / runComparison) will ever surface a truly revoked token.
    const syncStatus = () => window.electronAPI.figmaTokenStatus(false).then((result) => setTokenConfigured(result.apiConfigured)).catch(() => { })
    void syncStatus()
    return window.electronAPI.onFigmaAuthChanged?.((result) => setTokenConfigured(result.apiConfigured))
  }, [])
  useEffect(() => { window.electronAPI.getFindingTriage(projectId).then(setTriage).catch(() => { }) }, [projectId])

  // A frame's own width is a reasonable guess at its breakpoint; the analyst can
  // override it when tagging runs for history, since guesses aren't always right.
  useEffect(() => {
    if (!selectedFrame) return
    setBreakpoint(selectedFrame.width < 600 ? 'Mobile' : selectedFrame.width < 1024 ? 'Tablet' : 'Desktop')
  }, [selectedFrame])

  useEffect(() => {
    if (!selectedFrame) { setRunHistory([]); return }
    window.electronAPI.getAutomateRuns(projectId, selectedFrame.id).then(setRunHistory).catch(() => { })
  }, [projectId, selectedFrame])

  const applyTriage = (findingId: string, state: FindingTriageState | null) => {
    setTriage((prev) => {
      const next = { ...prev }
      if (state) next[findingId] = { state, at: Date.now() }
      else delete next[findingId]
      return next
    })
    void window.electronAPI.setFindingTriage(projectId, findingId, state)
  }
  useEffect(() => { if (figmaUrl && !designUrl) setDesignUrl(figmaUrl) }, [designUrl, figmaUrl])
  useEffect(() => {
    const view = webviewRef.current
    if (!view) return
    const loaded = () => { setReady(true); setError('') }
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
      setTokenConfigured(result.success && result.configured)
      if (result.success && result.configured) { setToken(''); setShowToken(false); setStatus('Figma API connected securely. Load a design to verify file access.') }
      else setError(result.error || 'Unable to save the Figma token.')
    } catch (cause: any) {
      setError(cause?.message || 'The Figma connection service did not respond. Restart the application and try again.')
    } finally { setBusy(false) }
  }
  const loadFrames = async () => {
    if (!designUrl.trim()) return setError('Enter a Figma design URL.')
    setBusy(true); setError(''); setStatus('Reading Figma frame structure…')
    const result = await window.electronAPI.listFigmaFrames(designUrl.trim())
    setBusy(false)
    if (!result.success) return setError(result.error || 'Unable to read the Figma file.')
    const nextFrames = result.frames || []; setFrames(nextFrames); setFileName(result.fileName || 'Figma design')
    setStyleNames(result.styleNames || {})
    const requested = nextFrames.find((frame) => frame.id === result.requestedNodeId)?.id
    setFrameId(requested || nextFrames[0]?.id || ''); localStorage.setItem(`qa_${projectId}_automate_figma_url`, designUrl.trim())
    setStatus(`${nextFrames.length} comparable frames found.`)
  }
  const runComparison = async () => {
    if (!selectedFrame) return setError('Select a Figma frame first.')
    if (!webviewRef.current) return setError('The staging capture browser is not attached yet.')
    const runId = ++comparisonRunRef.current
    const visualJobId = `${projectId}:${runId}`
    activeVisualJobRef.current = visualJobId
    const cancelled = () => comparisonRunRef.current !== runId
    const updateProgress = (percent: number, detail: string) => { if (!cancelled()) { setProgress({ percent: Math.round(percent), detail }); setStatus(detail) } }
    setBusy(true); setError(''); setStatus('Preparing comparison…'); setProgress({ percent: 4, detail: 'Preparing comparison…' }); setSelectedFindingIndex(null); setVisualEngine(''); setSections([])
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
      const domNodes = liveCapture.domNodes?.length ? liveCapture.domNodes as DomNode[] : await view.executeJavaScript(`(() => {
        const selectors = 'h1,h2,h3,h4,h5,h6,p,a,button,label,li,span,div,dt,dd,summary,figcaption,th,td,img,input,section,article,header,footer,nav,main';
        const semanticTextSelector = 'h1,h2,h3,h4,h5,h6,p,a,button,label,li,span,dt,dd,summary,figcaption,th,td';
        const directSemanticSelector = semanticTextSelector.split(',').map((selector) => ':scope > ' + selector).join(',');
        const documentScroller = document.scrollingElement || document.documentElement;
        const scrollCandidates = [documentScroller, ...Array.from(document.body?.querySelectorAll('*') || []).filter((element) => {
          const style = getComputedStyle(element); return element.scrollHeight - element.clientHeight > 100 && /(auto|scroll|overlay)/.test(style.overflowY);
        })];
        const scroller = window.__qaAutomateSemanticScroller || scrollCandidates.reduce((best, candidate) => candidate.scrollHeight - candidate.clientHeight > best.scrollHeight - best.clientHeight ? candidate : best, documentScroller);
        const scrollerRect = scroller.getBoundingClientRect();
        const pageHeight = Math.max(scroller.scrollHeight, scroller.clientHeight);
        const compact = (value) => String(value || '').trim().replace(/\\s+/g, ' ');
        const directText = (element) => compact(Array.from(element.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent || '').join(' '));
        const elementText = (element) => {
          const accessible = compact(element.getAttribute('alt') || element.getAttribute('aria-label') || element.getAttribute('title') || '');
          if (element.matches('img,input')) return accessible;
          const isLeaf = element.matches('h1,h2,h3,h4,h5,h6,p,a,button,label,li,span,dt,dd,summary,figcaption,th,td');
          if (isLeaf) return compact(element.innerText || element.textContent || accessible);
          const own = directText(element);
          if (own) return own;
          if (!element.querySelector(semanticTextSelector)) return compact(element.innerText || element.textContent || accessible);
          return accessible;
        };
        const contextFor = (element) => {
          const container = element.closest('section,article,nav,header,footer,main') || element.parentElement;
          const heading = container?.querySelector('h1,h2,h3,h4,h5,h6');
          let previous = element.previousElementSibling;
          while (previous && !previous.matches('h1,h2,h3,h4,h5,h6')) previous = previous.previousElementSibling;
          return compact([container?.id, container?.getAttribute('aria-label'), heading?.textContent, previous?.textContent].filter(Boolean).join(' ')).slice(0, 320);
        };
        const pathFor = (element) => {
          const parts = []; let current = element;
          while (current && current !== document.body && parts.length < 6) {
            const marker = current.id ? '#' + current.id : Array.from(current.classList || []).slice(0, 2).map((name) => '.' + name).join('');
            parts.unshift(current.tagName.toLowerCase() + marker); current = current.parentElement;
          }
          return parts.join(' > ');
        };
        const fontActuallyLoaded = (style) => {
          try {
            const family = (style.fontFamily.split(',')[0] || '').trim().replace(/^["']|["']$/g, '');
            if (!family || !document.fonts || !document.fonts.check) return true;
            return document.fonts.check(style.fontWeight + ' ' + style.fontSize + ' "' + family + '"');
          } catch { return true; }
        };
        return Array.from(document.querySelectorAll(selectors)).map((element) => {
          const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
          const positioned = style.position === 'fixed' || style.position === 'sticky';
          const insideNestedScroller = scroller !== documentScroller && scroller.contains(element);
          const pageX = positioned ? rect.left : insideNestedScroller ? rect.left - scrollerRect.left + scroller.scrollLeft : rect.left + scrollX;
          const pageY = positioned ? rect.top : insideNestedScroller ? rect.top - scrollerRect.top + scroller.scrollTop : rect.top + scrollY;
          return { tag: element.tagName.toLowerCase(), role: element.getAttribute('role') || '', text: elementText(element).slice(0, 500), src: element.tagName === 'IMG' ? element.currentSrc || element.src : '', context: contextFor(element), path: pathFor(element), rect: { x: pageX, y: pageY, width: rect.width, height: rect.height }, styles: { fontSize: style.fontSize, fontFamily: style.fontFamily, fontWeight: style.fontWeight, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, color: style.color, backgroundColor: style.backgroundColor, textAlign: style.textAlign, textTransform: style.textTransform, position: style.position, fontLoaded: String(fontActuallyLoaded(style)) } };
        }).filter((item) => item.rect.width > 1 && item.rect.height > 1 && item.rect.x > -item.rect.width && item.rect.x < document.documentElement.scrollWidth + item.rect.width && item.rect.y > -item.rect.height && item.rect.y < pageHeight + item.rect.height);
      })()`, true) as DomNode[]
      const liveHeight = liveCapture.documentHeight || captureViewportHeight
      const semanticAnchors = extractSemanticAnchors(design.node, domNodes, selectedFrame.width, liveHeight)
      updateProgress(80, 'Registering page sections with hybrid semantic OpenCV…')
      let enhancedVisual: any = null
      let workerProgress = 81
      const workerProgressTimer = window.setInterval(() => { workerProgress = Math.min(90, workerProgress + 1); updateProgress(workerProgress, workerProgress < 86 ? 'Registering long-page sections with OpenCV…' : 'Calculating SSIM heatmap and change contours…') }, 900)
      try {
        enhancedVisual = await withTimeout(window.electronAPI.compareVisuals(visualJobId, design.imageDataUrl, liveCapture.dataUrl, semanticAnchors, 'visual-surface'), 95_000, 'The OpenCV visual comparison exceeded 95 seconds.')
      } catch (workerError: any) {
        enhancedVisual = { success: false, error: workerError?.message || 'The OpenCV worker was unavailable.', fallback: true }
      } finally { clearInterval(workerProgressTimer) }
      const visual = enhancedVisual?.success
        ? { dataUrl: enhancedVisual.heatmapDataUrl, similarity: enhancedVisual.similarity, changedPercent: enhancedVisual.changedPercent, regions: enhancedVisual.regions || [], anchors: enhancedVisual.anchors || [], engine: enhancedVisual.engine || 'opencv-ssim' }
        : { ...(await withTimeout(createVisualDiff(design.imageDataUrl, liveCapture.dataUrl), 30_000, 'Visual difference processing exceeded 30 seconds and was stopped.')), regions: [], anchors: [], engine: 'javascript-fallback' }
      if (cancelled()) throw new Error('Comparison cancelled.')
      updateProgress(92, 'Matching Figma layers to live elements…')
      if (!cancelled()) {
        setRawDesignNode(design.node)
        setRawDomNodes(domNodes)
        setRawVisualData(visual)
        setDesignImage(design.imageDataUrl); setLiveImage(liveCapture.dataUrl); setDiffImage(visual.dataUrl); setSimilarity(visual.similarity); setChanged(visual.changedPercent); setLiveDocumentHeight(liveHeight); setVisualEngine(visual.engine); setSections(enhancedVisual?.sections || [])
        setView('diff'); setProgress({ percent: 100, detail: `Comparison complete · ${liveCapture.mode === 'atomic-cdp' ? 'atomic Chromium capture' : `${liveCapture.tiles} capture tiles`} · ${visual.engine}` }); setStatus('Comparison complete.')
        setLastCompletedRunId(runId)
      }
    } catch (cause: any) {
      if (!cancelled()) { const message = cause?.message || 'Comparison failed.'; setError(message); setStatus(message === 'Comparison cancelled.' ? 'Comparison cancelled.' : 'Comparison stopped.'); setProgress({ percent: 0, detail: '' }) }
    } finally { if (activeVisualJobRef.current === visualJobId) activeVisualJobRef.current = ''; if (!cancelled()) setBusy(false) }
  }

  const cancelComparison = () => {
    const visualJobId = activeVisualJobRef.current
    if (visualJobId) { void window.electronAPI.cancelVisualComparison(visualJobId); activeVisualJobRef.current = '' }
    comparisonRunRef.current++
    setBusy(false); setProgress({ percent: 0, detail: '' }); setStatus('Comparison cancelled.'); setError('Comparison cancelled before completion.')
  }

  const captureWidth = selectedFrame?.width || 1440
  const captureViewportHeight = 1200

  const findings = useMemo(() => {
    if (!rawDesignNode || !rawDomNodes || !selectedFrame) return []
    const liveHeight = liveDocumentHeight || captureViewportHeight
    const nextFindings = semanticFindings(rawDesignNode, rawDomNodes, selectedFrame.width, liveHeight, styleNames)
    if (rawVisualData?.regions?.length && rawVisualData?.anchors?.length) {
      const mapLiveY = (designY: number) => {
        const anchors = rawVisualData.anchors as Array<{ designY: number; liveY: number }>
        const upperIndex = anchors.findIndex((anchor) => anchor.designY >= designY)
        if (upperIndex <= 0) return anchors[0]?.liveY || designY
        const upper = anchors[upperIndex]; const lower = anchors[upperIndex - 1]
        const ratio = (designY - lower.designY) / Math.max(1, upper.designY - lower.designY)
        return lower.liveY + (upper.liveY - lower.liveY) * ratio
      }
      const meaningfulRegions = rawVisualData.regions.filter((region: any) => region.width * region.height > selectedFrame.width * selectedFrame.height * .0002).slice(0, 8)
      for (const [index, region] of meaningfulRegions.entries()) {
        const liveY = mapLiveY(region.y); const liveBottom = mapLiveY(region.y + region.height)
        const designRegion: ComparedRegion = { rect: { x: region.x, y: region.y, width: region.width, height: region.height }, pageWidth: selectedFrame.width, pageHeight: selectedFrame.height, label: `OpenCV difference region ${index + 1}` }
        const liveRegion: ComparedRegion = { rect: { x: region.x / selectedFrame.width * captureWidth, y: liveY, width: region.width / selectedFrame.width * captureWidth, height: Math.max(1, liveBottom - liveY) }, pageWidth: captureWidth, pageHeight: liveHeight, label: `Registered live region · ${region.difference}% structural difference` }
        nextFindings.push({ id: stableId('opencv-region', String(index), String(Math.round(region.y))), severity: region.difference > 55 ? 'high' : region.difference > 32 ? 'medium' : 'low', title: `Visual difference region ${index + 1}`, detail: `${region.width}×${region.height}px region · ${region.difference}% structural difference after section alignment.`, confidence: Math.min(100, Math.round(region.difference)), comparison: { design: designRegion, live: liveRegion, delta: { x: liveRegion.rect.x - designRegion.rect.x, y: liveRegion.rect.y - designRegion.rect.y, width: liveRegion.rect.width - designRegion.rect.width, height: liveRegion.rect.height - designRegion.rect.height } } })
      }
    }
    nextFindings.unshift({ id: stableId('page-height'), severity: Math.abs(selectedFrame.height - liveHeight) > 20 ? 'medium' : 'pass', title: Math.abs(selectedFrame.height - liveHeight) > 20 ? 'Full-page height differs' : 'Full-page height matches', detail: `Figma ${selectedFrame.height}px · Live ${liveHeight}px · Chromium viewport ${captureWidth}×${captureViewportHeight}`, confidence: 100, comparison: { design: { rect: { x: 0, y: 0, width: selectedFrame.width, height: selectedFrame.height }, pageWidth: selectedFrame.width, pageHeight: selectedFrame.height, label: `Figma full page · ${selectedFrame.width}×${selectedFrame.height}` }, live: { rect: { x: 0, y: 0, width: captureWidth, height: liveHeight }, pageWidth: captureWidth, pageHeight: liveHeight, label: `Live full page · ${captureWidth}×${liveHeight}` }, delta: { height: liveHeight - selectedFrame.height } } })
    const getY = (item: Finding) => {
      if (item.comparison?.live?.rect?.y !== undefined) return item.comparison.live.rect.y
      if (item.comparison?.design?.rect?.y !== undefined) return item.comparison.design.rect.y
      return 0
    }
    return nextFindings.sort((a, b) => getY(a) - getY(b))
  }, [rawDesignNode, rawDomNodes, selectedFrame, liveDocumentHeight, rawVisualData, captureWidth, captureViewportHeight, styleNames])

  // Findings the analyst already accepted or dismissed drop out of the default
  // view — otherwise every run re-surfaces the same known deltas forever.
  const triagedCount = useMemo(() => findings.filter((f) => triage[f.id]).length, [findings, triage])
  const visibleFindings = useMemo(() => showTriaged ? findings : findings.filter((f) => !triage[f.id]), [findings, triage, showTriaged])

  const isPinnable = (finding: Finding) => finding.severity !== 'pass' && !!finding.comparison?.live
  const pinFinding = (finding: Finding) => {
    if (!onCreateAnnotation || pinnedFindingIds.has(finding.id)) return
    const spec = findingToAnnotationSpec(finding, breakpoint, captureWidth, liveDocumentHeight ?? captureViewportHeight)
    if (!spec) return
    onCreateAnnotation(spec)
    setPinnedFindingIds((current) => new Set(current).add(finding.id))
  }
  // Scoped to what the analyst hasn't already triaged away — pinning something
  // just marked false-positive would contradict the triage action they just took.
  const pinnableVisibleCount = useMemo(
    () => visibleFindings.filter((f) => isPinnable(f) && !pinnedFindingIds.has(f.id)).length,
    [visibleFindings, pinnedFindingIds]
  )
  const pinVisibleFindings = () => {
    if (!onCreateAnnotation) return
    const toPin = visibleFindings.filter((f) => isPinnable(f) && !pinnedFindingIds.has(f.id))
    if (!toPin.length) return
    const pinnedIds: string[] = []
    for (const finding of toPin) {
      const spec = findingToAnnotationSpec(finding, breakpoint, captureWidth, liveDocumentHeight ?? captureViewportHeight)
      if (!spec) continue
      onCreateAnnotation(spec)
      pinnedIds.push(finding.id)
    }
    setPinnedFindingIds((current) => { const next = new Set(current); for (const id of pinnedIds) next.add(id); return next })
  }

  // Severity-weighted counts — a defect list that can be triaged, not a raster
  // similarity percentage nobody can act on.
  const severityCounts = useMemo(() => ({
    high: visibleFindings.filter((f) => f.severity === 'high').length,
    medium: visibleFindings.filter((f) => f.severity === 'medium').length,
    low: visibleFindings.filter((f) => f.severity === 'low').length,
    pass: visibleFindings.filter((f) => f.severity === 'pass').length
  }), [visibleFindings])

  const dfs = useMemo(() => {
    const pixelPenalty = similarity === null || changed === null ? 0 : Math.min(50, (changed / 100) * 50 * 2.2)
    const highPenalty = Math.min(30, severityCounts.high * 8)
    const medPenalty = Math.min(15, severityCounts.medium * 4)
    const score = Math.max(0, Math.min(100, Math.round(100 - pixelPenalty - highPenalty - medPenalty)))
    return { score, pixelPenalty: Math.round(pixelPenalty), highPenalty, medPenalty }
  }, [similarity, changed, severityCounts])

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
      conformanceScore: dfs.score,
      findingsCount: findings.length
    }
    window.electronAPI.saveAutomateRun(projectId, summary)
      .then(() => window.electronAPI.getAutomateRuns(projectId, selectedFrame.id))
      .then(setRunHistory)
      .catch(() => { })
    // Deliberately keyed only on lastCompletedRunId — see comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastCompletedRunId])

  const [findingsFilter, setFindingsFilter] = useState<'all' | 'tokens' | 'layout' | 'content' | 'pass'>('all')

  const isLayoutFinding = (f: Finding) => f.title.includes('Position') || f.title.includes('height') || f.title.includes('Visual difference') || f.title.includes('Section growth') || f.title.includes('Container is shifted') || f.title.includes('Spacing mismatch')
  const countTokens = useMemo(() => visibleFindings.filter((f) => f.title.startsWith('CSS Token') || f.title.includes('Font-')).length, [visibleFindings])
  const countLayout = useMemo(() => visibleFindings.filter(isLayoutFinding).length, [visibleFindings])
  const countContent = useMemo(() => visibleFindings.filter((f) => f.title.includes('Missing design text') || f.title.includes('Image count')).length, [visibleFindings])
  const countPass = useMemo(() => visibleFindings.filter((f) => f.severity === 'pass').length, [visibleFindings])

  const filteredFindings = useMemo(() => {
    if (findingsFilter === 'tokens') return visibleFindings.filter((f) => f.title.startsWith('CSS Token') || f.title.includes('Font-'))
    if (findingsFilter === 'layout') return visibleFindings.filter(isLayoutFinding)
    if (findingsFilter === 'content') return visibleFindings.filter((f) => f.title.includes('Missing design text') || f.title.includes('Image count'))
    if (findingsFilter === 'pass') return visibleFindings.filter((f) => f.severity === 'pass')
    return visibleFindings
  }, [visibleFindings, findingsFilter])

  return <div className="automate-workspace">
    <webview ref={webviewRef} className="automate-capture-webview" src={sourceUrl} webpreferences="backgroundThrottling=no" style={{ width: captureWidth, height: captureViewportHeight }} />
    <div className="automate-capture-shield" aria-hidden="true" />
    <header className="automate-header">
      <div><span className="automate-kicker">Visual regression + semantic layout</span><h2>Automate</h2><p>{status}</p></div>
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
          <label><span>Figma design</span><input value={designUrl} onChange={(event) => setDesignUrl(event.target.value)} placeholder="https://www.figma.com/design/…?node-id=…" /></label>
          <button className="automate-secondary" disabled={busy || !designUrl.trim()} onClick={loadFrames}>Load frames</button>
          <label className="automate-frame-select"><span>Frame</span><select value={frameId} onChange={(event) => setFrameId(event.target.value)} disabled={!frames.length}><option value="">Select a frame</option>{frames.map((frame) => <option key={frame.id} value={frame.id}>{frame.pageName}{frame.path ? ` / ${frame.path}` : ''} / {frame.name} · {frame.width}×{frame.height}</option>)}</select></label>
          <label className="automate-breakpoint-select" title="Tags this run in history — guessed from the frame's width, override if it's wrong"><span>Breakpoint</span><select value={breakpoint} onChange={(event) => setBreakpoint(event.target.value as typeof breakpoint)}><option value="Desktop">Desktop</option><option value="Tablet">Tablet</option><option value="Mobile">Mobile</option></select></label>
          {busy ? <button className="automate-secondary automate-cancel" onClick={cancelComparison}>Cancel</button> : <button className="automate-primary" disabled={!selectedFrame} onClick={runComparison} title={ready ? 'Run visual and semantic comparison' : 'The staging page will be checked before comparison starts'}>Run comparison</button>}
          <button className="automate-icon-btn" title="Replace Figma API token" onClick={async () => { await window.electronAPI.setFigmaToken(''); setTokenConfigured(false) }}><svg viewBox="0 0 24 24"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5v.2h-4v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1-2.8-2.8.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3v-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1 2.8-2.8.1.1a1.7 1.7 0 0 0 1.8.3 1.7 1.7 0 0 0 1-1.5V3h4v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1 2.8 2.8-.1.1a1.7 1.7 0 0 0-.3 1.8 1.7 1.7 0 0 0 1.5 1h.2v4h-.2a1.7 1.7 0 0 0-1.4 1Z" /></svg></button>
        </section>

        {busy && <section className="automate-progress" aria-live="polite"><div><span>{progress.detail || 'Comparing…'}</span><strong>{progress.percent}%</strong></div><i><b style={{ width: `${progress.percent}%` }} /></i></section>}
        {error && <div className="automate-error">{error}</div>}
        {similarity === null ? <section className="automate-empty"><div className="automate-empty-grid"><span /><span /><span /><span /></div><h3>{frames.length ? 'Ready to compare' : 'Choose a Figma file and frame'}</h3><p>{selectedFrame ? `Design frame: ${selectedFrame.width}×${selectedFrame.height} full page · Chromium viewport: ${captureWidth}×${captureViewportHeight} · Live page height will be detected and stitched automatically.` : 'The matcher does not require Figma layer names to match WordPress or Elementor classes.'}</p>{fileName && <small>{fileName}</small>}</section> : <div className="automate-results">
          <div className="automate-score-row">
            <div><strong>{severityCounts.high}</strong><span>Blocking</span></div>
            <div><strong>{severityCounts.medium}</strong><span>Warning</span></div>
            <div><strong>{severityCounts.low}</strong><span>Minor</span></div>
            <div><strong>{severityCounts.pass}</strong><span>Verified</span></div>
            <div><strong>{dfs?.score ?? '—'}</strong><span>Conformance</span></div>
          </div>
          <div className="automate-result-grid">
            <section className="automate-visual-card">
              <div className="automate-card-head">
                <div>
                  <h3>{selectedFindingIndex === null ? 'Visual comparison' : 'Finding evidence'}</h3>
                  <span>Figma {selectedFrame?.width}×{selectedFrame?.height} · Live {captureWidth}×{liveDocumentHeight || '—'} · viewport {captureWidth}×{captureViewportHeight}</span>
                </div>
                <div className="automate-view-switch">
                  <button className={selectedFindingIndex === null && view === 'diff' ? 'active' : ''} onClick={() => { setSelectedFindingIndex(null); setView('diff') }}>Diff</button>
                  <button className={selectedFindingIndex === null && view === 'design' ? 'active' : ''} onClick={() => { setSelectedFindingIndex(null); setView('design') }}>Figma</button>
                  <button className={selectedFindingIndex === null && view === 'live' ? 'active' : ''} onClick={() => { setSelectedFindingIndex(null); setView('live') }}>Live</button>
                </div>
              </div>
              {selectedFindingIndex !== null && findings[selectedFindingIndex]?.comparison ? (
                <FindingComparisonView
                  finding={findings[selectedFindingIndex]}
                  designImage={designImage}
                  liveImage={liveImage}
                  onClose={() => setSelectedFindingIndex(null)}
                />
              ) : (
                <div className="automate-image-stage"><img src={view === 'diff' ? diffImage : view === 'design' ? designImage : liveImage} alt={`${view} comparison`} /></div>
              )}
            </section>
            <section className="automate-findings">
              <div className="automate-card-head">
                <div><h3>Findings ({filteredFindings.length})</h3><span>Click a finding to inspect its visual evidence</span></div>
                <div className="automate-card-head-actions">
                  {onCreateAnnotation && pinnableVisibleCount > 0 && (
                    <button type="button" className="automate-pin-all-btn" onClick={pinVisibleFindings} title="Pin every untriaged finding below as a page annotation">
                      Send {pinnableVisibleCount} to annotations
                    </button>
                  )}
                  {triagedCount > 0 && (
                    <label className="automate-triage-toggle">
                      <input type="checkbox" checked={showTriaged} onChange={(e) => setShowTriaged(e.target.checked)} />
                      Show triaged ({triagedCount})
                    </label>
                  )}
                </div>
              </div>
              <div className="automate-findings-tabs">
                <button className={findingsFilter === 'all' ? 'active' : ''} onClick={() => setFindingsFilter('all')}>All ({visibleFindings.length})</button>
                <button className={findingsFilter === 'tokens' ? 'active' : ''} onClick={() => setFindingsFilter('tokens')}>Tokens ({countTokens})</button>
                <button className={findingsFilter === 'layout' ? 'active' : ''} onClick={() => setFindingsFilter('layout')}>Layout ({countLayout})</button>
                <button className={findingsFilter === 'content' ? 'active' : ''} onClick={() => setFindingsFilter('content')}>Missing ({countContent})</button>
                <button className={findingsFilter === 'pass' ? 'active' : ''} onClick={() => setFindingsFilter('pass')}>Verified ({countPass})</button>
              </div>
              <div className="automate-findings-list">
                {filteredFindings.map((finding) => {
                  const realIndex = findings.indexOf(finding)
                  return (
                    <button
                      type="button"
                      key={finding.id}
                      className={`severity-${finding.severity}${selectedFindingIndex === realIndex ? ' selected' : ''}`}
                      onClick={() => finding.comparison && setSelectedFindingIndex(realIndex)}
                      aria-pressed={selectedFindingIndex === realIndex}
                      disabled={!finding.comparison}
                    >
                      <i />
                      <div>
                        <h4>{finding.title}</h4>
                        <p>{finding.detail}</p>
                        {finding.tokens && finding.tokens.length > 0 && (() => {
                          const coreTokens = finding.tokens.filter((t) => !t.isExtended)
                          const extTokens = finding.tokens.filter((t) => t.isExtended)
                          const isExpanded = !!expandedTokensMap[realIndex]
                          return (
                            <div className="automate-token-pill-group">
                              {coreTokens.map((t) => (
                                <TokenIconBadge key={t.name} token={t} />
                              ))}
                              {extTokens.length > 0 && isExpanded && extTokens.map((t) => (
                                <TokenIconBadge key={t.name} token={t} />
                              ))}
                              {extTokens.length > 0 && (
                                <button
                                  type="button"
                                  className="automate-more-tokens-btn"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setExpandedTokensMap((prev) => ({ ...prev, [realIndex]: !prev[realIndex] }))
                                  }}
                                >
                                  {isExpanded ? '...less' : `...more (${extTokens.length})`}
                                </button>
                              )}
                            </div>
                          )
                        })()}
                        {finding.severity !== 'pass' && (
                          <div className="automate-triage-row">
                            {triage[finding.id] ? (
                              <>
                                <span className={`automate-triage-badge ${triage[finding.id].state}`}>
                                  {triage[finding.id].state === 'accepted' ? 'Accepted' : triage[finding.id].state === 'false-positive' ? 'False positive' : 'Ignored'}
                                </span>
                                <button type="button" onClick={(e) => { e.stopPropagation(); applyTriage(finding.id, null) }}>Reset</button>
                              </>
                            ) : (
                              <>
                                <button type="button" onClick={(e) => { e.stopPropagation(); applyTriage(finding.id, 'accepted') }} title="Mark as an expected, known-acceptable difference">Accept as baseline</button>
                                <button type="button" onClick={(e) => { e.stopPropagation(); applyTriage(finding.id, 'false-positive') }} title="The matcher got this one wrong">False positive</button>
                              </>
                            )}
                            {onCreateAnnotation && isPinnable(finding) && (
                              pinnedFindingIds.has(finding.id) ? (
                                <span className="automate-pinned-badge" title="Already pinned as a page annotation">Pinned ✓</span>
                              ) : (
                                <button type="button" className="automate-pin-finding-btn" onClick={(e) => { e.stopPropagation(); pinFinding(finding) }} title="Pin at this position as a page annotation">Pin</button>
                              )
                            )}
                          </div>
                        )}
                      </div>
                      <small>{finding.confidence}%</small>
                    </button>
                  )
                })}
              </div>
            </section>
          </div>
          {sections.length > 0 && (
            <section className="automate-sections-panel">
              <div className="automate-card-head">
                <div>
                  <h3>Page sections ({sections.length})</h3>
                  <span>Per-section SSIM — boundaries auto-detected from edge density and color transitions</span>
                </div>
              </div>
              <div className="automate-sections-list">
                {sections.map((section) => (
                  <div key={section.name} className="automate-section-row">
                    <span className="automate-section-name">{section.name}</span>
                    <div className="automate-section-bar-track">
                      <div
                        className="automate-section-bar-fill"
                        style={{
                          width: `${section.similarity}%`,
                          background: section.similarity >= 95 ? '#34d399' : section.similarity >= 80 ? '#f59e0b' : '#ef4444',
                        }}
                      />
                    </div>
                    <span className="automate-section-score">{section.similarity.toFixed(1)}%</span>
                    <span className="automate-section-meta">design {section.designY}–{section.designY + section.designHeight}px</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>}
      </>)}
    {runHistory.length > 0 && (() => {
      const sameBreakpoint = runHistory.filter((r) => r.breakpoint === breakpoint).sort((a, b) => b.at - a.at)
      const delta = sameBreakpoint.length >= 2 ? sameBreakpoint[0].conformanceScore - sameBreakpoint[1].conformanceScore : null
      return (
        <section className="automate-history-panel">
          <div className="automate-card-head">
            <div>
              <h3>Run history · {breakpoint}</h3>
              <span>{runHistory.length} run{runHistory.length === 1 ? '' : 's'} recorded for this frame across breakpoints</span>
            </div>
            {delta !== null && (
              <span className={`automate-trend ${delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'}`}>
                {delta > 0 ? '▲' : delta < 0 ? '▼' : '—'} {delta > 0 ? '+' : ''}{delta} vs last {breakpoint} run
              </span>
            )}
          </div>
          <div className="automate-history-body">
            <ConformanceSparkline runs={sameBreakpoint} />
            <div className="automate-history-list">
              {runHistory.slice(0, 6).map((run) => (
                <div key={run.id} className="automate-history-row">
                  <span className="automate-history-bp">{run.breakpoint}</span>
                  <span className="automate-history-date">{new Date(run.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                  <span className="automate-history-score">{run.conformanceScore}</span>
                  <span className="automate-history-counts">{run.severityCounts.high}H · {run.severityCounts.medium}M · {run.severityCounts.low}L</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )
    })()}
  </div>
}
