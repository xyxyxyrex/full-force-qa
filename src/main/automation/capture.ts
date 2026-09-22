import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { acquireDebugger } from '../debuggerConnection'
import { createCaptureScrollPositions, isCaptureStickyPosition, resolveCaptureScrollPosition } from '../automateCaptureGeometry'
import { captureViewport, assertNativeSize, assertStablePage, PREPARE_IMAGES, RESTORE_CAPTURE_TOP } from './captureNormalization'

const AUTOMATE_DOM_EXPRESSION = `(() => {
  const selectors = 'h1,h2,h3,h4,h5,h6,p,a,button,label,li,span,div,dt,dd,summary,figcaption,th,td,img,input,section,article,header,footer,nav,main';
  const semanticTextSelector = 'h1,h2,h3,h4,h5,h6,p,a,button,label,li,span,dt,dd,summary,figcaption,th,td';
  const directSemanticSelector = semanticTextSelector.split(',').map((selector) => ':scope > ' + selector).join(',');
  const root = document.documentElement; const body = document.body;
  const pageHeight = Math.max(root.scrollHeight, root.offsetHeight, body?.scrollHeight || 0, body?.offsetHeight || 0);
  const pageWidth = Math.max(innerWidth, root.scrollWidth, body?.scrollWidth || 0);
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
    while (current && current !== document.documentElement) {
      const marker = ':nth-child(' + (Array.from(current.parentElement?.children || []).indexOf(current) + 1) + ')';
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
  const nodes = Array.from(document.querySelectorAll(selectors)).filter(element => { const style=getComputedStyle(element); return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && Number(style.opacity) !== 0 && !element.closest('[hidden],[aria-hidden="true"]'); }).map((element) => {
    const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
    const positioned = style.position === 'fixed' || style.position === 'sticky';
    const pageX = positioned ? rect.left : rect.left + scrollX;
    const pageY = positioned ? rect.top : rect.top + scrollY;
    return { tag: element.tagName.toLowerCase(), role: element.getAttribute('role') || '', text: elementText(element), src: element.tagName === 'IMG' ? element.currentSrc || element.src : '', context: contextFor(element), path: pathFor(element), rect: { x: pageX, y: pageY, width: rect.width, height: rect.height }, styles: { fontSize: style.fontSize, fontFamily: style.fontFamily, fontWeight: style.fontWeight, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, color: style.color, backgroundColor: style.backgroundColor, textAlign: style.textAlign, direction: style.direction, textTransform: style.textTransform, position: style.position, fontLoaded: String(fontActuallyLoaded(style)) } };
  }).filter((item) => item.rect.width > 1 && item.rect.height > 1 && item.rect.x > -item.rect.width && item.rect.x < pageWidth + item.rect.width && item.rect.y > -item.rect.height && item.rect.y < pageHeight + item.rect.height);
  return { nodes, pageWidth: Math.ceil(pageWidth), pageHeight: Math.ceil(pageHeight) };
})()`

function capturePromiseWithTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), Math.max(1, milliseconds))
    promise.then(
      (value) => { clearTimeout(timeout); resolve(value) },
      (error) => { clearTimeout(timeout); reject(error) },
    )
  })
}

const activeCaptures = new Set<number>()
export async function captureAutomatePage(webContentsId: number, viewportWidth: number, viewportHeight: number) {
  if (activeCaptures.has(webContentsId)) throw new Error('This page is still finishing its previous capture. Wait for cleanup before running again.')
  activeCaptures.add(webContentsId)
  try { return await performCapture(webContentsId, viewportWidth, viewportHeight) }
  finally { activeCaptures.delete(webContentsId) }
}
async function performCapture(webContentsId: number, viewportWidth: number, viewportHeight: number) {
  const debuggerLease = acquireDebugger(webContentsId, `capture:${webContentsId}:${Date.now()}`)
  const resumeInspector = await debuggerLease.beginExclusive()
  const target = debuggerLease.target
  const originalZoom = target.getZoomFactor()
  const captureDeadline = Date.now() + 60_000
  const sendCaptureCommand = <T = any>(method: string, params?: Record<string, unknown>, maximumWait = 12_000): Promise<T> => {
    const remaining = captureDeadline - Date.now()
    if (remaining <= 0) return Promise.reject(new Error('Full-page capture exceeded 60 seconds.'))
    return capturePromiseWithTimeout(
      debuggerLease.send(method, params).then((response: any) => {
        if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'Capture evaluation failed.')
        return response as T
      }),
      Math.min(maximumWait, remaining),
      `${method} timed out during full-page capture.`,
    )
  }
  try {
    const { width, height: tileHeight } = captureViewport(viewportWidth, viewportHeight)
    target.setZoomFactor(1)
    await sendCaptureCommand('Page.enable')
    await sendCaptureCommand('Emulation.setDeviceMetricsOverride', { width, height: tileHeight, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: tileHeight })
    // Hide scrollbar paint only. Keep Chromium's actual content geometry;
    // never expand containers to compensate for the scrollbar gutter.
    await sendCaptureCommand('Emulation.setScrollbarsHidden', { hidden: true })
    await sendCaptureCommand('Runtime.evaluate', { expression: `(() => { const shouldSuppressPosition = (${isCaptureStickyPosition.toString()}); const freeze = document.createElement('style'); freeze.id = '__qaAutomateFreeze'; freeze.textContent = '*, *::before, *::after { animation-play-state: paused !important; transition: none !important; caret-color: transparent !important; }'; document.head?.appendChild(freeze); const animations = document.getAnimations().map((animation) => ({ animation, playState: animation.playState })); for (const item of animations) item.animation.pause(); const positioned = []; const positionedElements = new WeakSet(); const rememberPositioned = (element) => { if (positionedElements.has(element)) return; positionedElements.add(element); positioned.push({ element, visibility: element.style.getPropertyValue('visibility'), visibilityPriority: element.style.getPropertyPriority('visibility') }); }; for (const element of document.body?.querySelectorAll('*') || []) { if (shouldSuppressPosition(getComputedStyle(element).position)) rememberPositioned(element); } window.__qaAutomateAtomicState = { x: scrollX, y: scrollY, animations, positioned, positionedElements, rememberPositioned, shouldSuppressPosition, scrollBehavior: document.documentElement.style.scrollBehavior }; document.documentElement.style.setProperty('scroll-behavior','auto','important'); scrollTo(0,0); return document.readyState; })()`, awaitPromise: true })
    await sendCaptureCommand('Runtime.evaluate', { expression: PREPARE_IMAGES, awaitPromise: true }, 25_000)
    const measured = await sendCaptureCommand('Runtime.evaluate', { expression: `(() => { const root = document.documentElement; const body = document.body; const scroller = document.scrollingElement || root; const viewportHeight = Math.max(1, Math.ceil(scroller.clientHeight || innerHeight || ${tileHeight})); const height = Math.ceil(Math.max(scroller.scrollHeight, root.scrollHeight, body?.scrollHeight || 0, viewportHeight)); const scrollRange = Math.ceil(Math.max(0, scroller.scrollHeight - scroller.clientHeight, root.scrollHeight - root.clientHeight, (body?.scrollHeight || 0) - (body?.clientHeight || 0))); return { width: Math.ceil(Math.max(root.scrollWidth, body?.scrollWidth || 0)), height, viewportHeight, scrollRange }; })()`, returnByValue: true })
    const measuredValue = measured?.result?.value || {}
    const documentWidth = Math.max(width, Number(measuredValue.width || width))
    if (documentWidth !== width) throw new Error('Horizontal overflow is outside the capture viewport. Full-width coverage is unavailable; no screenshot was resized.')
    const effectiveViewportHeight = Math.max(1, Number(measuredValue.viewportHeight || tileHeight))
    const documentHeight = Math.max(tileHeight, Number(measuredValue.height || tileHeight), Number(measuredValue.scrollRange || 0) + effectiveViewportHeight)
    if (width * documentHeight > 45_000_000 || documentHeight > 24000) throw new Error('The page exceeds the verified Chromium tile limit.')
    const uniquePositions = createCaptureScrollPositions(documentHeight, effectiveViewportHeight, Number(measuredValue.scrollRange || 0))
    const composites: Array<{ input: Buffer; top: number; left: number }> = []
    let previousHash = ''; let consecutiveDuplicates = 0
    for (let index = 0; index < uniquePositions.length; index++) {
      const y = uniquePositions[index]
      const positioned = await sendCaptureCommand('Runtime.evaluate', { expression: `(async () => { const state = window.__qaAutomateAtomicState; const restoreVisibility = (item) => { if (item.visibility) item.element.style.setProperty('visibility', item.visibility, item.visibilityPriority || ''); else item.element.style.removeProperty('visibility'); }; for (const item of state?.positioned || []) { if (${y} === 0) restoreVisibility(item); else item.element.style.setProperty('visibility','hidden','important'); } const root = document.documentElement; const body = document.body; const scroller = document.scrollingElement || root; root.style.setProperty('scroll-behavior','auto','important'); scrollTo(0,${y}); root.scrollTop=${y}; if (body) body.scrollTop=${y}; await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); await new Promise((resolve) => setTimeout(resolve, 50)); if (${y} > 0 && state) { for (const element of body?.querySelectorAll('*') || []) { if (!state.shouldSuppressPosition(getComputedStyle(element).position)) continue; state.rememberPositioned(element); element.style.setProperty('visibility','hidden','important'); } await new Promise((resolve) => setTimeout(resolve, 0)); } const viewportHeight = Math.max(1, Math.ceil(scroller.clientHeight || innerHeight || ${effectiveViewportHeight})); const scrollHeight = Math.ceil(Math.max(scroller.scrollHeight, root.scrollHeight, body?.scrollHeight || 0, viewportHeight)); const maxScroll = Math.ceil(Math.max(0, scroller.scrollHeight - scroller.clientHeight, root.scrollHeight - root.clientHeight, (body?.scrollHeight || 0) - (body?.clientHeight || 0))); return { y: scrollY, rootY: root.scrollTop, bodyY: body?.scrollTop || 0, scrollHeight, viewportHeight, maxScroll, positioned: state?.positioned?.length || 0 }; })()`, returnByValue: true, awaitPromise: true })
      const positionValue = positioned?.result?.value || {}
      const actual = Math.max(Number(positionValue.y || 0), Number(positionValue.rootY || 0), Number(positionValue.bodyY || 0))
      const currentMaxScroll = Math.max(0, Number(positionValue.maxScroll || 0))
      const resolvedPosition = resolveCaptureScrollPosition(y, actual, currentMaxScroll)
      if (!resolvedPosition) throw new Error(`DevTools Chromium stopped at ${Math.round(actual)}px instead of tile ${index + 1} at ${y}px (current range ${Math.round(currentMaxScroll)}px).`)
      if (resolvedPosition.clampedToEnd) throw new Error('The page scroll range changed during capture. Run again after the page stabilizes.')
      assertStablePage(width, documentHeight, width, Math.max(tileHeight, Number(positionValue.scrollHeight)))
      const screenshot = await sendCaptureCommand('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false, optimizeForSpeed: true }, 15_000)
      const tile = Buffer.from(screenshot.data, 'base64')
      assertNativeSize(await sharp(tile).metadata(), {width, height:tileHeight}, 'Chromium tile')
      const hash = createHash('sha256').update(tile).digest('hex')
      if (index > 0 && hash === previousHash) consecutiveDuplicates++; else consecutiveDuplicates = 0
      if (consecutiveDuplicates >= 1) throw new Error(`Chromium returned a repeated DevTools tile at ${resolvedPosition.top}px.`)
      previousHash = hash; composites.push({ input: tile, top: resolvedPosition.top, left: 0 })
    }
    // Scan only after the full scroll pass so lazy-rendered footer and below-fold
    // elements participate in semantic matching. Coordinates are document-relative.
    await sendCaptureCommand('Runtime.evaluate', { expression: RESTORE_CAPTURE_TOP, awaitPromise: true })
    const semantic = await sendCaptureCommand('Runtime.evaluate', { expression: AUTOMATE_DOM_EXPRESSION, returnByValue: true }, 15_000)
    const semanticValue = semantic?.result?.value
    if (!Array.isArray(semanticValue?.nodes)) throw new Error('Semantic snapshot unavailable.')
    assertStablePage(width, documentHeight, semanticValue.pageWidth, Math.max(tileHeight, semanticValue.pageHeight))
    const stitched = await sharp({ create: { width, height: documentHeight, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).composite(composites).png({ compressionLevel: 6 }).toBuffer()
    return { success: true, dataUrl: `data:image/png;base64,${stitched.toString('base64')}`, documentWidth, documentHeight, domNodes: semantic?.result?.value?.nodes || [], tiles: composites.length, mode: 'verified-cdp-tiles' }
  } finally {
    try {
      await capturePromiseWithTimeout(debuggerLease.send('Runtime.evaluate', { expression: `(() => { document.getElementById('__qaAutomateFreeze')?.remove(); const state = window.__qaAutomateAtomicState; if (state) { for (const item of state.positioned || []) { if (item.visibility) item.element.style.setProperty('visibility', item.visibility, item.visibilityPriority || ''); else item.element.style.removeProperty('visibility'); } document.documentElement.style.scrollBehavior = state.scrollBehavior; scrollTo(state.x, state.y); for (const item of state.animations || []) { if (item.playState === 'running') item.animation.play(); } } delete window.__qaAutomateAtomicState; })()` }), 2_000, 'Capture page cleanup timed out.')
    } catch {}
    try { await capturePromiseWithTimeout(debuggerLease.send('Emulation.setScrollbarsHidden', { hidden: false }), 2_000, 'Scrollbar cleanup timed out.') } catch {}
    try { await capturePromiseWithTimeout(debuggerLease.send('Emulation.clearDeviceMetricsOverride'), 2_000, 'Viewport cleanup timed out.') } catch {}
    if (!target.isDestroyed()) target.setZoomFactor(originalZoom)
    resumeInspector()
    debuggerLease.release()
  }
}
