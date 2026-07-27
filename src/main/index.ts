import 'dotenv/config'
import { app, BrowserWindow, ipcMain, shell, session, Menu } from 'electron'
import { join } from 'path'
import { captureUrl } from './capture'
import { freezeSnapshot } from './snapshot'
import { getProjects, saveProject, deleteProject } from './store'
import type { Project, CaptureResult } from '../shared/types'
import { createServer } from 'http'
import { randomBytes, createHash } from 'crypto'

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

// Ensure all web contents (popups, webviews, child windows) use Chrome User-Agent for seamless Google Accounts OAuth
app.on('web-contents-created', (_event, contents) => {
  contents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')
  contents.setWindowOpenHandler(() => {
    return { action: 'allow' }
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
          try { await session.defaultSession.cookies.flushStore() } catch {}
          setTimeout(async () => {
            try { await session.defaultSession.cookies.flushStore() } catch {}
            if (!loginWindow.isDestroyed()) loginWindow.close()
          }, 1000)
        }
      })

      loginWindow.on('closed', async () => {
        try { await session.defaultSession.cookies.flushStore() } catch {}
        resolve()
      })
    })
  })

  // Figma Login Window: Uses standard Chrome User-Agent so Google Accounts OAuth works cleanly inside Electron
  ipcMain.handle('app:figmaLoginWindow', async (_event, figmaUrl?: string): Promise<void> => {
    return new Promise<void>((resolve) => {
      const chromeUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      const loginWin = new BrowserWindow({
        width: 1024,
        height: 768,
        title: 'Sign in to Figma',
        parent: mainWindow!,
        backgroundColor: '#181818',
        autoHideMenuBar: true,
        webPreferences: {
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

      loginWin.webContents.on('did-navigate', async (_e, url) => {
        if (url.includes('figma.com/files') || url.includes('figma.com/design') || url.includes('figma.com/file')) {
          try { await session.defaultSession.cookies.flushStore() } catch {}
          setTimeout(() => {
            try { if (!loginWin.isDestroyed()) loginWin.close() } catch {}
          }, 1000)
        }
      })

      loginWin.on('closed', async () => {
        try { await session.defaultSession.cookies.flushStore() } catch {}
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
      detachedWindow.setMenu(null)
      detachedWindow.loadURL(url)
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
          res.end('<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Login cancelled</h2><p>You can close this tab.</p></body></html>')
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
            res.end('<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#1a1a1a;color:#e0e0e0"><h2 style="color:#3fb950">✓ Connected to Monday.com</h2><p>You can close this tab and return to the app.</p></body></html>')
            activeOAuthServer = null
            try { server.close() } catch { }
            resolve({ success: true, token: tokenData.access_token })
          } else {
            resolved = true
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end('<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Token exchange failed</h2><p>Please try again.</p></body></html>')
            activeOAuthServer = null
            try { server.close() } catch { }
            resolve({ success: false, error: tokenData.error || 'Token exchange failed' })
          }
        } catch (err) {
          resolved = true
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Connection error</h2></body></html>')
          activeOAuthServer = null
          try { server.close() } catch { }
          resolve({ success: false, error: (err as Error).message })
        }
      })

      activeOAuthServer = server

      // Catch EADDRINUSE or server start errors gracefully
      server.on('error', (err: any) => {
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

      server.listen(MONDAY_REDIRECT_PORT, '127.0.0.1', () => {
        // 3. Open a dedicated browser window for Monday OAuth login
        const authUrl = new URL('https://auth.monday.com/oauth2/authorize')
        authUrl.searchParams.set('client_id', MONDAY_CLIENT_ID)
        authUrl.searchParams.set('redirect_uri', MONDAY_REDIRECT_URI)
        authUrl.searchParams.set('response_type', 'code')
        authUrl.searchParams.set('scope', 'me:read boards:read docs:read workspaces:read users:read updates:read assets:read')
        authUrl.searchParams.set('code_challenge', codeChallenge)
        authUrl.searchParams.set('code_challenge_method', 'S256')

        const url = authUrl.toString()

        // Launch Edge/Chrome in its own window (not a tab in the company browser)
        const { exec } = require('child_process')
        exec(`start msedge --new-window "${url}"`, (err: Error | null) => {
          if (err) {
            // Edge not found — try Chrome
            exec(`start chrome --new-window "${url}"`, (err2: Error | null) => {
              if (err2) {
                // Neither found — fall back to default browser
                shell.openExternal(url)
              }
            })
          }
        })
      })

      // Timeout: auto-close after 3 minutes if user never completes login
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
}

app.whenReady().then(() => {
  registerIpcHandlers()
  createWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})

