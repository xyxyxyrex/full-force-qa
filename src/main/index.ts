import 'dotenv/config'
import { app, BrowserWindow, ipcMain, shell, session, Menu } from 'electron'
import { join } from 'path'

// Force Chromium engine to use English locale
app.commandLine.appendSwitch('lang', 'en-US')
import { captureUrl } from './capture'
import { freezeSnapshot } from './snapshot'
import { getProjects, saveProject, deleteProject } from './store'
import { createSnapshot, getSnapshots, deleteSnapshot } from './snapshotManager.scroll-capture.v2'
import type { Project, CaptureResult } from '../shared/types'
import { createServer } from 'http'
import { randomBytes, createHash } from 'crypto'
import nspell from 'nspell'

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
              console.log('[Main] Hunspell dictionary loaded successfully!')
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
        console.log('[Main] Harper Grammar Linter loaded successfully!')
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
    backgroundColor: '#1a1a1a',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#1a1a1a',
      symbolColor: '#a1a1aa',
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

  // Set standard Chrome User-Agent on default session so Google OAuth works in webviews
  session.defaultSession.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')

  // Strip X-Frame-Options and Content-Security-Policy to allow embedding Figma
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders }
    delete responseHeaders['x-frame-options']
    delete responseHeaders['X-Frame-Options']
    delete responseHeaders['content-security-policy']
    delete responseHeaders['Content-Security-Policy']
    callback({ responseHeaders })
  })

  // Enforce English Accept-Language on all outbound HTTP requests (forces Google Sheets / OAuth to load in English)
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const requestHeaders = { ...details.requestHeaders }
    requestHeaders['Accept-Language'] = 'en-US,en;q=0.9'
    callback({ requestHeaders })
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

// Ensure all web contents (popups, webviews, child windows) use Chrome User-Agent and enable DevTools shortcuts
app.on('web-contents-created', (_event, contents) => {
  contents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')
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
      contents.reload()
      event.preventDefault()
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

  ipcMain.handle('app:toggleMaximizeWindow', async (): Promise<void> => {
    if (mainWindow) {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize()
      } else {
        mainWindow.maximize()
      }
    }
  })

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

  // ── Monday.com OAuth: System browser + localhost callback + PKCE ───────
  ipcMain.handle('monday:login', async (): Promise<{ success: boolean; token?: string; error?: string }> => {
    // Guard: client ID must be configured
    if (!MONDAY_CLIENT_ID) {
      return {
        success: false,
        error: 'MONDAY_CLIENT_ID is not configured. See setup guide in the artifact.'
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
      let authWin: BrowserWindow | null = null

      const closeAuthWin = () => {
        if (authWin && !authWin.isDestroyed()) {
          try { authWin.close() } catch { }
          authWin = null
        }
      }

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
          res.end('<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Login cancelled</h2><p>You can close this window.</p></body></html>')
          activeOAuthServer = null
          setTimeout(closeAuthWin, 1000)
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
            res.end('<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#1a1a1a;color:#e0e0e0"><h2 style="color:#3fb950">✓ Connected to Monday.com</h2><p>You can close this tab and return to the app.</p></body></html>')
            activeOAuthServer = null
            setTimeout(closeAuthWin, 1000)
            try { server.close() } catch { }
            resolve({ success: true, token: tokenData.access_token })
          } else {
            resolved = true
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end('<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Token exchange failed</h2><p>Please try again.</p></body></html>')
            activeOAuthServer = null
            setTimeout(closeAuthWin, 1500)
            try { server.close() } catch { }
            resolve({ success: false, error: tokenData.error || 'Token exchange failed' })
          }
        } catch (err) {
          resolved = true
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Connection error</h2></body></html>')
          activeOAuthServer = null
          setTimeout(closeAuthWin, 1500)
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
          closeAuthWin()
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

      // Build OAuth authorization URL forcing existing account login
      const authUrl = new URL('https://auth.monday.com/oauth2/authorize')
      authUrl.searchParams.set('client_id', MONDAY_CLIENT_ID)
      authUrl.searchParams.set('redirect_uri', MONDAY_REDIRECT_URI)
      authUrl.searchParams.set('response_type', 'code')
      authUrl.searchParams.set('code_challenge', codeChallenge)
      authUrl.searchParams.set('code_challenge_method', 'S256')
      authUrl.searchParams.set('force_existing_account', 'true')

      const url = authUrl.toString()

      // Create dedicated in-app Electron auth popup window
      authWin = new BrowserWindow({
        width: 1020,
        height: 760,
        title: 'Authorize QA Snapshot Editor - Monday.com',
        show: true,
        center: true,
        backgroundColor: '#1a1a1a',
        autoHideMenuBar: true,
        webPreferences: {
          session: session.defaultSession,
          nodeIntegration: false,
          contextIsolation: true,
          webSecurity: false
        }
      })

      authWin.setMenu(null)
      authWin.webContents.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      )

      // Auto-switch to Log In view whenever Monday attempts to navigate or load Sign Up page
      const redirectIfSignUp = (targetUrl: string) => {
        if (targetUrl.includes('/users/sign_up')) {
          const loginUrl = targetUrl.replace('/users/sign_up', '/users/sign_in')
          console.log('[Monday Auth] Intercepted /users/sign_up, redirecting to /users/sign_in:', loginUrl)
          authWin?.loadURL(loginUrl).catch(() => { })
          return true
        }
        return false
      }

      authWin.webContents.on('will-navigate', (event, navUrl) => {
        if (redirectIfSignUp(navUrl)) {
          event.preventDefault()
        }
      })

      authWin.webContents.on('did-navigate', (_event, navUrl) => {
        redirectIfSignUp(navUrl)
      })

      const injectLoginScript = () => {
        authWin?.webContents.executeJavaScript(`
          (() => {
            try {
              if (window.location.href.includes('/users/sign_up')) {
                window.location.href = window.location.href.replace('/users/sign_up', '/users/sign_in');
                return;
              }
              const textNodes = Array.from(document.querySelectorAll('a, button, span, div, p'));
              const loginBtn = textNodes.find(el => {
                const text = (el.innerText || el.textContent || '').trim().toLowerCase();
                return (text === 'log in' || text === 'login' || text.includes('already have an account')) && el.offsetParent !== null;
              });
              if (loginBtn) {
                if (loginBtn.tagName === 'A' && loginBtn.href) {
                  window.location.href = loginBtn.href;
                } else if (typeof loginBtn.click === 'function') {
                  console.log('[Monday Auth Helper] Auto clicking Log In link');
                  loginBtn.click();
                }
              }
            } catch(e) {}
          })()
        `).catch(() => { })
      }

      authWin.webContents.on('dom-ready', injectLoginScript)
      authWin.webContents.on('did-finish-load', injectLoginScript)

      authWin.on('closed', () => {
        authWin = null
        if (!resolved) {
          resolved = true
          activeOAuthServer = null
          try { server.close() } catch { }
          resolve({ success: false, error: 'Login window was closed' })
        }
      })

      // Also open in system default browser for instant SSO if user is already logged into Monday in Chrome/Edge
      shell.openExternal(url).catch(() => { })

      authWin.loadURL(url).catch((err) => {
        console.error('[Monday Auth] authWin loadURL error, falling back to default browser:', err)
        shell.openExternal(url).catch(() => { })
      })

      try {
        authWin.focus()
      } catch { }

      // Timeout: auto-close after 3 minutes if user never completes login
      setTimeout(() => {
        if (!resolved) {
          resolved = true
          activeOAuthServer = null
          closeAuthWin()
          try { server.close() } catch { }
          resolve({ success: false, error: 'Login timed out' })
        }
      }, 3 * 60 * 1000)
    })
  })

  // Capture: fetch + freeze a staging page
  ipcMain.handle('capture:start', async (_event, url: string): Promise<CaptureResult> => {
    try {
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
}

app.whenReady().then(() => {
  registerIpcHandlers()
  createWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})

