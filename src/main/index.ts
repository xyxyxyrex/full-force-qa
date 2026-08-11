import 'dotenv/config'
import { app, BrowserWindow, ipcMain, shell, session, Menu, dialog, safeStorage, webContents as electronWebContents } from 'electron'
import { join } from 'path'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import sharp from 'sharp'

const PARITY_APP_ID = 'com.fullforce.parity'

function configureParityIdentity(): void {
  app.setName('Parity')
  app.setAppUserModelId(PARITY_APP_ID)

  const appDataDir = app.getPath('appData')
  const parityUserData = join(appDataDir, 'Parity')
  if (!existsSync(parityUserData)) {
    for (const legacyName of ['QA Snapshot Editor', 'qa-snapshot-editor']) {
      const legacyUserData = join(appDataDir, legacyName)
      if (!existsSync(legacyUserData)) continue
      try {
        cpSync(legacyUserData, parityUserData, { recursive: true, errorOnExist: false })
      } catch (error) {
        console.warn('[Parity] Unable to migrate legacy application data:', error)
      }
      break
    }
  }
  app.setPath('userData', parityUserData)
}

configureParityIdentity()

// Force Chromium engine to use English locale
app.commandLine.appendSwitch('lang', 'en-US')
import { captureUrl } from './capture'
import { freezeSnapshot } from './snapshot'
import { getProjects, saveProject, deleteProject } from './store'
import { createSnapshot, getSnapshots, deleteSnapshot } from './snapshotManager.scroll-capture.v2'
import type { Project, CaptureResult } from '../shared/types'
import {
  checkForAppUpdates,
  downloadAppUpdate,
  getAppUpdateStatus,
  initializeAppUpdater,
  installAppUpdate,
} from './updater'
import { createServer } from 'http'
import { randomBytes, createHash } from 'crypto'
import nspell from 'nspell'

function figmaTokenPath() {
  return join(app.getPath('userData'), 'figma-api-token.bin')
}

function readFigmaToken(): string {
  try {
    const file = figmaTokenPath()
    if (!existsSync(file) || !safeStorage.isEncryptionAvailable()) return ''
    return safeStorage.decryptString(readFileSync(file))
  } catch { return '' }
}

function writeFigmaToken(token: string) {
  const file = figmaTokenPath()
  if (!token) { if (existsSync(file)) unlinkSync(file); return }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable on this device.')
  writeFileSync(file, safeStorage.encryptString(token.trim()))
}

function parseFigmaReference(rawUrl: string) {
  const url = new URL(rawUrl)
  const match = url.pathname.match(/\/(?:design|file|proto)\/([^/]+)/i)
  if (!match) throw new Error('Enter a valid Figma design URL.')
  const rawNode = url.searchParams.get('node-id') || ''
  return { fileKey: match[1], nodeId: rawNode ? rawNode.replace(/-/g, ':') : '' }
}

async function figmaRequest(path: string) {
  const token = readFigmaToken()
  if (!token) throw new Error('Connect a Figma personal access token first.')
  const response = await fetch(`https://api.figma.com/v1${path}`, { headers: { 'X-Figma-Token': token } })
  if (!response.ok) {
    const retryAfter = response.headers.get('retry-after')
    const upgrade = response.headers.get('x-figma-upgrade-link')
    let message = `Figma API returned ${response.status}`
    try { message = (await response.json() as any)?.err || message } catch {}
    if (retryAfter) message += `; retry after ${retryAfter}s`
    if (upgrade) message += `; ${upgrade}`
    throw new Error(message)
  }
  return response.json() as Promise<any>
}

// ── Main Process Hunspell & Harper Grammar Engines ────────────────────────
let spellCheckerInstance: any = null
let harperLinterInstance: any = null
let initPromise: Promise<void> | null = null

async function initMainSpellingAndGrammar(): Promise<void> {
  if (initPromise) return initPromise

  initPromise = new Promise(async (resolve) => {
    try {
      const dictMod: any = await import('dictionary-en')
      const dictionaryEn = typeof dictMod === 'function' ? dictMod : (dictMod.default || dictMod)
      if (typeof dictionaryEn === 'function') {
        await new Promise<void>((resDict) => {
          dictionaryEn((err: any, dict: any) => {
            if (!err && dict) {
              spellCheckerInstance = nspell(dict)
            } else if (err) {
              console.warn('[Main] dictionary-en error:', err)
            }
            resDict()
          })
        })
      }
    } catch (e) {
      console.warn('[Main] Error loading Hunspell dictionary:', e)
    }

    try {
      const harperMod: any = await import('harper.js')
      const LinterClass = harperMod.Linter || (harperMod.default ? harperMod.default.Linter : null)
      if (LinterClass) {
        harperLinterInstance = new LinterClass()
      }
    } catch (e) {
      console.warn('[Main] Error loading Harper Linter:', e)
    }

    resolve()
  })

  return initPromise
}

initMainSpellingAndGrammar()

// ── Monday.com OAuth config ─────────────────────────────────────────────────
// Fallback credentials embedded into app binary so .env is optional for workmates.
const MONDAY_CLIENT_ID = process.env.MONDAY_CLIENT_ID || 'b6cd67a1a413aa17b37e199e14457abe'
const MONDAY_CLIENT_SECRET = process.env.MONDAY_CLIENT_SECRET || '0fc952701f9fdb347279fc04bd9bf2d1'
const MONDAY_REDIRECT_PORT = 51847 // arbitrary high port for localhost callback
const MONDAY_REDIRECT_URI = `http://localhost:${MONDAY_REDIRECT_PORT}/oauth/callback`

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  // Completely remove default File, Edit, View, Window, Help application menu bar
  Menu.setApplicationMenu(null)

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 600,
    title: 'Parity',
    backgroundColor: '#151a18',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#1c2321',
      symbolColor: '#edefee',
      height: 38
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Disable CORS so GrapesJS iframe can load cross-origin fonts
      // (eicons, Font Awesome, etc. from captured sites)
      webSecurity: false,
      webviewTag: true
    }
  })

  // Relax headers only for resources requested by the app renderer and its
  // captured srcDoc iframe. Mutating every response in the default session
  // also affected real Edit/Live webviews and duplicated CDN CORS headers
  // (eg. "*, *"), which Chromium correctly rejects.
  session.defaultSession.webRequest.onHeadersReceived({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    if (!mainWindow || details.webContentsId !== mainWindow.webContents.id) {
      callback({})
      return
    }
    const responseHeaders = { ...details.responseHeaders }
    for (const header of Object.keys(responseHeaders)) {
      const normalized = header.toLowerCase()
      if (normalized === 'x-frame-options' || normalized === 'content-security-policy' || normalized === 'access-control-allow-origin') {
        delete responseHeaders[header]
      }
    }
    // Ensure all responses allow cross-origin access from the srcDoc iframe
    responseHeaders['Access-Control-Allow-Origin'] = ['*']
    callback({ responseHeaders })
  })

  // Intercept popup windows to ensure child windows inherit Chrome User-Agent for Google Sign-In
  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'allow' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Enable popups and DevTools shortcuts without modifying Chromium's native
// request fingerprint. Individual OAuth windows can opt into a specific UA.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => {
    return { action: 'allow' }
  })

  // Restore Ctrl+Shift+I / F12 (DevTools) and Ctrl+R / F5 (Reload) since Menu.setApplicationMenu(null) removes default shortcuts
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return

    const key = input.key.toLowerCase()
    const isToggleDevTools =
      (input.control && input.shift && key === 'i') ||
      (input.meta && input.alt && key === 'i') ||
      key === 'f12'

    const isReload =
      (input.control && key === 'r') ||
      (input.meta && key === 'r') ||
      key === 'f5'

    if (input.key === 'Escape') {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('global-escape-pressed')
      }
    }

    if (isToggleDevTools) {
      if (contents.isDevToolsOpened()) {
        contents.closeDevTools()
      } else {
        contents.openDevTools({ mode: 'detach' })
      }
      event.preventDefault()
    } else if (isReload) {
      event.preventDefault()
      // A true hard refresh for both the app shell and embedded staging
      // webviews. Cookies are intentionally retained so WordPress sessions
      // survive; only HTTP cache, service workers and Cache Storage are reset.
      void Promise.all([
        contents.session.clearCache(),
        contents.session.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] })
      ]).finally(() => {
        if (!contents.isDestroyed()) contents.reloadIgnoringCache()
      })
    }
  })
})

// ── PKCE helpers ────────────────────────────────────────────────────────────
function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url')
}

function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

let activeOAuthServer: any = null

process.on('uncaughtException', (error) => {
  console.error('[Main process uncaught exception]:', error)
})

const AUTOMATE_DOM_EXPRESSION = `(() => {
  const selectors = 'h1,h2,h3,h4,h5,h6,p,a,button,label,li,span,div,dt,dd,summary,figcaption,th,td,img,input,section,article,header,footer,nav,main';
  const semanticTextSelector = 'h1,h2,h3,h4,h5,h6,p,a,button,label,li,span,dt,dd,summary,figcaption,th,td';
  const directSemanticSelector = semanticTextSelector.split(',').map((selector) => ':scope > ' + selector).join(',');
  const root = document.documentElement; const body = document.body;
  const pageHeight = Math.max(root.scrollHeight, root.offsetHeight, body?.scrollHeight || 0, body?.offsetHeight || 0);
  const pageWidth = Math.max(root.scrollWidth, body?.scrollWidth || 0);
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
  const nodes = Array.from(document.querySelectorAll(selectors)).map((element) => {
    const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
    const positioned = style.position === 'fixed' || style.position === 'sticky';
    const pageX = positioned ? rect.left : rect.left + scrollX;
    const pageY = positioned ? rect.top : rect.top + scrollY;
    return { tag: element.tagName.toLowerCase(), role: element.getAttribute('role') || '', text: elementText(element).slice(0, 500), src: element.tagName === 'IMG' ? element.currentSrc || element.src : '', context: contextFor(element), path: pathFor(element), rect: { x: pageX, y: pageY, width: rect.width, height: rect.height }, styles: { fontSize: style.fontSize, fontFamily: style.fontFamily, fontWeight: style.fontWeight, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, color: style.color, backgroundColor: style.backgroundColor, textAlign: style.textAlign, position: style.position } };
  }).filter((item) => item.rect.width > 1 && item.rect.height > 1 && item.rect.x > -item.rect.width && item.rect.x < pageWidth + item.rect.width && item.rect.y > -item.rect.height && item.rect.y < pageHeight + item.rect.height);
  return { nodes, pageWidth: Math.ceil(pageWidth), pageHeight: Math.ceil(pageHeight) };
})()`

async function captureAutomatePage(webContentsId: number, viewportWidth: number, viewportHeight: number) {
  const target = electronWebContents.fromId(webContentsId)
  if (!target || target.isDestroyed()) throw new Error('The staging capture browser is no longer available.')
  const debug = target.debugger
  const attachedHere = !debug.isAttached()
  if (attachedHere) debug.attach('1.3')
  try {
    const width = Math.max(320, Math.round(viewportWidth))
    // Keep the emulated surface below the host webview's physical height. Some
    // Electron/Windows combinations return a blank tail when asked for 1200px.
    const tileHeight = Math.max(320, Math.min(1000, Math.round(viewportHeight)))
    await debug.sendCommand('Page.enable')
    await debug.sendCommand('Emulation.setDeviceMetricsOverride', { width, height: tileHeight, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: tileHeight })
    await debug.sendCommand('Runtime.evaluate', { expression: `(() => { const animations = document.getAnimations().map((animation) => ({ animation, playState: animation.playState })); for (const item of animations) item.animation.pause(); const positioned = []; for (const element of document.body?.querySelectorAll('*') || []) { const position = getComputedStyle(element).position; if (position === 'fixed' || position === 'sticky') positioned.push({ element, visibility: element.style.visibility }); } window.__qaAutomateAtomicState = { x: scrollX, y: scrollY, animations, positioned, scrollBehavior: document.documentElement.style.scrollBehavior }; document.documentElement.style.setProperty('scroll-behavior','auto','important'); scrollTo(0,0); return document.readyState; })()`, awaitPromise: true })
    await new Promise((resolve) => setTimeout(resolve, 220))
    const measured = await debug.sendCommand('Runtime.evaluate', { expression: `(() => ({ width: Math.ceil(Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0)), height: Math.ceil(Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0)) }))()`, returnByValue: true })
    const documentWidth = Math.max(width, Number(measured?.result?.value?.width || width)); const documentHeight = Math.max(tileHeight, Number(measured?.result?.value?.height || tileHeight))
    if (width * documentHeight > 45_000_000 || documentHeight > 24000) throw new Error('The page exceeds the verified Chromium tile limit.')
    const positions: number[] = []
    const overlap = Math.min(180, Math.max(64, Math.round(tileHeight * .12)))
    const stride = Math.max(1, tileHeight - overlap)
    for (let y = 0; y < documentHeight; y += stride) positions.push(Math.min(y, Math.max(0, documentHeight - tileHeight)))
    const uniquePositions = Array.from(new Set(positions)); const composites: Array<{ input: Buffer; top: number; left: number }> = []
    let previousHash = ''; let consecutiveDuplicates = 0
    for (let index = 0; index < uniquePositions.length; index++) {
      const y = uniquePositions[index]
      const positionedVisibility = y === 0 ? 'item.visibility' : "'hidden'"
      const positioned = await debug.sendCommand('Runtime.evaluate', { expression: `(async () => { const state = window.__qaAutomateAtomicState; for (const item of state?.positioned || []) item.element.style.visibility = ${positionedVisibility}; document.documentElement.style.setProperty('scroll-behavior','auto','important'); scrollTo(0,${y}); document.documentElement.scrollTop=${y}; if (document.body) document.body.scrollTop=${y}; await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); return { y: scrollY, rootY: document.documentElement.scrollTop, bodyY: document.body?.scrollTop || 0 }; })()`, returnByValue: true, awaitPromise: true })
      const actual = Math.max(Number(positioned?.result?.value?.y || 0), Number(positioned?.result?.value?.rootY || 0), Number(positioned?.result?.value?.bodyY || 0))
      if (Math.abs(actual - y) > 3) throw new Error(`DevTools Chromium stopped at ${Math.round(actual)}px instead of tile ${index + 1} at ${y}px.`)
      const screenshot = await debug.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false, optimizeForSpeed: true })
      const tile = Buffer.from(screenshot.data, 'base64'); const hash = createHash('sha256').update(tile).digest('hex')
      if (index > 0 && hash === previousHash) consecutiveDuplicates++; else consecutiveDuplicates = 0
      if (consecutiveDuplicates >= 1) throw new Error(`Chromium returned a repeated DevTools tile at ${y}px.`)
      previousHash = hash; composites.push({ input: tile, top: y, left: 0 })
    }
    // Scan only after the full scroll pass so lazy-rendered footer and below-fold
    // elements participate in semantic matching. Coordinates are document-relative.
    const semantic = await debug.sendCommand('Runtime.evaluate', { expression: AUTOMATE_DOM_EXPRESSION, returnByValue: true })
    const stitched = await sharp({ create: { width, height: documentHeight, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).composite(composites).png({ compressionLevel: 6 }).toBuffer()
    return { success: true, dataUrl: `data:image/png;base64,${stitched.toString('base64')}`, documentWidth, documentHeight, domNodes: semantic?.result?.value?.nodes || [], tiles: uniquePositions.length, mode: 'verified-cdp-tiles' }
  } finally {
    try {
      await debug.sendCommand('Runtime.evaluate', { expression: `(() => { const state = window.__qaAutomateAtomicState; if (state) { for (const item of state.positioned || []) item.element.style.visibility = item.visibility; document.documentElement.style.scrollBehavior = state.scrollBehavior; scrollTo(state.x, state.y); for (const item of state.animations || []) { if (item.playState === 'running') item.animation.play(); } } delete window.__qaAutomateAtomicState; })()` })
    } catch {}
    try { await debug.sendCommand('Emulation.clearDeviceMetricsOverride') } catch {}
    if (attachedHere && debug.isAttached()) debug.detach()
  }
}

const activeVisualWorkers = new Map<string, ReturnType<typeof spawn>>()

function runVisualWorker(jobId: string, designDataUrl: string, liveDataUrl: string, anchors?: Array<{ designY: number; liveY: number; confidence?: number }>, mode: string = 'visual-surface'): Promise<any> {
  return new Promise((resolve) => {
    const workDirectory = mkdtempSync(join(tmpdir(), 'qa-visual-'))
    const designPath = join(workDirectory, 'design.png'); const livePath = join(workDirectory, 'live.png')
    const decode = (dataUrl: string) => Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
    writeFileSync(designPath, decode(designDataUrl)); writeFileSync(livePath, decode(liveDataUrl))
    
    let anchorsPath = ''
    if (Array.isArray(anchors) && anchors.length > 0) {
      anchorsPath = join(workDirectory, 'anchors.json')
      writeFileSync(anchorsPath, JSON.stringify(anchors))
    }

    const packagedExecutable = join(process.resourcesPath, 'visual-worker', process.platform === 'win32' ? 'visual-compare.exe' : 'visual-compare')
    const workerScript = join(app.getAppPath(), 'python', 'visual_compare.py')
    const command = app.isPackaged && existsSync(packagedExecutable) ? packagedExecutable : (process.env.QA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'))
    const args = command === packagedExecutable
      ? (anchorsPath ? ['--design', designPath, '--live', livePath, '--anchors', anchorsPath, '--mode', mode] : ['--design', designPath, '--live', livePath, '--mode', mode])
      : (anchorsPath ? [workerScript, '--design', designPath, '--live', livePath, '--anchors', anchorsPath, '--mode', mode] : [workerScript, '--design', designPath, '--live', livePath, '--mode', mode])
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    activeVisualWorkers.set(jobId, child)
    let stdout = ''; let stderr = ''; let settled = false
    const finish = (result: any) => { if (settled) return; settled = true; clearTimeout(timeout); if (activeVisualWorkers.get(jobId) === child) activeVisualWorkers.delete(jobId); try { rmSync(workDirectory, { recursive: true, force: true }) } catch {}; resolve(result) }
    const timeout = setTimeout(() => { child.kill(); finish({ success: false, error: 'The OpenCV comparison worker exceeded 90 seconds.', fallback: true }) }, 90_000)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (error) => finish({ success: false, error: error.message, fallback: true }))
    child.on('close', () => {
      try { finish(JSON.parse(stdout.trim())) } catch { finish({ success: false, error: stderr.trim() || 'The visual worker returned an unreadable response.', fallback: true }) }
    })
  })
}

function registerIpcHandlers(): void {
  // Auth: open a visible window so the user can log into wp-admin
  ipcMain.handle('auth:login', async (_event, adminUrl: string): Promise<void> => {
    return new Promise<void>((resolve) => {
      const loginWindow = new BrowserWindow({
        width: 1024,
        height: 768,
        title: 'WordPress Login',
        parent: mainWindow!,
        modal: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true
        }
      })

      loginWindow.loadURL(adminUrl)

      loginWindow.webContents.on('did-navigate', async (_e, url) => {
        if (url.includes('wp-admin') && !url.includes('wp-login')) {
          try { await session.defaultSession.cookies.flushStore() } catch { }
          setTimeout(async () => {
            try { await session.defaultSession.cookies.flushStore() } catch { }
            if (!loginWindow.isDestroyed()) loginWindow.close()
          }, 1000)
        }
      })

      loginWindow.on('closed', async () => {
        try { await session.defaultSession.cookies.flushStore() } catch { }
        resolve()
      })
    })
  })

  // App: Clear Chromium disk & memory HTTP cache
  ipcMain.handle('app:clear-cache', async (): Promise<{ success: boolean }> => {
    try {
      await Promise.all([
        session.defaultSession.clearCache(),
        session.defaultSession.clearStorageData({
          storages: ['serviceworkers', 'cachestorage']
        })
      ])
      return { success: true }
    } catch (e) {
      console.error('[Cache] Error clearing cache:', e)
      return { success: false }
    }
  })

  // Figma Login Window: Uses standard Chrome User-Agent so Google Accounts OAuth works cleanly inside Electron
  ipcMain.handle('app:figmaLoginWindow', async (_event, figmaUrl?: string): Promise<void> => {
    return new Promise<void>((resolve) => {
      const figmaSess = session.fromPartition('persist:figma')
      const chromeUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
      const loginWin = new BrowserWindow({
        width: 1024,
        height: 768,
        title: 'Sign in to Figma',
        parent: mainWindow!,
        backgroundColor: '#181818',
        autoHideMenuBar: true,
        webPreferences: {
          partition: 'persist:figma',
          nodeIntegration: false,
          contextIsolation: true,
          webSecurity: false
        }
      })

      loginWin.webContents.setUserAgent(chromeUa)

      const targetUrl = figmaUrl
        ? `https://www.figma.com/login?redirect_to=${encodeURIComponent(figmaUrl)}`
        : 'https://www.figma.com/login'

      loginWin.loadURL(targetUrl)

      let closeTimeout: NodeJS.Timeout | null = null

      const checkAuthStatus = async (url: string) => {
        if (url.includes('figma.com/file') || url.includes('figma.com/design') || url.includes('figma.com/files') || url.includes('figma.com/board')) {
          if (closeTimeout) clearTimeout(closeTimeout)
          closeTimeout = setTimeout(async () => {
            try { await figmaSess.cookies.flushStore() } catch { }
            try {
              if (!loginWin.isDestroyed()) loginWin.close()
            } catch { }
          }, 3000)
        }
      }

      loginWin.webContents.on('did-navigate', (_e, url) => checkAuthStatus(url))
      loginWin.webContents.on('did-navigate-in-page', (_e, url) => checkAuthStatus(url))

      loginWin.on('closed', async () => {
        if (closeTimeout) clearTimeout(closeTimeout)
        try { await figmaSess.cookies.flushStore() } catch { }
        resolve()
      })
    })
  })

  ipcMain.handle('figma:token-status', () => ({ configured: !!readFigmaToken() }))

  ipcMain.handle('figma:set-token', async (_event, token: string) => {
    try {
      writeFigmaToken(token || '')
      return { success: true, configured: !!token }
    } catch (error: any) {
      return { success: false, configured: false, error: error?.message || 'Unable to validate the Figma token.' }
    }
  })

  ipcMain.handle('figma:list-frames', async (_event, rawUrl: string) => {
    try {
      const { fileKey, nodeId } = parseFigmaReference(rawUrl)
      const file = await figmaRequest(`/files/${encodeURIComponent(fileKey)}?depth=2`)
      const frames: any[] = []
      for (const page of file.document?.children || []) {
        for (const node of page.children || []) {
          const box = node.absoluteBoundingBox || {}
          if (['FRAME', 'COMPONENT', 'SECTION'].includes(node.type) && box.width && box.height) {
            frames.push({ id: node.id, name: node.name || 'Untitled frame', type: node.type, pageName: page.name || '', width: Math.round(box.width), height: Math.round(box.height) })
          }
        }
      }
      return { success: true, fileName: file.name || 'Figma design', lastModified: file.lastModified || '', requestedNodeId: nodeId, frames }
    } catch (error: any) {
      return { success: false, error: error?.message || 'Unable to load Figma frames.' }
    }
  })

  ipcMain.handle('figma:get-frame', async (_event, rawUrl: string, selectedNodeId?: string) => {
    try {
      const { fileKey, nodeId } = parseFigmaReference(rawUrl)
      const targetId = selectedNodeId || nodeId
      if (!targetId) throw new Error('Select a Figma frame to compare.')
      const [nodes, images] = await Promise.all([
        figmaRequest(`/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(targetId)}`),
        figmaRequest(`/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(targetId)}&format=png&scale=1`)
      ])
      const node = nodes.nodes?.[targetId]?.document
      const imageUrl = images.images?.[targetId]
      if (!node || !imageUrl) throw new Error('Figma could not render the selected frame.')
      const imageResponse = await fetch(imageUrl)
      if (!imageResponse.ok) throw new Error(`Unable to download the rendered Figma frame (${imageResponse.status}).`)
      const mime = imageResponse.headers.get('content-type') || 'image/png'
      const bytes = Buffer.from(await imageResponse.arrayBuffer())
      return { success: true, node, imageDataUrl: `data:${mime};base64,${bytes.toString('base64')}` }
    } catch (error: any) {
      return { success: false, error: error?.message || 'Unable to load the selected Figma frame.' }
    }
  })

  ipcMain.handle('automate:capture-page', async (_event, webContentsId: number, viewportWidth: number, viewportHeight: number) => {
    try { return await captureAutomatePage(Number(webContentsId), Number(viewportWidth), Number(viewportHeight)) }
    catch (error: any) { return { success: false, error: error?.message || 'Atomic Chromium capture failed.', fallback: true } }
  })

  ipcMain.handle('automate:visual-compare', async (_event, jobId: string, designDataUrl: string, liveDataUrl: string, anchors?: Array<{ designY: number; liveY: number; confidence?: number }>, mode?: string) => {
    if (!designDataUrl?.startsWith('data:image/') || !liveDataUrl?.startsWith('data:image/')) return { success: false, error: 'The visual worker requires two image data URLs.', fallback: true }
    return runVisualWorker(jobId, designDataUrl, liveDataUrl, anchors, mode)
  })

  ipcMain.handle('automate:visual-cancel', (_event, jobId: string) => {
    const child = activeVisualWorkers.get(jobId)
    if (child) { child.kill(); activeVisualWorkers.delete(jobId); return { success: true } }
    return { success: false }
  })

  ipcMain.handle('app:toggleMaximizeWindow', async (): Promise<void> => {
    if (mainWindow) {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize()
      } else {
        mainWindow.maximize()
      }
    }
  })

  ipcMain.handle('app:update-status', () => getAppUpdateStatus())
  ipcMain.handle('app:update-check', () => checkForAppUpdates())
  ipcMain.handle('app:update-download', () => downloadAppUpdate())
  ipcMain.handle('app:update-install', () => installAppUpdate())

  ipcMain.handle('app:openExternal', async (_event, url: string): Promise<void> => {
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
      shell.openExternal(url)
    }
  })

  ipcMain.handle('app:openDetachedWindow', async (_event, url: string, title?: string): Promise<void> => {
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
      let targetUrl = url.trim()
      if (targetUrl.includes('docs.google.com/spreadsheets')) {
        if (targetUrl.includes('hl=')) {
          targetUrl = targetUrl.replace(/hl=[a-zA-Z-]+/g, 'hl=en')
        } else {
          const sep = targetUrl.includes('?') ? '&' : '?'
          targetUrl = `${targetUrl}${sep}hl=en`
        }
      }

      const detachedWindow = new BrowserWindow({
        width: 1280,
        height: 850,
        title: title || 'QA Master Tracker',
        backgroundColor: '#181818',
        autoHideMenuBar: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          webSecurity: false
        }
      })
      detachedWindow.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')
      detachedWindow.setMenu(null)
      detachedWindow.loadURL(targetUrl)
    }
  })

  ipcMain.handle('app:runGrammarSpellAudit', async (_event, items: Array<{ id: string; tag: string; text: string; index: number }>) => {
    await initMainSpellingAndGrammar()
    const issues: any[] = []
    if (!Array.isArray(items)) return { totalIssues: 0, spellingCount: 0, grammarCount: 0, issues: [] }

    let globalIdx = 0

    for (const item of items) {
      const { text, tag, index: elementIdx } = item
      if (!text || text.length < 3) continue
      const snippet = text.length > 50 ? text.slice(0, 50) + '...' : text

      // 1. Harper Grammar Engine
      if (harperLinterInstance) {
        try {
          const lintResults = await harperLinterInstance.lint(text)
          if (Array.isArray(lintResults)) {
            for (const res of lintResults) {
              let msg = typeof res.message === 'function' ? res.message() : (res as any).message || 'Grammar issue'
              let phrase = ''
              if (typeof res.span === 'function') {
                const span = res.span()
                if (span && typeof span.start === 'number' && typeof span.end === 'number') {
                  phrase = text.slice(span.start, span.end)
                }
              }
              if (!phrase) phrase = text.length > 30 ? text.slice(0, 30) : text

              let sugStr: string | undefined = undefined
              if (typeof res.suggestions === 'function') {
                const sugs = res.suggestions()
                if (Array.isArray(sugs) && sugs.length > 0) {
                  sugStr = sugs.map((s: any) => (typeof s === 'string' ? s : s.replacement_text ? s.replacement_text() : String(s))).join(', ')
                }
              }

              globalIdx++
              issues.push({
                id: `g_${globalIdx}_${elementIdx}`,
                type: 'grammar',
                wordOrPhrase: phrase || text,
                suggestion: sugStr,
                message: msg,
                elementTag: tag,
                elementSnippet: snippet,
                elementIndex: elementIdx,
                fullText: text
              })
            }
          }
        } catch (e) { }
      }

      // 2. Hunspell Spelling Engine
      if (spellCheckerInstance) {
        const words = text.split(/[\s,.:;!?"'()\[\]{}–—\/\\]+/)
        words.forEach((rawWord) => {
          const cleanWord = rawWord.replace(/^[^a-zA-Z']+|[^a-zA-Z']+$/g, '')
          if (!cleanWord || cleanWord.length < 3) return
          if (/^[0-9]/.test(cleanWord) || cleanWord.length > 30) return

          try {
            const isCorrect = spellCheckerInstance.correct(cleanWord) || spellCheckerInstance.correct(cleanWord.toLowerCase())
            if (!isCorrect) {
              const alreadyExists = issues.some(
                (i) => i.elementIndex === elementIdx && i.wordOrPhrase.toLowerCase() === cleanWord.toLowerCase()
              )
              if (!alreadyExists) {
                const suggestions = spellCheckerInstance.suggest(cleanWord) || spellCheckerInstance.suggest(cleanWord.toLowerCase()) || []
                const sugStr = suggestions.length > 0 ? suggestions.slice(0, 3).join(', ') : undefined
                globalIdx++
                issues.push({
                  id: `s_${globalIdx}_${elementIdx}`,
                  type: 'spelling',
                  wordOrPhrase: cleanWord,
                  suggestion: sugStr,
                  message: `Misspelled word: "${cleanWord}"`,
                  elementTag: tag,
                  elementSnippet: snippet,
                  elementIndex: elementIdx,
                  fullText: text
                })
              }
            }
          } catch (_) { }
        })
      }
    }

    const spellingCount = issues.filter((i) => i.type === 'spelling').length
    const grammarCount = issues.filter((i) => i.type === 'grammar').length

    return {
      totalIssues: issues.length,
      spellingCount,
      grammarCount,
      issues
    }
  })

  // ── Monday.com OAuth: System default browser + localhost callback + PKCE ───────
  ipcMain.handle('monday:login', async (): Promise<{ success: boolean; token?: string; error?: string }> => {
    // Guard: client ID must be configured
    if (!MONDAY_CLIENT_ID) {
      return {
        success: false,
        error: 'MONDAY_CLIENT_ID is not configured.'
      }
    }

    // Close any previous OAuth callback server if still listening
    if (activeOAuthServer) {
      try { activeOAuthServer.close() } catch { }
      activeOAuthServer = null
    }

    const codeVerifier = generateCodeVerifier()
    const codeChallenge = generateCodeChallenge(codeVerifier)

    return new Promise((resolve) => {
      let resolved = false

      // 1. Spin up a one-shot HTTP server to catch the OAuth redirect
      const server = createServer(async (req, res) => {
        if (resolved) { res.end(); return }

        const url = new URL(req.url || '/', `http://localhost:${MONDAY_REDIRECT_PORT}`)
        if (!url.pathname.startsWith('/oauth/callback')) { res.end(); return }

        const code = url.searchParams.get('code')
        const error = url.searchParams.get('error')

        if (error || !code) {
          resolved = true
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#18181b;color:#a1a1aa"><h2 style="color:#ef4444">Login Cancelled</h2><p>You can close this tab and return to the app.</p></body></html>')
          activeOAuthServer = null
          try { server.close() } catch { }
          resolve({ success: false, error: error || 'No authorization code received' })
          return
        }

        // 2. Exchange the authorization code for an access token
        try {
          const tokenRes = await fetch('https://auth.monday.com/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              grant_type: 'authorization_code',
              client_id: MONDAY_CLIENT_ID,
              client_secret: MONDAY_CLIENT_SECRET,
              code,
              redirect_uri: MONDAY_REDIRECT_URI,
              code_verifier: codeVerifier
            })
          })

          const tokenData = await tokenRes.json()

          if (tokenData.access_token) {
            resolved = true
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end('<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#18181b;color:#f4f4f5"><h2 style="color:#10b981;font-size:24px">✓ Connected to Monday.com</h2><p style="color:#a1a1aa">Authentication successful! You can close this browser tab and return to the app.</p></body></html>')
            activeOAuthServer = null
            try { server.close() } catch { }
            resolve({ success: true, token: tokenData.access_token })
          } else {
            resolved = true
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end('<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#18181b;color:#f4f4f5"><h2 style="color:#ef4444">Token Exchange Failed</h2><p>Please try again in the app.</p></body></html>')
            activeOAuthServer = null
            try { server.close() } catch { }
            resolve({ success: false, error: tokenData.error || 'Token exchange failed' })
          }
        } catch (err) {
          resolved = true
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#18181b;color:#f4f4f5"><h2>Connection Error</h2></body></html>')
          activeOAuthServer = null
          try { server.close() } catch { }
          resolve({ success: false, error: (err as Error).message })
        }
      })

      activeOAuthServer = server

      // Catch EADDRINUSE or server start errors gracefully
      server.on('error', (err: any) => {
        console.error('[Monday Auth] Server error:', err)
        if (!resolved) {
          resolved = true
          activeOAuthServer = null
          try { server.close() } catch { }
          if (err.code === 'EADDRINUSE') {
            resolve({
              success: false,
              error: 'Port 51847 is currently busy. Please try clicking Connect again.'
            })
          } else {
            resolve({
              success: false,
              error: `Server error: ${err.message}`
            })
          }
        }
      })

      // Start listening on redirect port
      try {
        server.listen(MONDAY_REDIRECT_PORT, '127.0.0.1')
      } catch (e) {
        console.error('[Monday Auth] Listen failed:', e)
      }

      // Build exact Monday OAuth Authorization URL
      const authUrl = new URL('https://auth.monday.com/oauth2/authorize')
      authUrl.searchParams.set('client_id', MONDAY_CLIENT_ID)
      authUrl.searchParams.set('redirect_uri', MONDAY_REDIRECT_URI)
      authUrl.searchParams.set('response_type', 'code')
      authUrl.searchParams.set('code_challenge', codeChallenge)
      authUrl.searchParams.set('code_challenge_method', 'S256')

      const url = authUrl.toString()

      // Open in default system browser ONCE (uses active Monday.com session)
      shell.openExternal(url).catch((err) => {
        console.error('[Monday Auth] Failed to open external browser:', err)
      })

      // Timeout: auto-close after 3 minutes if user never completes OAuth in browser
      setTimeout(() => {
        if (!resolved) {
          resolved = true
          activeOAuthServer = null
          try { server.close() } catch { }
          resolve({ success: false, error: 'Login timed out' })
        }
      }, 3 * 60 * 1000)
    })
  })

  // Capture: fetch + freeze a staging page
  ipcMain.handle('capture:start', async (_event, url: string): Promise<CaptureResult> => {
    try {
      try {
        await session.defaultSession.clearCache()
      } catch {}
      const rawHtml = await captureUrl(url)
      const frozenHtml = freezeSnapshot(rawHtml, url)
      return { success: true, html: frozenHtml }
    } catch (error) {
      const msg = (error as Error).message || ''
      const is404 = msg.includes('SESSION_EXPIRED_404') || msg.includes('404')
      return {
        success: false,
        error: msg,
        is404,
        isSessionExpired: is404
      }
    }
  })

  // Projects: CRUD
  ipcMain.handle('projects:list', () => getProjects())
  ipcMain.handle('projects:save', (_event, project: Project) => saveProject(project))
  ipcMain.handle('projects:delete', (_event, id: string) => deleteProject(id))

  // Snapshots: CRUD
  ipcMain.handle('snapshot:create', (_event, params) => createSnapshot(params))
  ipcMain.handle('snapshot:list', (_event, projectId: string) => getSnapshots(projectId))
  ipcMain.handle('snapshot:delete', (_event, snapshotId: string) => deleteSnapshot(snapshotId))

  // Settings: Select Directory Dialog
  ipcMain.handle('settings:select-directory', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return { success: false }
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Snapshot Storage Directory',
      properties: ['openDirectory', 'createDirectory']
    })
    if (!res.canceled && res.filePaths.length > 0) {
      return { success: true, path: res.filePaths[0] }
    }
    return { success: false }
  })
}

app.whenReady().then(() => {
  registerIpcHandlers()
  createWindow()
  initializeAppUpdater(() => mainWindow)
})

app.on('window-all-closed', () => {
  app.quit()
})

