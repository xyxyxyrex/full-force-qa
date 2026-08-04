import { useEffect, useMemo, useRef, useState } from 'react'
import './AutomateWorkspace.css'

interface FrameSummary { id: string; name: string; type: string; pageName: string; width: number; height: number }
interface DomNode { tag: string; role: string; text: string; src: string; context: string; path: string; rect: { x: number; y: number; width: number; height: number }; styles: Record<string, string> }
interface ComparedRegion { rect: { x: number; y: number; width: number; height: number }; pageWidth: number; pageHeight: number; label: string }
interface FindingComparison { design?: ComparedRegion; live?: ComparedRegion; delta?: { x?: number; y?: number; width?: number; height?: number; fontSize?: number } }
interface Finding { severity: 'high' | 'medium' | 'low' | 'pass'; title: string; detail: string; confidence: number; comparison?: FindingComparison }

interface Props {
  sourceUrl: string
  figmaUrl?: string
  projectId: string
}

const normalizeText = (value = '') => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const textTokens = (value: string) => new Set(normalizeText(value).split(' ').filter(Boolean))
const tokenScore = (left: string, right: string) => {
  const a = normalizeText(left); const b = normalizeText(right)
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length) * .9
  const aa = textTokens(a); const bb = textTokens(b); let common = 0
  aa.forEach((token) => { if (bb.has(token)) common++ })
  return common / Math.max(aa.size, bb.size, 1)
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
    const values = new Uint8Array(canvas.width * canvas.height)
    for (let source = 0, target = 0; source < pixels.length; source += 4, target++) values[target] = Math.round(pixels[source] * .299 + pixels[source + 1] * .587 + pixels[source + 2] * .114)
    return values
  }
  const difference = (left: Uint8Array, right: Uint8Array) => {
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
      const nativeImage = await withTimeout(view.capturePage(), 20_000, 'Timed out capturing the expanded Chromium surface.')
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
      const actualPosition = await withTimeout(view.executeJavaScript(`(async () => {
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
      const nativeImage = await withTimeout(view.capturePage(), 12000, `Timed out capturing live page tile ${index + 1}.`)
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
    } catch {}
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
        const rect = region.rect; const cropWidth = Math.min(region.pageWidth, Math.max(rect.width + 360, region.pageWidth * .42))
        const cropHeight = Math.min(region.pageHeight, Math.max(rect.height + 260, cropWidth * panelHeight / panelWidth))
        const cropX = Math.max(0, Math.min(region.pageWidth - cropWidth, rect.x + rect.width / 2 - cropWidth / 2))
        const cropY = Math.max(0, Math.min(region.pageHeight - cropHeight, rect.y + rect.height / 2 - cropHeight / 2))
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
    }).catch(() => {})
    return () => { disposed = true }
  }, [designImage, finding, liveImage])
  return <div className="automate-finding-comparison"><div className="automate-finding-comparison-head"><div><strong>{finding.title}</strong><span>{finding.detail}</span></div><button onClick={onClose} title="Return to visual overview">×</button></div><canvas ref={canvasRef} /></div>
}

function semanticFindings(figmaRoot: any, domNodes: DomNode[], liveWidth: number, liveHeight: number): Finding[] {
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
      if ((!exact && text < .68) || (!exact && Math.min(designText.length, candidateText.length) < 8)) continue
      const box = design.absoluteBoundingBox
      const dx = Math.abs((box.x - root.x) / root.width - candidate.rect.x / liveWidth)
      const dy = Math.abs((box.y - root.y) / root.height - candidate.rect.y / liveHeight)
      const normalizedDistance = Math.hypot(dx, dy)
      if (!exact && normalizedDistance > .2) continue
      const geometry = Math.max(0, 1 - normalizedDistance * 2.4)
      const context = tokenScore(design.__context || '', `${candidate.context} ${candidate.path}`)
      const expectedFont = Number(design.style?.fontSize || 0)
      const headingAffinity = expectedFont >= 20 ? (/^h[1-6]$/.test(candidate.tag) ? .06 : -.08) : 0
      const score = text * .64 + geometry * .27 + context * .09 + headingAffinity
      if (!best || score > best.score) best = { index, score, geometry, text }
    }
    const label = String(design.characters).trim().replace(/\s+/g, ' ').slice(0, 72)
    const designRect = { x: design.absoluteBoundingBox.x - root.x, y: design.absoluteBoundingBox.y - root.y, width: design.absoluteBoundingBox.width, height: design.absoluteBoundingBox.height }
    const designContext = String(design.__context || '').trim().replace(/\s+/g, ' ').slice(0, 72)
    const designRegion: ComparedRegion = { rect: designRect, pageWidth: root.width, pageHeight: root.height, label: `TEXT · ${label}${designContext ? ` · ${designContext}` : ''}` }
    if (!best || best.score < .62) {
      findings.push({ severity: 'high', title: `Missing design text: “${label}”`, detail: 'No sufficiently similar visible DOM element was found.', confidence: Math.round((1 - (best?.score || 0)) * 100), comparison: { design: designRegion } })
      continue
    }
    used.add(best.index)
    const live = candidates[best.index]; const box = design.absoluteBoundingBox
    const expectedX = (box.x - root.x) / root.width * liveWidth; const expectedY = (box.y - root.y) / root.height * liveHeight
    const offset = Math.hypot(expectedX - live.rect.x, expectedY - live.rect.y)
    const expectedFont = Number(design.style?.fontSize || 0); const actualFont = parseFloat(live.styles.fontSize || '0')
    const liveRegion: ComparedRegion = { rect: live.rect, pageWidth: liveWidth, pageHeight: liveHeight, label: `<${live.tag}> · ${live.text.slice(0, 54)}${live.context ? ` · ${live.context.slice(0, 42)}` : ''}` }
    const comparison: FindingComparison = { design: designRegion, live: liveRegion, delta: { x: live.rect.x - expectedX, y: live.rect.y - expectedY, width: live.rect.width - designRect.width / root.width * liveWidth, height: live.rect.height - designRect.height / root.height * liveHeight } }
    if (offset > Math.max(12, liveWidth * .015)) findings.push({ severity: offset > liveWidth * .05 ? 'high' : 'medium', title: `Position mismatch: “${label}”`, detail: `Matched <${live.tag}> is approximately ${Math.round(offset)} px from its expected position.`, confidence: Math.round(best.score * 100), comparison })
    if (expectedFont && actualFont && Math.abs(expectedFont - actualFont) > 1.5) findings.push({ severity: Math.abs(expectedFont - actualFont) > 4 ? 'medium' : 'low', title: `Font-size mismatch: “${label}”`, detail: `Figma ${expectedFont}px · Live ${Math.round(actualFont * 10) / 10}px`, confidence: Math.round(best.score * 100), comparison: { ...comparison, delta: { ...comparison.delta, fontSize: actualFont - expectedFont } } })
  }
  const liveImages = domNodes.filter((node) => node.tag === 'img')
  if (figmaImages.length !== liveImages.length) findings.push({ severity: 'medium', title: 'Image count differs', detail: `Figma contains ${figmaImages.length} image layers; the live page contains ${liveImages.length} visible images.`, confidence: 72, comparison: { design: { rect: { x: 0, y: 0, width: root.width, height: root.height }, pageWidth: root.width, pageHeight: root.height, label: `${figmaImages.length} Figma image layers` }, live: { rect: { x: 0, y: 0, width: liveWidth, height: liveHeight }, pageWidth: liveWidth, pageHeight: liveHeight, label: `${liveImages.length} live images` } } })
  if (!findings.length) findings.push({ severity: 'pass', title: 'No material semantic mismatches detected', detail: `${figmaText.length} text layers and ${figmaImages.length} image layers were evaluated.`, confidence: 92 })
  const rank = { high: 0, medium: 1, low: 2, pass: 3 }
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity])
}

export default function AutomateWorkspace({ sourceUrl, figmaUrl = '', projectId }: Props) {
  const webviewRef = useRef<any>(null)
  const comparisonRunRef = useRef(0)
  const activeVisualJobRef = useRef('')
  const [tokenConfigured, setTokenConfigured] = useState(false); const [token, setToken] = useState(''); const [showToken, setShowToken] = useState(false)
  const [designUrl, setDesignUrl] = useState(() => localStorage.getItem(`qa_${projectId}_automate_figma_url`) || figmaUrl)
  const [frames, setFrames] = useState<FrameSummary[]>([]); const [frameId, setFrameId] = useState(''); const [fileName, setFileName] = useState('')
  const [ready, setReady] = useState(false); const [busy, setBusy] = useState(false); const [status, setStatus] = useState('Connect a Figma frame to begin.'); const [error, setError] = useState('')
  const [designImage, setDesignImage] = useState(''); const [liveImage, setLiveImage] = useState(''); const [diffImage, setDiffImage] = useState('')
  const [similarity, setSimilarity] = useState<number | null>(null); const [changed, setChanged] = useState<number | null>(null); const [findings, setFindings] = useState<Finding[]>([]); const [view, setView] = useState<'diff' | 'design' | 'live'>('diff')
  const [progress, setProgress] = useState({ percent: 0, detail: '' })
  const [liveDocumentHeight, setLiveDocumentHeight] = useState<number | null>(null)
  const [selectedFindingIndex, setSelectedFindingIndex] = useState<number | null>(null)
  const [visualEngine, setVisualEngine] = useState('')
  const selectedFrame = useMemo(() => frames.find((frame) => frame.id === frameId), [frameId, frames])

  useEffect(() => { window.electronAPI.figmaTokenStatus().then((result) => setTokenConfigured(result.configured)).catch(() => {}) }, [])
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
    try { if (view.getWebContentsId?.()) view.executeJavaScript('document.readyState', true).then((state: string) => { if (state === 'interactive' || state === 'complete') loaded() }).catch(() => {}) } catch {}
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
    setBusy(true); setError(''); setStatus('Preparing comparison…'); setProgress({ percent: 4, detail: 'Preparing comparison…' }); setFindings([]); setSelectedFindingIndex(null); setVisualEngine('')
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
          const own = directText(element);
          if (own) return own;
          const semanticChildren = Array.from(element.querySelectorAll(directSemanticSelector));
          if (element.matches('li') && semanticChildren.length === 1) return compact(semanticChildren[0].innerText || accessible);
          if (!element.querySelector(semanticTextSelector)) return compact(element.innerText || accessible);
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
      updateProgress(80, 'Registering page sections with OpenCV…')
      let enhancedVisual: any = null
      let workerProgress = 81
      const workerProgressTimer = window.setInterval(() => { workerProgress = Math.min(90, workerProgress + 1); updateProgress(workerProgress, workerProgress < 86 ? 'Registering long-page sections with OpenCV…' : 'Calculating SSIM heatmap and change contours…') }, 900)
      try {
        enhancedVisual = await withTimeout(window.electronAPI.compareVisuals(visualJobId, design.imageDataUrl, liveCapture.dataUrl), 95_000, 'The OpenCV visual comparison exceeded 95 seconds.')
      } catch (workerError: any) {
        enhancedVisual = { success: false, error: workerError?.message || 'The OpenCV worker was unavailable.', fallback: true }
      } finally { clearInterval(workerProgressTimer) }
      const visual = enhancedVisual?.success
        ? { dataUrl: enhancedVisual.heatmapDataUrl, similarity: enhancedVisual.similarity, changedPercent: enhancedVisual.changedPercent, regions: enhancedVisual.regions || [], anchors: enhancedVisual.anchors || [], engine: enhancedVisual.engine || 'opencv-ssim' }
        : { ...(await withTimeout(createVisualDiff(design.imageDataUrl, liveCapture.dataUrl), 30_000, 'Visual difference processing exceeded 30 seconds and was stopped.')), regions: [], anchors: [], engine: 'javascript-fallback' }
      if (cancelled()) throw new Error('Comparison cancelled.')
      updateProgress(92, 'Matching Figma layers to live elements…')
      const nextFindings = semanticFindings(design.node, domNodes, selectedFrame.width, liveCapture.documentHeight)
      if (visual.regions.length && visual.anchors.length) {
        const mapLiveY = (designY: number) => {
          const anchors = visual.anchors as Array<{ designY: number; liveY: number }>
          const upperIndex = anchors.findIndex((anchor) => anchor.designY >= designY)
          if (upperIndex <= 0) return anchors[0]?.liveY || designY
          const upper = anchors[upperIndex]; const lower = anchors[upperIndex - 1]
          const ratio = (designY - lower.designY) / Math.max(1, upper.designY - lower.designY)
          return lower.liveY + (upper.liveY - lower.liveY) * ratio
        }
        const meaningfulRegions = visual.regions.filter((region: any) => region.width * region.height > selectedFrame.width * selectedFrame.height * .0002).slice(0, 8)
        for (const [index, region] of meaningfulRegions.entries()) {
          const liveY = mapLiveY(region.y); const liveBottom = mapLiveY(region.y + region.height)
          const designRegion: ComparedRegion = { rect: { x: region.x, y: region.y, width: region.width, height: region.height }, pageWidth: selectedFrame.width, pageHeight: selectedFrame.height, label: `OpenCV difference region ${index + 1}` }
          const liveRegion: ComparedRegion = { rect: { x: region.x / selectedFrame.width * captureWidth, y: liveY, width: region.width / selectedFrame.width * captureWidth, height: Math.max(1, liveBottom - liveY) }, pageWidth: captureWidth, pageHeight: liveCapture.documentHeight, label: `Registered live region · ${region.difference}% structural difference` }
          nextFindings.push({ severity: region.difference > 55 ? 'high' : region.difference > 32 ? 'medium' : 'low', title: `Visual difference region ${index + 1}`, detail: `${region.width}×${region.height}px region · ${region.difference}% structural difference after section alignment.`, confidence: Math.min(100, Math.round(region.difference)), comparison: { design: designRegion, live: liveRegion, delta: { x: liveRegion.rect.x - designRegion.rect.x, y: liveRegion.rect.y - designRegion.rect.y, width: liveRegion.rect.width - designRegion.rect.width, height: liveRegion.rect.height - designRegion.rect.height } } })
        }
      }
      nextFindings.unshift({ severity: Math.abs(selectedFrame.height - liveCapture.documentHeight) > 20 ? 'medium' : 'pass', title: Math.abs(selectedFrame.height - liveCapture.documentHeight) > 20 ? 'Full-page height differs' : 'Full-page height matches', detail: `Figma ${selectedFrame.height}px · Live ${liveCapture.documentHeight}px · Chromium viewport ${captureWidth}×${captureViewportHeight}`, confidence: 100, comparison: { design: { rect: { x: 0, y: 0, width: selectedFrame.width, height: selectedFrame.height }, pageWidth: selectedFrame.width, pageHeight: selectedFrame.height, label: `Figma full page · ${selectedFrame.width}×${selectedFrame.height}` }, live: { rect: { x: 0, y: 0, width: captureWidth, height: liveCapture.documentHeight }, pageWidth: captureWidth, pageHeight: liveCapture.documentHeight, label: `Live full page · ${captureWidth}×${liveCapture.documentHeight}` }, delta: { height: liveCapture.documentHeight - selectedFrame.height } } })
      if (!cancelled()) {
        setDesignImage(design.imageDataUrl); setLiveImage(liveCapture.dataUrl); setDiffImage(visual.dataUrl); setSimilarity(visual.similarity); setChanged(visual.changedPercent); setLiveDocumentHeight(liveCapture.documentHeight); setVisualEngine(visual.engine)
        setFindings(nextFindings); setView('diff'); setProgress({ percent: 100, detail: `Comparison complete · ${liveCapture.mode === 'atomic-cdp' ? 'atomic Chromium capture' : `${liveCapture.tiles} capture tiles`} · ${visual.engine}` }); setStatus('Comparison complete.')
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
  return <div className="automate-workspace">
    <webview ref={webviewRef} className="automate-capture-webview" src={sourceUrl} webpreferences="backgroundThrottling=no" style={{ width: captureWidth, height: captureViewportHeight }} onDomReady={() => setReady(true)} />
    <div className="automate-capture-shield" aria-hidden="true" />
    <header className="automate-header">
      <div><span className="automate-kicker">Visual regression + semantic layout</span><h2>Automate</h2><p>{status}</p></div>
      <div className={`automate-api-state ${tokenConfigured ? 'connected' : ''}`}><i />{tokenConfigured ? 'Figma API connected' : 'Figma API required'}</div>
    </header>
    {!tokenConfigured ? <section className="automate-setup-card">
      <div className="automate-setup-icon"><svg viewBox="0 0 24 24"><path d="M8 3h8a5 5 0 0 1 0 10H8a5 5 0 0 1 0-10Zm0 8h5v5a5 5 0 1 1-5-5Zm5 0h3a5 5 0 1 1-3 5v-5Z" /></svg></div>
      <div><h3>Connect the Figma REST API</h3><p>Create a personal access token with <code>file_content:read</code>. It is encrypted using the operating system credential service and handled only by Electron’s main process.</p>
        <div className="automate-token-row"><input type={showToken ? 'text' : 'password'} value={token} onChange={(event) => setToken(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && token.trim() && !busy) void connect() }} placeholder="figd_…" /><button className="automate-icon-btn" onClick={() => setShowToken((value) => !value)} title={showToken ? 'Hide token' : 'Show token'}><svg viewBox="0 0 24 24"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></button><button className="automate-primary" disabled={!token.trim() || busy} onClick={connect}>{busy ? 'Connecting…' : 'Connect'}</button></div>
        {error && <div className="automate-error automate-setup-error">{error}</div>}
        <button className="automate-link" onClick={() => window.electronAPI.openExternal('https://www.figma.com/developers/api#access-tokens')}>Open Figma token settings ↗</button>
      </div>
    </section> : <>
      <section className="automate-source-bar">
        <label><span>Figma design</span><input value={designUrl} onChange={(event) => setDesignUrl(event.target.value)} placeholder="https://www.figma.com/design/…?node-id=…" /></label>
        <button className="automate-secondary" disabled={busy || !designUrl.trim()} onClick={loadFrames}>Load frames</button>
        <label className="automate-frame-select"><span>Frame</span><select value={frameId} onChange={(event) => setFrameId(event.target.value)} disabled={!frames.length}><option value="">Select a frame</option>{frames.map((frame) => <option key={frame.id} value={frame.id}>{frame.pageName} / {frame.name} · {frame.width}×{frame.height}</option>)}</select></label>
        {busy ? <button className="automate-secondary automate-cancel" onClick={cancelComparison}>Cancel</button> : <button className="automate-primary" disabled={!selectedFrame} onClick={runComparison} title={ready ? 'Run visual and semantic comparison' : 'The staging page will be checked before comparison starts'}>Run comparison</button>}
        <button className="automate-icon-btn" title="Replace Figma API token" onClick={async () => { await window.electronAPI.setFigmaToken(''); setTokenConfigured(false) }}><svg viewBox="0 0 24 24"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5v.2h-4v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1-2.8-2.8.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3v-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1 2.8-2.8.1.1a1.7 1.7 0 0 0 1.8.3 1.7 1.7 0 0 0 1-1.5V3h4v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1 2.8 2.8-.1.1a1.7 1.7 0 0 0-.3 1.8 1.7 1.7 0 0 0 1.5 1h.2v4h-.2a1.7 1.7 0 0 0-1.4 1Z"/></svg></button>
      </section>
      {busy && <section className="automate-progress" aria-live="polite"><div><span>{progress.detail || 'Comparing…'}</span><strong>{progress.percent}%</strong></div><i><b style={{ width: `${progress.percent}%` }} /></i></section>}
      {error && <div className="automate-error">{error}</div>}
      {similarity === null ? <section className="automate-empty"><div className="automate-empty-grid"><span/><span/><span/><span/></div><h3>{frames.length ? 'Ready to compare' : 'Choose a Figma file and frame'}</h3><p>{selectedFrame ? `Design frame: ${selectedFrame.width}×${selectedFrame.height} full page · Chromium viewport: ${captureWidth}×${captureViewportHeight} · Live page height will be detected and stitched automatically.` : 'The matcher does not require Figma layer names to match WordPress or Elementor classes.'}</p>{fileName && <small>{fileName}</small>}</section> : <div className="automate-results">
        <section className="automate-score-row"><div><strong>{similarity.toFixed(1)}%</strong><span>Visual similarity · {visualEngine || 'pending'}</span></div><div><strong>{changed?.toFixed(1)}%</strong><span>Changed pixels after alignment</span></div><div><strong>{findings.filter((item) => item.severity === 'high').length}</strong><span>High-priority findings</span></div><div><strong>{findings.length}</strong><span>Semantic checks</span></div></section>
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
            <div className="automate-card-head"><div><h3>Semantic findings</h3><span>Click a finding to inspect its visual evidence</span></div></div>
            <div className="automate-findings-list">
              {findings.map((finding, index) => (
                <button
                  type="button"
                  key={`${finding.title}-${index}`}
                  className={`severity-${finding.severity}${selectedFindingIndex === index ? ' selected' : ''}`}
                  onClick={() => finding.comparison && setSelectedFindingIndex(index)}
                  aria-pressed={selectedFindingIndex === index}
                  disabled={!finding.comparison}
                >
                  <i/><div><h4>{finding.title}</h4><p>{finding.detail}</p></div><small>{finding.confidence}%</small>
                </button>
              ))}
            </div>
          </section>
        </div>
      </div>}
    </>}
  </div>
}
