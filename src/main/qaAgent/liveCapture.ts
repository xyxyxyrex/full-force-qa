import { createHash } from 'crypto'
import { BrowserWindow, session } from 'electron'
import sharp from 'sharp'
import type { Breakpoint } from '../../shared/designScale'
import { acquireDebugger } from '../debuggerConnection'
import { createCaptureScrollPositions, resolveCaptureScrollPosition } from '../automateCaptureGeometry'
import { checkCaptureUrl, isLoginUrl, MAX_CAPTURE_HEIGHT, SOFT_CAPTURE_DEADLINE_MS, userAgentFor, viewportHeightFor } from './captureSettings'
import { MEASURE_EXPRESSION, PREPARE_EXPRESSION, VALUES_EXPRESSION } from './liveDomExpression'
import { finalizeSections, sectionIdAt, type PageSection } from './sections'

// Tolerant full-page capture of a live page at a design's width, for the QA agent.
//
// Unlike the Automate capture this never refuses a page for being untidy: horizontal
// overflow, a page that grows while scrolling, slow images or a missing viewport meta
// all become entries in `warnings`. The window is rendered offscreen because hidden
// (`show:false`) windows stop painting on some systems, which makes screenshots hang.

export interface LiveNode {
  tag: string
  text: string
  rect: { x: number; y: number; width: number; height: number }
  path: string
  styles: Record<string, string>
  src?: string
  natural?: string
  objectFit?: string
  positioned?: string
  sectionId: string | null
}

export interface LiveCaptureResult {
  png: Buffer
  width: number
  viewportHeight: number
  documentHeight: number
  capturedHeight: number
  truncated: boolean
  tiles: number
  /** Which screenshot method produced the tiles. */
  mode: 'cdp' | 'capturePage' | 'mixed'
  finalUrl: string
  title: string
  warnings: string[]
  sections: PageSection[]
  nodes: LiveNode[]
  page: { lang: string; viewportMeta: string; fontsFailed: string[]; bodyClass: string }
}

export interface LiveCaptureOptions {
  url: string
  breakpoint: Breakpoint
  /** Design frame width in CSS px. */
  width: number
  viewportHeight?: number
  onProgress?: (message: string) => void
  /** Skip the DevTools screenshot method (used by tests to exercise the fallback). */
  forceFallback?: boolean
}

const LOAD_TIMEOUT_MS = 30_000
const CDP_SHOT_TIMEOUT_MS = 8_000

const qaWindowIds = new Set<number>()
let permissionGuardInstalled = false
let running = false

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), Math.max(1, ms))
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

// Pages in the capture window must not get camera, location or notification access.
// Everything else keeps Electron's default (grant), so other windows behave as before.
function installPermissionGuard(): void {
  if (permissionGuardInstalled) return
  permissionGuardInstalled = true
  session.defaultSession.setPermissionRequestHandler((webContents, _permission, callback) => {
    callback(!(webContents && qaWindowIds.has(webContents.id)))
  })
}

export async function captureLivePage(options: LiveCaptureOptions): Promise<LiveCaptureResult> {
  const check = checkCaptureUrl(options.url)
  if (!check.ok) throw new Error(check.reason)
  const width = Math.round(options.width)
  if (!Number.isFinite(width) || width < 240 || width > 3000) throw new Error('The capture width must be between 240 and 3000 px.')
  if (running) throw new Error('Another page capture is still running. Wait for it to finish.')
  running = true
  try {
    return await runCapture(options, width)
  } finally {
    running = false
  }
}

async function runCapture(options: LiveCaptureOptions, width: number): Promise<LiveCaptureResult> {
  const { breakpoint, onProgress } = options
  const viewportHeight = Math.round(options.viewportHeight || viewportHeightFor(width))
  const warnings: string[] = []
  const warn = (message: string) => { if (!warnings.includes(message)) warnings.push(message) }
  const startedAt = Date.now()
  installPermissionGuard()

  const win = new BrowserWindow({
    show: false,
    width,
    height: viewportHeight,
    useContentSize: true,
    enableLargerThanScreen: true,
    webPreferences: { session: session.defaultSession, offscreen: true, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  })
  const contents = win.webContents
  qaWindowIds.add(contents.id)
  contents.setAudioMuted(true)
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const agent = userAgentFor(breakpoint)

  // An offscreen window has no page to attach to until something is loaded.
  try { await contents.loadURL('about:blank') } catch { /* attach below reports a real failure */ }
  const lease = acquireDebugger(contents.id, `qa-capture:${contents.id}:${startedAt}`)

  const evaluate = async <T = any>(expression: string, timeoutMs = 20_000): Promise<T> => {
    const response: any = await withTimeout(
      lease.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
      timeoutMs,
      'The page did not respond in time.',
    )
    if (response?.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'Script failed in the page.')
    return response?.result?.value as T
  }

  try {
    const mobileEmulation = breakpoint !== 'desktop'
    await lease.send('Page.enable')
    await lease.send('Emulation.setDeviceMetricsOverride', { width, height: viewportHeight, deviceScaleFactor: 1, mobile: mobileEmulation, screenWidth: width, screenHeight: viewportHeight })
    await lease.send('Emulation.setScrollbarsHidden', { hidden: true })
    for (const [method, params] of [
      ['Emulation.setFocusEmulationEnabled', { enabled: true }],
      ['Emulation.setTouchEmulationEnabled', { enabled: mobileEmulation, maxTouchPoints: mobileEmulation ? 5 : 0 }],
      ['Page.setWebLifecycleState', { state: 'active' }],
    ] as const) {
      try { await lease.send(method, params as Record<string, unknown>) } catch { /* optional */ }
    }

    if (agent) await lease.send('Emulation.setUserAgentOverride', { userAgent: agent })

    onProgress?.('Loading the page…')
    let loaded: () => void = () => {}
    const loadEvent = new Promise<void>((resolve) => { loaded = resolve })
    const stopListening = lease.onMessage((method) => { if (method === 'Page.loadEventFired') loaded() })
    try {
      const navigation: any = await withTimeout(lease.send('Page.navigate', { url: options.url }), LOAD_TIMEOUT_MS, 'navigation timeout')
      if (navigation?.errorText) throw new Error(navigation.errorText)
      await withTimeout(loadEvent, LOAD_TIMEOUT_MS, 'load timeout')
    } catch (error: any) {
      warn(`The page did not finish loading within 30 seconds (${error?.message || 'error'}); the capture used what had loaded.`)
    } finally {
      stopListening()
    }
    const finalUrl = (await evaluate<string>('location.href').catch(() => '')) || options.url
    if (isLoginUrl(finalUrl)) throw new Error('The page redirected to the WordPress login. Log in to the site in Parity first, then try again.')
    const status = await evaluate<number>('(performance.getEntriesByType("navigation")[0] || {}).responseStatus || 0').catch(() => 0)
    if (status >= 400) warn(`The page answered with HTTP ${status}.`)
    await sleep(1_500)

    // Phone-style emulation lets a page zoom out to fit overflowing content, or lay out at
    // 980px when it has no viewport meta tag. Either way one image pixel stops being one CSS
    // pixel and scrolling misbehaves, so the capture switches to a fixed-width viewport.
    if (mobileEmulation) {
      const early = await evaluate<{ clientWidth: number; innerWidth: number }>(MEASURE_EXPRESSION)
      if (early.clientWidth !== width || early.innerWidth !== width) {
        await lease.send('Emulation.setDeviceMetricsOverride', { width, height: viewportHeight, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: viewportHeight })
        await sleep(400)
        warn(`With phone-style scaling the page laid out at ${Math.max(early.clientWidth, early.innerWidth)}px instead of ${width}px (overflowing content or no viewport meta tag), so it was captured in a fixed ${width}px viewport; anything wider is cut off at the right edge.`)
      }
    }

    onProgress?.('Preparing the page…')
    const prepared = await evaluate<{ warnings: string[]; fixed: number; sticky: number }>(PREPARE_EXPRESSION, 60_000)
    prepared.warnings.forEach(warn)

    const measured = await evaluate<{ clientWidth: number; scrollWidth: number; viewportHeight: number; height: number; scrollRange: number; culprits: string[]; innerWidth: number }>(MEASURE_EXPRESSION)
    if (measured.clientWidth !== width) {
      warn(`The page laid out at ${measured.clientWidth}px instead of ${width}px; sizes below were measured at that width.`)
    }
    if (measured.scrollWidth > measured.clientWidth + 1) {
      warn(`Content overflows the page horizontally (${measured.scrollWidth}px wide in a ${measured.clientWidth}px view). Culprits: ${measured.culprits.join('; ') || 'unknown'}.`)
    }

    let documentHeight = measured.height
    let truncated = false
    const planPositions = (): number[] => {
      const usable = Math.min(documentHeight, MAX_CAPTURE_HEIGHT)
      return createCaptureScrollPositions(usable, viewportHeight, Math.max(0, usable - viewportHeight))
    }
    if (documentHeight > MAX_CAPTURE_HEIGHT) {
      truncated = true
      warn(`The page is ${documentHeight}px tall. Only the first ${MAX_CAPTURE_HEIGHT}px were captured.`)
    }
    let positions = documentHeight > viewportHeight ? planPositions() : [0]

    // --- screenshots -------------------------------------------------------------------
    let cdpFailed = options.forceFallback === true
    let usedCdp = false
    let usedFallback = false
    const shoot = async (): Promise<Buffer> => {
      if (!cdpFailed) {
        try {
          const shot: any = await withTimeout(
            lease.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }),
            CDP_SHOT_TIMEOUT_MS,
            'The screenshot timed out.',
          )
          const buffer = Buffer.from(shot.data, 'base64')
          usedCdp = true
          return buffer
        } catch (error: any) {
          cdpFailed = true
          warn(`Screenshots switched to the fallback method (${error?.message || 'error'}).`)
        }
      }
      const image = await withTimeout(
        contents.capturePage({ x: 0, y: 0, width, height: viewportHeight }, { stayHidden: true, stayAwake: true }),
        CDP_SHOT_TIMEOUT_MS,
        'The fallback screenshot timed out.',
      )
      usedFallback = true
      return image.toPNG()
    }

    const tiles: Array<{ top: number; png: Buffer; height: number }> = []
    let previousHash = ''
    for (let index = 0; index < positions.length; index++) {
      if (Date.now() - startedAt > SOFT_CAPTURE_DEADLINE_MS) {
        truncated = true
        warn('The capture ran out of time (60 seconds) and covers only the top of the page.')
        break
      }
      onProgress?.(`Capturing screen ${index + 1} of ${positions.length}…`)
      const requested = positions[index]
      const isFirst = index === 0
      const isLast = index === positions.length - 1
      const state = await evaluate<{ y: number; scrollHeight: number; maxScroll: number; clientWidth: number }>(
        `window.__qaCapture.tile(${requested}, ${isFirst}, ${isLast})`,
      )
      const resolved = resolveCaptureScrollPosition(requested, state.y, state.maxScroll)
      if (!resolved) warn(`The screen planned at ${requested}px landed at ${state.y}px (smooth scrolling or a scroll-jacking script); placed where it landed.`)
      const top = resolved ? resolved.top : state.y

      if (Math.abs(state.scrollHeight - documentHeight) > 2) {
        warn(`The page height changed while scrolling (${documentHeight}px to ${state.scrollHeight}px, usually lazy content).`)
        documentHeight = state.scrollHeight
        if (documentHeight > MAX_CAPTURE_HEIGHT && !truncated) {
          truncated = true
          warn(`The page grew past ${MAX_CAPTURE_HEIGHT}px. Only the first ${MAX_CAPTURE_HEIGHT}px were captured.`)
        }
        const replanned = planPositions().filter((position) => position > top + 1)
        positions = [...positions.slice(0, index + 1), ...replanned]
      }

      let png = await shoot()
      let meta = await sharp(png).metadata()
      if (meta.width !== width) {
        png = await sharp(png).resize({ width }).png().toBuffer()
        meta = await sharp(png).metadata()
        warn(`Screenshots were not ${width}px wide and were resized to fit.`)
      }
      const hash = createHash('sha256').update(png).digest('hex')
      if (index > 0 && hash === previousHash) {
        warn(`The screen at ${top}px repeated the previous one, so scrolling may be blocked there.`)
        previousHash = hash
        continue
      }
      previousHash = hash
      tiles.push({ top, png, height: meta.height || viewportHeight })
    }
    if (!tiles.length) throw new Error('No screenshot could be taken of the page.')

    // --- values and sections (top of the page, every fixed element visible) -------------
    onProgress?.('Reading page values…')
    await evaluate(`(() => { window.__qaCapture.showAll(); window.scrollTo(0, 0); return true })()`)
    await sleep(150)
    const values = await evaluate<any>(VALUES_EXPRESSION, 30_000)
    if (values.truncatedNodes) warn('The page has more than 2,500 styled elements; the list of values was cut at 2,500.')
    if (values.fontsFailed?.length) warn(`Fonts that failed to load: ${values.fontsFailed.join(', ')}.`)
    if (values.is404) warn('The page looks like a 404 page.')

    // --- stitch --------------------------------------------------------------------------
    const bottomOfTiles = Math.max(...tiles.map((tile) => tile.top + tile.height))
    const capturedHeight = truncated ? Math.min(bottomOfTiles, MAX_CAPTURE_HEIGHT) : Math.min(bottomOfTiles, Math.max(documentHeight, viewportHeight))
    const composites = await Promise.all(tiles.map(async (tile) => {
      const room = capturedHeight - tile.top
      const input = room < tile.height ? await sharp(tile.png).extract({ left: 0, top: 0, width, height: Math.max(1, room) }).toBuffer() : tile.png
      return { input, top: tile.top, left: 0 }
    }))
    const png = await sharp({ create: { width, height: capturedHeight, channels: 3, background: '#ffffff' } })
      .composite(composites)
      .png({ compressionLevel: 6 })
      .toBuffer()

    const sections = finalizeSections(values.blocks || [], capturedHeight)
    const nodes: LiveNode[] = (values.nodes || []).map((node: Omit<LiveNode, 'sectionId'>) => ({
      ...node,
      sectionId: node.positioned === 'fixed' ? null : sectionIdAt(sections, node.rect.y + node.rect.height / 2),
    }))

    return {
      png,
      width,
      viewportHeight,
      documentHeight,
      capturedHeight,
      truncated,
      tiles: tiles.length,
      mode: usedCdp && usedFallback ? 'mixed' : usedFallback ? 'capturePage' : 'cdp',
      finalUrl,
      title: values.title || '',
      warnings,
      sections,
      nodes,
      page: { lang: values.lang || '', viewportMeta: values.viewportMeta || '', fontsFailed: values.fontsFailed || [], bodyClass: values.bodyClass || '' },
    }
  } finally {
    try { lease.release() } catch { /* already detached */ }
    qaWindowIds.delete(contents.id)
    if (!win.isDestroyed()) win.destroy()
  }
}
