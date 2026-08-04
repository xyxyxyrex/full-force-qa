import { useEffect, useMemo, useRef, useState } from 'react'
import './AutomateWorkspace.css'

interface FrameSummary { id: string; name: string; type: string; pageName: string; width: number; height: number }
interface DomNode { tag: string; role: string; text: string; src: string; context: string; path: string; rect: { x: number; y: number; width: number; height: number }; styles: Record<string, string> }
interface ComparedRegion { rect: { x: number; y: number; width: number; height: number }; pageWidth: number; pageHeight: number; label: string }
interface TokenAssertion { name: string; passed: boolean; figma: string; css: string; isExtended?: boolean }
interface FindingComparison { design?: ComparedRegion; live?: ComparedRegion; delta?: { x?: number; y?: number; width?: number; height?: number; fontSize?: number } }
interface Finding { severity: 'high' | 'medium' | 'low' | 'pass'; title: string; detail: string; confidence: number; comparison?: FindingComparison; tokens?: TokenAssertion[] }

interface Props {
  sourceUrl: string
  figmaUrl?: string
  projectId: string
  onOpenSettings?: () => void
}

const normalizeText = (value = '') => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const textTokens = (value: string) => new Set(normalizeText(value).split(' ').filter(Boolean))
const tokenScore = (left: string, right: string) => {
  const a = normalizeText(left); const b = normalizeText(right)
  if (!a || !b) return 0
  if (a === b) return 1
  const minLen = Math.min(a.length, b.length); const maxLen = Math.max(a.length, b.length)
  if (minLen >= 12 && (a.includes(b) || b.includes(a) || (a.length >= 20 && b.includes(a.slice(0, 25))) || (b.length >= 20 && a.includes(b.slice(0, 25))))) {
    return Math.max(0.85, (minLen / maxLen) * 0.95)
  }
  const aa = textTokens(a); const bb = textTokens(b)
  if (!aa.size || !bb.size) return 0
  let common = 0
  aa.forEach((token) => { if (bb.has(token)) common++ })
  const jaccard = common / Math.max(aa.size, bb.size)
  const minSize = Math.min(aa.size, bb.size)
  const containment = minSize >= 3 ? (common / minSize) * 0.90 : jaccard
  return Math.max(jaccard, containment)
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
  const metrics = await withTimeout(view.executeJavaScript(`(() => {
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
    window.__qaAutomateCapture = { x: scrollX, y: scrollY, scroller, scrollTop: scroller.scrollTop, scrollBehavior: scroller.style.scrollBehavior, scrollSnapType: scroller.style.scrollSnapType, overflowAnchor: scroller.style.overflowAnchor, positioned: [] };
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
  })()`, true), 15000, 'Timed out while measuring the live page.') as { height: number; width: number; clientHeight: number; scrollRange: number; innerHeight: number; scrollerTag: string; scrollerId: string }
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
      await view.executeJavaScript(`(() => { const capture = window.__qaAutomateCapture; for (const item of capture?.positioned || []) item.element.style.visibility = item.visibility; if (capture) { const scroller = capture.scroller || document.scrollingElement || document.documentElement; window.__qaAutomateSemanticScroller = scroller; scroller.style.scrollBehavior = capture.scrollBehavior; scroller.style.scrollSnapType = capture.scrollSnapType; scroller.style.overflowAnchor = capture.overflowAnchor; scroller.scrollTop = capture.scrollTop; if (scroller === document.scrollingElement) scrollTo(capture.x, capture.y); } delete window.__qaAutomateCapture; })()`, true)
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

function semanticFindings(figmaRoot: any, domNodes: DomNode[], liveWidth: number, liveHeight: number, mode: 'visual-surface' | 'token-auditor' = 'visual-surface'): Finding[] {
  const root = figmaRoot?.absoluteBoundingBox || { x: 0, y: 0, width: liveWidth, height: liveHeight }
  const figmaText: any[] = []; const figmaImages: any[] = []
  const walk = (node: any, ancestors: any[] = []) => {
    if (node.visible !== false && node.absoluteBoundingBox) {
      if (node.type === 'TEXT' && normalizeText(node.characters || '')) {
        figmaText.push({ ...node, __context: ancestors.slice(-5).map((item) => item?.name || '').filter(Boolean).join(' ') })
      }
      if (Array.isArray(node.fills) && node.fills.some((fill: any) => fill?.type === 'IMAGE')) figmaImages.push(node)
    }
    for (const child of node.children || []) walk(child, [...ancestors, node])
  }
  walk(figmaRoot)
  const textTags = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'button', 'label', 'li', 'span', 'div', 'dt', 'dd', 'summary', 'figcaption', 'th', 'td'])
  const candidates = domNodes.filter((node) => node.text && textTags.has(node.tag))
  const used = new Set<number>(); const findings: Finding[] = []
  const orderedDesignText = figmaText.slice(0, 240).sort((left, right) => {
    const a = normalizeText(left.characters); const b = normalizeText(right.characters)
    const aExact = candidates.filter((candidate) => normalizeText(candidate.text) === a).length
    const bExact = candidates.filter((candidate) => normalizeText(candidate.text) === b).length
    if (!!aExact !== !!bExact) return aExact ? -1 : 1
    return b.length - a.length
  })
  for (const design of orderedDesignText) {
    let best: { index: number; score: number; geometry: number; text: number } | null = null
    const designText = normalizeText(design.characters)
    const hasExactCandidate = candidates.some((candidate, index) => !used.has(index) && normalizeText(candidate.text) === designText)
    for (let index = 0; index < candidates.length; index++) {
      if (used.has(index)) continue
      const candidate = candidates[index]
      const candidateText = normalizeText(candidate.text)
      const exact = designText === candidateText
      if (hasExactCandidate && !exact) continue
      const text = tokenScore(design.characters, candidate.text)
      if ((!exact && text < .45) || (!exact && Math.min(designText.length, candidateText.length) < 5)) continue
      const box = design.absoluteBoundingBox
      const dx = Math.abs((box.x - root.x) / root.width - candidate.rect.x / liveWidth)
      const dy = Math.abs((box.y - root.y) / root.height - candidate.rect.y / liveHeight)
      const normalizedDistance = Math.hypot(dx, dy)
      if (!exact && text < .50 && normalizedDistance > .45) continue
      const geometry = Math.max(0, 1 - normalizedDistance * 2.0)
      const context = tokenScore(design.__context || '', `${candidate.context} ${candidate.path}`)
      const expectedFont = Number(design.style?.fontSize || 0)
      const headingAffinity = expectedFont >= 20 ? (/^h[1-6]$/.test(candidate.tag) ? .06 : -.08) : 0
      const score = text * .68 + geometry * .23 + context * .09 + headingAffinity
      if (!best || score > best.score) best = { index, score, geometry, text }
    }
    const label = String(design.characters).trim().replace(/\s+/g, ' ').slice(0, 72)
    const designRect = { x: design.absoluteBoundingBox.x - root.x, y: design.absoluteBoundingBox.y - root.y, width: design.absoluteBoundingBox.width, height: design.absoluteBoundingBox.height }
    const designContext = String(design.__context || '').trim().replace(/\s+/g, ' ').slice(0, 72)
    const designRegion: ComparedRegion = { rect: designRect, pageWidth: root.width, pageHeight: root.height, label: `TEXT · ${label}${designContext ? ` · ${designContext}` : ''}` }
    if (!best || best.score < .48) {
      findings.push({ severity: 'high', title: `Missing design text: “${label}”`, detail: 'No sufficiently similar visible DOM element was found.', confidence: Math.round((1 - (best?.score || 0)) * 100), comparison: { design: designRegion } })
      continue
    }
    used.add(best.index)
    const live = candidates[best.index]; const box = design.absoluteBoundingBox
    const expectedX = (box.x - root.x) / root.width * liveWidth
    const expectedY = (box.y - root.y) / root.height * liveHeight

    const designCenterX = expectedX + (box.width / root.width * liveWidth) / 2
    const liveCenterX = live.rect.x + live.rect.width / 2
    const dxLeft = Math.abs(expectedX - live.rect.x)
    const dxCenter = Math.abs(designCenterX - liveCenterX)
    const dxEffective = Math.min(dxLeft, dxCenter)
    const dyEffective = Math.abs(expectedY - live.rect.y)

    const figmaFullText = String(design.characters || '').trim()
    const figmaParagraphs = figmaFullText.split(/\n\s*\n/).filter(Boolean)
    let adjustedDesignRect = { ...designRect }
    if (figmaParagraphs.length > 1 && live.text) {
      const matchedIndex = figmaParagraphs.findIndex((p) => tokenScore(p, live.text) >= 0.50)
      const idx = matchedIndex >= 0 ? matchedIndex : 0
      const targetP = figmaParagraphs[idx]
      const pRatio = Math.min(1, targetP.length / Math.max(1, figmaFullText.length))
      const targetHeight = Math.max(20, Math.round(designRect.height * pRatio))
      const yOffset = (designRect.height / figmaParagraphs.length) * idx
      adjustedDesignRect = {
        ...designRect,
        y: Math.round(designRect.y + yOffset),
        height: targetHeight
      }
    }

    const expectedFont = Number(design.style?.fontSize || 0); const actualFont = parseFloat(live.styles.fontSize || '0')
    const matchedDesignRegion: ComparedRegion = { rect: adjustedDesignRect, pageWidth: root.width, pageHeight: root.height, label: `TEXT · ${label}${designContext ? ` · ${designContext}` : ''}` }
    const liveRegion: ComparedRegion = { rect: live.rect, pageWidth: liveWidth, pageHeight: liveHeight, label: `<${live.tag}> · ${live.text.slice(0, 54)}${live.context ? ` · ${live.context.slice(0, 42)}` : ''}` }
    const comparison: FindingComparison = { design: matchedDesignRegion, live: liveRegion, delta: { x: dxEffective < dxLeft ? liveCenterX - designCenterX : live.rect.x - expectedX, y: live.rect.y - expectedY, width: live.rect.width - adjustedDesignRect.width / root.width * liveWidth, height: live.rect.height - adjustedDesignRect.height / root.height * liveHeight } }

    if (mode === 'token-auditor') {
      const tokenList: TokenAssertion[] = []
      if (expectedFont && actualFont) {
        const passed = Math.abs(expectedFont - actualFont) <= 1.0
        tokenList.push({ name: 'font-size', passed, figma: `${expectedFont}px`, css: `${Math.round(actualFont * 10) / 10}px` })
      }
      const expectedWeight = Number(design.style?.fontWeight || 400); const actualWeight = Number(live.styles.fontWeight || 400)
      if (expectedWeight && actualWeight) {
        const passed = Math.abs(expectedWeight - actualWeight) < 100
        tokenList.push({ name: 'font-weight', passed, figma: `${expectedWeight}`, css: `${actualWeight}` })
      }
      const expectedLineHeight = Math.round(Number(design.style?.lineHeightPx || 0))
      const actualLineHeight = Math.round(parseFloat(live.styles.lineHeight || '0'))
      if (expectedLineHeight > 0 && actualLineHeight > 0) {
        const passed = Math.abs(expectedLineHeight - actualLineHeight) <= 2.5
        tokenList.push({ name: 'line-height', passed, figma: `${expectedLineHeight}px`, css: `${actualLineHeight}px` })
      }
      const expectedLetterSpacing = Number(design.style?.letterSpacing || 0)
      const rawCssLs = live.styles.letterSpacing || '0'
      const actualLetterSpacing = (rawCssLs === 'normal' || !rawCssLs) ? 0 : (parseFloat(rawCssLs) || 0)
      if (!isNaN(actualLetterSpacing)) {
        const passed = Math.abs(expectedLetterSpacing - actualLetterSpacing) <= 0.5
        tokenList.push({ name: 'letter-spacing', passed, figma: `${Math.round(expectedLetterSpacing * 10) / 10}px`, css: `${Math.round(actualLetterSpacing * 10) / 10}px` })
      }
      const expectedFamily = String(design.style?.fontFamily || '').trim()
      const actualFamily = String(live.styles.fontFamily || '').trim()
      if (expectedFamily && actualFamily) {
        const passed = actualFamily.toLowerCase().includes(expectedFamily.toLowerCase())
        tokenList.push({ name: 'font-family', passed, figma: expectedFamily, css: actualFamily.split(',')[0].replace(/["']/g, '') })
      }
      const figmaHex = figmaColorToHex(design.fills)
      const cssHex = parseCssColorToHex(live.styles.color)
      if (figmaHex && cssHex) {
        const passed = figmaHex === cssHex
        tokenList.push({ name: 'color', passed, figma: figmaHex, css: cssHex })
      }

      // Extended UI Properties (only revealed via [...more] button if inconsistent)
      const figmaAlign = String(design.style?.textAlignHorizontal || '').toLowerCase()
      const liveAlign = String(live.styles.textAlign || '').toLowerCase()
      if (figmaAlign && liveAlign && figmaAlign !== 'left') {
        const passed = liveAlign.includes(figmaAlign) || (figmaAlign === 'justified' && liveAlign === 'justify')
        if (!passed) {
          tokenList.push({ name: 'text-align', passed: false, figma: figmaAlign, css: liveAlign, isExtended: true })
        }
      }
      const figmaBgHex = figmaColorToHex(design.fills)
      const liveBgHex = parseCssColorToHex(live.styles.backgroundColor)
      if (figmaBgHex && liveBgHex && liveBgHex !== 'transparent' && liveBgHex !== '#00000000' && liveBgHex !== '#000000') {
        const passed = figmaBgHex === liveBgHex
        if (!passed) {
          tokenList.push({ name: 'bg-color', passed: false, figma: figmaBgHex, css: liveBgHex, isExtended: true })
        }
      }
      if (design.cornerRadius && live.styles.borderRadius) {
        const expectedRadius = Number(design.cornerRadius || 0)
        const actualRadius = parseFloat(live.styles.borderRadius || '0')
        if (expectedRadius > 0 && Math.abs(expectedRadius - actualRadius) > 2) {
          tokenList.push({ name: 'border-radius', passed: false, figma: `${expectedRadius}px`, css: `${actualRadius}px`, isExtended: true })
        }
      }

      if (tokenList.length > 0) {
        const fails = tokenList.filter((t) => !t.passed)
        const passes = tokenList.filter((t) => t.passed)
        const isPass = fails.length === 0
        const title = isPass ? `CSS Tokens Verified: “${label}”` : `CSS Token Mismatch: “${label}”`
        const detail = isPass
          ? `${passes.length} typography tokens verified against Figma spec`
          : `Mismatch on ${fails.map((f) => `${f.name} (Figma ${f.figma} vs CSS ${f.css})`).join(', ')}`

        findings.push({
          severity: isPass ? 'pass' : fails.some((f) => f.name === 'font-size') ? 'high' : 'medium',
          title,
          detail,
          confidence: isPass ? 98 : 92,
          tokens: tokenList,
          comparison
        })
      }
    } else {
      if (dyEffective > 28 || dxEffective > 45) {
        findings.push({ severity: (dyEffective > 60 || dxEffective > 100) ? 'high' : 'medium', title: `Position mismatch: “${label}”`, detail: `Matched <${live.tag}> is displaced from expected position (ΔY ${Math.round(dyEffective)}px, ΔX ${Math.round(dxEffective)}px).`, confidence: Math.round(best.score * 100), comparison })
      } else if (dyEffective <= 15 && dxEffective <= 20 && best.score >= 0.70) {
        findings.push({ severity: 'pass', title: `Spec Verified: Position & Content “${label}”`, detail: `Matched <${live.tag}> at expected location (ΔY ${Math.round(dyEffective)}px, ΔX ${Math.round(dxEffective)}px)`, confidence: Math.round(best.score * 100), comparison })
      }
      if (expectedFont && actualFont && Math.abs(expectedFont - actualFont) > 1.5) {
        findings.push({ severity: Math.abs(expectedFont - actualFont) > 4 ? 'medium' : 'low', title: `Font-size mismatch: “${label}”`, detail: `Figma ${expectedFont}px · Live ${Math.round(actualFont * 10) / 10}px`, confidence: Math.round(best.score * 100), comparison: { ...comparison, delta: { ...comparison.delta, fontSize: actualFont - expectedFont } } })
      }
    }
  }
  const liveImages = domNodes.filter((node) => node.tag === 'img')
  if (figmaImages.length !== liveImages.length) findings.push({ severity: 'medium', title: 'Image count differs', detail: `Figma contains ${figmaImages.length} image layers; the live page contains ${liveImages.length} visible images.`, confidence: 72, comparison: { design: { rect: { x: 0, y: 0, width: root.width, height: root.height }, pageWidth: root.width, pageHeight: root.height, label: `${figmaImages.length} Figma image layers` }, live: { rect: { x: 0, y: 0, width: liveWidth, height: liveHeight }, pageWidth: liveWidth, pageHeight: liveHeight, label: `${liveImages.length} live images` } } })
  if (!findings.length) findings.push({ severity: 'pass', title: 'No material semantic mismatches detected', detail: `${figmaText.length} text layers and ${figmaImages.length} image layers were evaluated.`, confidence: 92 })
  const rank = { high: 0, medium: 1, low: 2, pass: 3 }
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity])
}

function extractSemanticAnchors(figmaRoot: any, domNodes: DomNode[], liveWidth: number, liveHeight: number): Array<{ designY: number; liveY: number; confidence: number }> {
  const root = figmaRoot?.absoluteBoundingBox || { x: 0, y: 0, width: liveWidth, height: liveHeight }
  const figmaText: any[] = []
  const walk = (node: any) => {
    if (node.visible !== false && node.absoluteBoundingBox) {
      if (node.type === 'TEXT' && normalizeText(node.characters || '')) {
        figmaText.push(node)
      }
    }
    for (const child of node.children || []) walk(child)
  }
  walk(figmaRoot)

  const textTags = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'button', 'label', 'li', 'span', 'dt', 'dd', 'summary'])
  const candidates = domNodes.filter((node) => node.text && textTags.has(node.tag))
  const anchors: Array<{ designY: number; liveY: number; confidence: number }> = []
  const used = new Set<number>()

  for (const design of figmaText) {
    const designText = normalizeText(design.characters)
    if (designText.length < 5) continue

    let bestIdx = -1
    let bestScore = 0

    for (let index = 0; index < candidates.length; index++) {
      if (used.has(index)) continue
      const candidate = candidates[index]
      const candidateText = normalizeText(candidate.text)

      let score = 0
      if (designText === candidateText) {
        score = 1.0
      } else {
        const tScore = tokenScore(design.characters, candidate.text)
        if (tScore > 0.85 && Math.min(designText.length, candidateText.length) >= 10) {
          score = tScore
        }
      }

      if (score > bestScore) {
        bestScore = score
        bestIdx = index
      }
    }

    if (bestIdx >= 0 && bestScore >= 0.85) {
      used.add(bestIdx)
      const live = candidates[bestIdx]
      const designY = design.absoluteBoundingBox.y - root.y
      anchors.push({ designY, liveY: live.rect.y, confidence: bestScore })
    }
  }

  return anchors.sort((a, b) => a.designY - b.designY)
}

function figmaColorToHex(fills: any[]): string | null {
  if (!Array.isArray(fills)) return null
  const solid = fills.find((f) => f.visible !== false && f.type === 'SOLID' && f.color)
  if (!solid) return null
  const r = Math.round((solid.color.r || 0) * 255)
  const g = Math.round((solid.color.g || 0) * 255)
  const b = Math.round((solid.color.b || 0) * 255)
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`.toLowerCase()
}

function parseCssColorToHex(cssColor: string): string | null {
  if (!cssColor) return null
  if (cssColor.startsWith('#')) return cssColor.toLowerCase()
  const match = cssColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  if (match) {
    const r = parseInt(match[1], 10)
    const g = parseInt(match[2], 10)
    const b = parseInt(match[3], 10)
    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`.toLowerCase()
  }
  return null
}

function TokenIconBadge({ token }: { token: { name: string; passed: boolean; figma: string; css: string } }) {
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
      default:
        return (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="4" />
          </svg>
        )
    }
  }

  const shortName = token.name.replace('font-', '').replace('letter-', '').replace('line-', '')

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

export default function AutomateWorkspace({ sourceUrl, figmaUrl = '', projectId, onOpenSettings }: Props) {
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
  const [progress, setProgress] = useState({ percent: 0, detail: '' })
  const [liveDocumentHeight, setLiveDocumentHeight] = useState<number | null>(null)
  const [selectedFindingIndex, setSelectedFindingIndex] = useState<number | null>(null)
  const [visualEngine, setVisualEngine] = useState('')
  const [rawDesignNode, setRawDesignNode] = useState<any>(null)
  const [rawDomNodes, setRawDomNodes] = useState<DomNode[] | null>(null)
  const [rawVisualData, setRawVisualData] = useState<any>(null)
  const selectedFrame = useMemo(() => frames.find((frame) => frame.id === frameId), [frameId, frames])

  useEffect(() => { window.electronAPI.figmaTokenStatus().then((result) => setTokenConfigured(result.configured)).catch(() => { }) }, [])
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
    setBusy(true); setError(''); setStatus('Preparing comparison…'); setProgress({ percent: 4, detail: 'Preparing comparison…' }); setSelectedFindingIndex(null); setVisualEngine('')
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
        return Array.from(document.querySelectorAll(selectors)).map((element) => {
          const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
          const positioned = style.position === 'fixed' || style.position === 'sticky';
          const insideNestedScroller = scroller !== documentScroller && scroller.contains(element);
          const pageX = positioned ? rect.left : insideNestedScroller ? rect.left - scrollerRect.left + scroller.scrollLeft : rect.left + scrollX;
          const pageY = positioned ? rect.top : insideNestedScroller ? rect.top - scrollerRect.top + scroller.scrollTop : rect.top + scrollY;
          return { tag: element.tagName.toLowerCase(), role: element.getAttribute('role') || '', text: elementText(element).slice(0, 500), src: element.tagName === 'IMG' ? element.currentSrc || element.src : '', context: contextFor(element), path: pathFor(element), rect: { x: pageX, y: pageY, width: rect.width, height: rect.height }, styles: { fontSize: style.fontSize, fontFamily: style.fontFamily, fontWeight: style.fontWeight, color: style.color, backgroundColor: style.backgroundColor, textAlign: style.textAlign, position: style.position } };
        }).filter((item) => item.rect.width > 1 && item.rect.height > 1 && item.rect.x > -item.rect.width && item.rect.x < document.documentElement.scrollWidth + item.rect.width && item.rect.y > -item.rect.height && item.rect.y < pageHeight + item.rect.height);
      })()`, true) as DomNode[]
      const liveHeight = liveCapture.documentHeight || captureViewportHeight
      const semanticAnchors = extractSemanticAnchors(design.node, domNodes, selectedFrame.width, liveHeight)
      updateProgress(80, 'Registering page sections with hybrid semantic OpenCV…')
      let enhancedVisual: any = null
      let workerProgress = 81
      const workerProgressTimer = window.setInterval(() => { workerProgress = Math.min(90, workerProgress + 1); updateProgress(workerProgress, workerProgress < 86 ? 'Registering long-page sections with OpenCV…' : 'Calculating SSIM heatmap and change contours…') }, 900)
      try {
        enhancedVisual = await withTimeout(window.electronAPI.compareVisuals(visualJobId, design.imageDataUrl, liveCapture.dataUrl, semanticAnchors, activeEngineMode), 95_000, 'The OpenCV visual comparison exceeded 95 seconds.')
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
        setDesignImage(design.imageDataUrl); setLiveImage(liveCapture.dataUrl); setDiffImage(visual.dataUrl); setSimilarity(visual.similarity); setChanged(visual.changedPercent); setLiveDocumentHeight(liveHeight); setVisualEngine(visual.engine)
        setView('diff'); setProgress({ percent: 100, detail: `Comparison complete · ${liveCapture.mode === 'atomic-cdp' ? 'atomic Chromium capture' : `${liveCapture.tiles} capture tiles`} · ${visual.engine}` }); setStatus('Comparison complete.')
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

  const [activeEngineMode, setActiveEngineMode] = useState<'visual-surface' | 'token-auditor'>('visual-surface')
  const [useExperimentalUiMatch, setUseExperimentalUiMatch] = useState(false)
  const captureWidth = selectedFrame?.width || 1440
  const captureViewportHeight = 1200

  const findings = useMemo(() => {
    if (!rawDesignNode || !rawDomNodes || !selectedFrame) return []
    const liveHeight = liveDocumentHeight || captureViewportHeight
    const nextFindings = semanticFindings(rawDesignNode, rawDomNodes, selectedFrame.width, liveHeight, activeEngineMode)
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
        nextFindings.push({ severity: region.difference > 55 ? 'high' : region.difference > 32 ? 'medium' : 'low', title: `Visual difference region ${index + 1}`, detail: `${region.width}×${region.height}px region · ${region.difference}% structural difference after section alignment.`, confidence: Math.min(100, Math.round(region.difference)), comparison: { design: designRegion, live: liveRegion, delta: { x: liveRegion.rect.x - designRegion.rect.x, y: liveRegion.rect.y - designRegion.rect.y, width: liveRegion.rect.width - designRegion.rect.width, height: liveRegion.rect.height - designRegion.rect.height } } })
      }
    }
    nextFindings.unshift({ severity: Math.abs(selectedFrame.height - liveHeight) > 20 ? 'medium' : 'pass', title: Math.abs(selectedFrame.height - liveHeight) > 20 ? 'Full-page height differs' : 'Full-page height matches', detail: `Figma ${selectedFrame.height}px · Live ${liveHeight}px · Chromium viewport ${captureWidth}×${captureViewportHeight}`, confidence: 100, comparison: { design: { rect: { x: 0, y: 0, width: selectedFrame.width, height: selectedFrame.height }, pageWidth: selectedFrame.width, pageHeight: selectedFrame.height, label: `Figma full page · ${selectedFrame.width}×${selectedFrame.height}` }, live: { rect: { x: 0, y: 0, width: captureWidth, height: liveHeight }, pageWidth: captureWidth, pageHeight: liveHeight, label: `Live full page · ${captureWidth}×${liveHeight}` }, delta: { height: liveHeight - selectedFrame.height } } })
    const getY = (item: Finding) => {
      if (item.comparison?.live?.rect?.y !== undefined) return item.comparison.live.rect.y
      if (item.comparison?.design?.rect?.y !== undefined) return item.comparison.design.rect.y
      return 0
    }
    return nextFindings.sort((a, b) => getY(a) - getY(b))
  }, [rawDesignNode, rawDomNodes, selectedFrame, liveDocumentHeight, activeEngineMode, rawVisualData, captureWidth, captureViewportHeight])

  const dfs = useMemo(() => {
    if (similarity === null || changed === null) return null;
    const pixelPenalty = Math.min(50, (changed / 100) * 50 * 2.2);
    const highCount = findings.filter((item) => item.severity === 'high').length;
    const medCount = findings.filter((item) => item.severity === 'medium').length;
    const highPenalty = Math.min(30, highCount * 8);
    const medPenalty = Math.min(15, medCount * 4);
    const score = Math.max(0, Math.min(100, Math.round(100 - pixelPenalty - highPenalty - medPenalty)));
    return { score, pixelPenalty: Math.round(pixelPenalty), highPenalty, medPenalty };
  }, [similarity, changed, findings]);

  const [findingsFilter, setFindingsFilter] = useState<'all' | 'tokens' | 'layout' | 'content' | 'pass'>('all')

  const countTokens = useMemo(() => findings.filter((f) => f.title.startsWith('CSS Token') || f.title.includes('Font-')).length, [findings])
  const countLayout = useMemo(() => findings.filter((f) => f.title.includes('Position') || f.title.includes('height') || f.title.includes('Visual difference')).length, [findings])
  const countContent = useMemo(() => findings.filter((f) => f.title.includes('Missing design text') || f.title.includes('Image count')).length, [findings])
  const countPass = useMemo(() => findings.filter((f) => f.severity === 'pass').length, [findings])

  const filteredFindings = useMemo(() => {
    if (findingsFilter === 'tokens') return findings.filter((f) => f.title.startsWith('CSS Token') || f.title.includes('Font-'))
    if (findingsFilter === 'layout') return findings.filter((f) => f.title.includes('Position') || f.title.includes('height') || f.title.includes('Visual difference'))
    if (findingsFilter === 'content') return findings.filter((f) => f.title.includes('Missing design text') || f.title.includes('Image count'))
    if (findingsFilter === 'pass') return findings.filter((f) => f.severity === 'pass')
    return findings
  }, [findings, findingsFilter])

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
          <label className="automate-frame-select"><span>Frame</span><select value={frameId} onChange={(event) => setFrameId(event.target.value)} disabled={!frames.length}><option value="">Select a frame</option>{frames.map((frame) => <option key={frame.id} value={frame.id}>{frame.pageName} / {frame.name} · {frame.width}×{frame.height}</option>)}</select></label>
          {busy ? <button className="automate-secondary automate-cancel" onClick={cancelComparison}>Cancel</button> : <button className="automate-primary" disabled={!selectedFrame} onClick={runComparison} title={ready ? 'Run visual and semantic comparison' : 'The staging page will be checked before comparison starts'}>Run comparison</button>}
          <button className="automate-icon-btn" title="Replace Figma API token" onClick={async () => { await window.electronAPI.setFigmaToken(''); setTokenConfigured(false) }}><svg viewBox="0 0 24 24"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5v.2h-4v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1-2.8-2.8.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3v-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1 2.8-2.8.1.1a1.7 1.7 0 0 0 1.8.3 1.7 1.7 0 0 0 1-1.5V3h4v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1 2.8 2.8-.1.1a1.7 1.7 0 0 0-.3 1.8 1.7 1.7 0 0 0 1.5 1h.2v4h-.2a1.7 1.7 0 0 0-1.4 1Z" /></svg></button>
        </section>

        <section className="automate-mode-bar">
          <span className="automate-mode-label">Inspection Engine</span>
          <div className="automate-mode-segmented">
            <button
              className={`automate-mode-btn ${activeEngineMode === 'visual-surface' ? 'active' : ''}`}
              onClick={() => setActiveEngineMode('visual-surface')}
              title="Visual & Layout Engine: Hybrid OpenCV SSIM Surface Comparison & AKAZE Keypoint Registration"
            >
              Visual & Layout Engine
            </button>
            <button
              className={`automate-mode-btn ${activeEngineMode === 'token-auditor' ? 'active' : ''}`}
              onClick={() => setActiveEngineMode('token-auditor')}
              title="Design Token Auditor: Figma AST vs Computed CSS Spec Audit"
            >
              Design Token Auditor
            </button>
          </div>
        </section>
        {busy && <section className="automate-progress" aria-live="polite"><div><span>{progress.detail || 'Comparing…'}</span><strong>{progress.percent}%</strong></div><i><b style={{ width: `${progress.percent}%` }} /></i></section>}
        {error && <div className="automate-error">{error}</div>}
        {similarity === null ? <section className="automate-empty"><div className="automate-empty-grid"><span /><span /><span /><span /></div><h3>{frames.length ? 'Ready to compare' : 'Choose a Figma file and frame'}</h3><p>{selectedFrame ? `Design frame: ${selectedFrame.width}×${selectedFrame.height} full page · Chromium viewport: ${captureWidth}×${captureViewportHeight} · Live page height will be detected and stitched automatically.` : 'The matcher does not require Figma layer names to match WordPress or Elementor classes.'}</p>{fileName && <small>{fileName}</small>}</section> : <div className="automate-results">
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
              <div className="automate-card-head"><div><h3>Findings ({filteredFindings.length})</h3><span>Click a finding to inspect its visual evidence</span></div></div>
              <div className="automate-findings-tabs">
                <button className={findingsFilter === 'all' ? 'active' : ''} onClick={() => setFindingsFilter('all')}>All ({findings.length})</button>
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
                      key={`${finding.title}-${realIndex}`}
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
                      </div>
                      <small>{finding.confidence}%</small>
                    </button>
                  )
                })}
              </div>
            </section>
          </div>
        </div>}
      </>)}
  </div>
}
