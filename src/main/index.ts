import 'dotenv/config'
import { app, BrowserWindow, ipcMain, shell, session, Menu, dialog, safeStorage, protocol, webContents as electronWebContents } from 'electron'
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

protocol.registerSchemesAsPrivileged([
  { scheme: 'parity-note', privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true } }
])

// Force Chromium engine to use English locale
app.commandLine.appendSwitch('lang', 'en-US')
import { captureUrl } from './capture'
import { freezeSnapshot } from './snapshot'
import { getProjects, saveProject, deleteProject, getProjectOwner, setProjectOwner, getFindingTriage, setFindingTriage, getAutomateRuns, saveAutomateRun } from './store'
import { createSnapshot, getSnapshots, deleteSnapshot } from './snapshotManager.scroll-capture.v2'
import type { Project, CaptureResult, FigmaConnectionStatus, FindingTriageState, AutomateRunSummary, MondayConnectionStatus, MondayPublicConfig, NoteDocument, ParityAccountBootstrap, ParityAccountState } from '../shared/types'
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
import { deleteLocalNoteAttachments, loadLocalNoteAttachment, openLocalNoteAttachment, saveLocalNoteAttachment } from './noteAttachments'

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

function figmaSessionPath() {
  return join(app.getPath('userData'), 'figma-session.json')
}

function hasPersistedFigmaSessionMarker(): boolean {
  try {
    const file = figmaSessionPath()
    if (!existsSync(file)) return false
    const marker = JSON.parse(readFileSync(file, 'utf8'))
    return marker?.connected === true
  } catch { return false }
}

async function detectPersistedFigmaSession(): Promise<boolean> {
  if (hasPersistedFigmaSessionMarker()) return true
  try {
    const cookies = await session.fromPartition('persist:figma').cookies.get({ url: 'https://www.figma.com' })
    const authenticatedCookie = cookies.some((cookie) => cookie.httpOnly && cookie.secure && !/^(__cf|_ga|_gid|ajs_|optanon)/i.test(cookie.name))
    if (authenticatedCookie) markFigmaSession(true)
    return authenticatedCookie
  } catch { return false }
}

function markFigmaSession(connected: boolean): void {
  const file = figmaSessionPath()
  if (!connected) {
    if (existsSync(file)) unlinkSync(file)
    return
  }
  writeFileSync(file, JSON.stringify({ connected: true, verifiedAt: Date.now() }))
}

async function getFigmaConnectionStatus(validateApi = true): Promise<FigmaConnectionStatus> {
  const token = readFigmaToken()
  const browserSession = await detectPersistedFigmaSession()
  if (!token) return { connected: browserSession, apiConfigured: false, browserSession }
  if (!validateApi) return { connected: true, apiConfigured: true, browserSession }
  try {
    const response = await fetch('https://api.figma.com/v1/me', { headers: { 'X-Figma-Token': token } })
    if (!response.ok) {
      return { connected: browserSession, apiConfigured: false, browserSession, error: `Figma API credential returned ${response.status}.` }
    }
    const me = await response.json() as any
    return {
      connected: true,
      apiConfigured: true,
      browserSession,
      user: { id: me.id, handle: me.handle, email: me.email, imgUrl: me.img_url }
    }
  } catch (error: any) {
    return { connected: true, apiConfigured: true, browserSession, error: error?.message || 'Unable to validate Figma right now.' }
  }
}

interface StoredMondayCredentials {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  authType: 'oauth' | 'personal'
  oauthFlow?: 'oauth2.1' | 'legacy'
  oauthConfig?: MondayPublicConfig
}

interface ParityAccountSession {
  token: string
  expiresAt: number
  user: { ownerKey: string; mondayUserId: string; name: string; email?: string }
}

let parityAccountSession: ParityAccountSession | null = null

function mondayCredentialsPath() {
  return join(app.getPath('userData'), 'monday-credentials.bin')
}

function readMondayCredentials(): StoredMondayCredentials | null {
  try {
    const file = mondayCredentialsPath()
    if (!existsSync(file) || !safeStorage.isEncryptionAvailable()) return null
    return JSON.parse(safeStorage.decryptString(readFileSync(file)))
  } catch { return null }
}

function writeMondayCredentials(credentials: StoredMondayCredentials | null): void {
  const file = mondayCredentialsPath()
  if (!credentials) {
    parityAccountSession = null
    if (existsSync(file)) unlinkSync(file)
    return
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable on this device.')
  writeFileSync(file, safeStorage.encryptString(JSON.stringify(credentials)))
}

function decodeJwtExpiry(token: string, expiresIn?: number): number | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
    if (Number.isFinite(payload.exp)) return Number(payload.exp) * 1000
  } catch { /* personal and legacy tokens are not necessarily JWTs */ }
  return expiresIn ? Date.now() + expiresIn * 1000 : undefined
}

function assertMondayProxyConfig(config: MondayPublicConfig): void {
  const url = new URL(config.supabaseUrl)
  const isLocal = ['localhost', '127.0.0.1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !isLocal) throw new Error('Monday OAuth proxy must use HTTPS.')
  if (!isLocal && !url.hostname.endsWith('.supabase.co')) throw new Error('Monday OAuth proxy must be hosted by the configured Supabase project.')
  if (!config.supabaseAnonKey?.trim()) throw new Error('Supabase public key is missing.')
}

async function mondayOauthProxy(config: MondayPublicConfig, payload: Record<string, unknown>): Promise<any> {
  assertMondayProxyConfig(config)
  const response = await fetch(`${config.supabaseUrl.replace(/\/$/, '')}/functions/v1/monday-oauth`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': config.supabaseAnonKey
    },
    body: JSON.stringify(payload)
  })
  const body = await response.json().catch(() => ({})) as any
  if (!response.ok) throw new Error(body?.error || `Monday OAuth service returned ${response.status}.`)
  return body
}

async function refreshMondayCredentials(credentials: StoredMondayCredentials): Promise<StoredMondayCredentials> {
  if (credentials.authType !== 'oauth' || !credentials.refreshToken || !credentials.oauthConfig) return credentials
  const refreshed = await mondayOauthProxy(credentials.oauthConfig, { action: 'refresh', refresh_token: credentials.refreshToken })
  const next: StoredMondayCredentials = {
    ...credentials,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token || credentials.refreshToken,
    expiresAt: decodeJwtExpiry(refreshed.access_token, refreshed.expires_in)
  }
  writeMondayCredentials(next)
  return next
}

function mondayCloudConfig(credentials: StoredMondayCredentials): MondayPublicConfig {
  if (!credentials.oauthConfig) throw new Error('Reconnect Monday.com to enable private Supabase workspace sync.')
  assertMondayProxyConfig(credentials.oauthConfig)
  return credentials.oauthConfig
}

async function currentMondayCredentials(): Promise<StoredMondayCredentials> {
  let credentials = readMondayCredentials()
  if (!credentials?.accessToken) throw new Error('Connect Monday.com to use private cloud data.')
  if (credentials.authType === 'oauth' && credentials.expiresAt && credentials.expiresAt - Date.now() < 5 * 60 * 1000) {
    credentials = await refreshMondayCredentials(credentials)
  }
  return credentials
}

async function parityAccountRequest(action: string, payload: Record<string, unknown> = {}, retry = true): Promise<any> {
  const credentials = await currentMondayCredentials()
  const config = mondayCloudConfig(credentials)
  const endpoint = `${config.supabaseUrl.replace(/\/$/, '')}/functions/v1/parity-account`

  if (!parityAccountSession || parityAccountSession.expiresAt - Date.now() < 60_000) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: config.supabaseAnonKey,
        Authorization: `Bearer ${credentials.accessToken}`
      },
      body: JSON.stringify({ action: 'session' })
    })
    const result = await response.json().catch(() => ({})) as any
    if (!response.ok || !result.session_token) throw new Error(result.error || `Parity account login returned ${response.status}.`)
    parityAccountSession = {
      token: result.session_token,
      expiresAt: Number(result.expires_at || 0),
      user: result.user
    }
    setProjectOwner(parityAccountSession.user.ownerKey)
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${parityAccountSession.token}`
    },
    body: JSON.stringify({ action, ...payload })
  })
  const result = await response.json().catch(() => ({})) as any
  if (response.status === 401 && retry) {
    parityAccountSession = null
    return parityAccountRequest(action, payload, false)
  }
  if (!response.ok) throw new Error(result.error || `Parity account service returned ${response.status}.`)
  return result
}

function cloudProject(project: Project): Project {
  const next: Project = {
    ...project,
    updatedAt: project.updatedAt || project.lastOpenedAt || project.createdAt || Date.now()
  }
  if (next.thumbnailUrl?.startsWith('data:')) delete next.thumbnailUrl
  return next
}

function pendingProjectDeletesPath(ownerKey: string): string {
  const ownerHash = createHash('sha256').update(ownerKey).digest('hex').slice(0, 24)
  return join(app.getPath('userData'), `pending-project-deletes-${ownerHash}.json`)
}

function readPendingProjectDeletes(ownerKey: string): string[] {
  try {
    const file = pendingProjectDeletesPath(ownerKey)
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
  } catch { return [] }
}

function writePendingProjectDeletes(ownerKey: string, ids: string[]): void {
  writeFileSync(pendingProjectDeletesPath(ownerKey), JSON.stringify([...new Set(ids)]), 'utf8')
}

async function flushPendingProjectDeletes(ownerKey: string): Promise<void> {
  const pending = readPendingProjectDeletes(ownerKey)
  if (!pending.length) return
  const remaining: string[] = []
  for (const projectId of pending) {
    try {
      await parityAccountRequest('delete_project', { projectId })
    } catch {
      remaining.push(projectId)
    }
  }
  writePendingProjectDeletes(ownerKey, remaining)
}

async function bootstrapParityAccount(): Promise<ParityAccountBootstrap> {
  try {
    const result = await parityAccountRequest('bootstrap')
    await flushPendingProjectDeletes(result.user.ownerKey)
    const localProjects = getProjects()
    const localById = new Map(localProjects.map((project) => [project.id, project]))
    const remoteProjects = (Array.isArray(result.projects) ? result.projects : []) as Array<Project & { cloudUpdatedAt?: string }>

    for (const remote of remoteProjects) {
      const local = localById.get(remote.id)
      const remoteVersion = remote.updatedAt || Date.parse(remote.cloudUpdatedAt || '') || 0
      const localVersion = local?.updatedAt || local?.lastOpenedAt || local?.createdAt || 0
      if (!local || remoteVersion > localVersion) {
        const { cloudUpdatedAt: _cloudUpdatedAt, ...remoteProject } = remote
        const merged = {
          ...remoteProject,
          thumbnailUrl: local?.thumbnailUrl || remoteProject.thumbnailUrl,
          updatedAt: remoteVersion
        }
        saveProject(merged)
        localById.set(remote.id, merged)
      }
    }

    const remoteById = new Map(remoteProjects.map((project) => [project.id, project]))
    const uploads = getProjects().filter((project) => {
      const remote = remoteById.get(project.id)
      if (!remote) return true
      return (project.updatedAt || project.lastOpenedAt || 0) > (remote.updatedAt || Date.parse(remote.cloudUpdatedAt || '') || 0)
    })
    await Promise.allSettled(
      uploads.map((project) => parityAccountRequest('save_project', { project: cloudProject(project) }))
    )

    return {
      connected: true,
      user: result.user,
      state: result.state,
      projects: getProjects(),
      notes: Array.isArray(result.notes) ? result.notes : []
    }
  } catch (error) {
    return {
      connected: false,
      error: error instanceof Error ? error.message : 'Unable to load private account data.'
    }
  }
}

async function mondayGraphQL(query: string, variables?: Record<string, unknown>, authRetry = true, rateRetry = 1): Promise<any> {
  let credentials = readMondayCredentials()
  if (!credentials?.accessToken) throw new Error('Connect Monday.com before syncing tickets.')
  if (credentials.authType === 'oauth' && credentials.expiresAt && credentials.expiresAt - Date.now() < 5 * 60 * 1000) {
    credentials = await refreshMondayCredentials(credentials)
  }
  const response = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': credentials.accessToken,
      'API-Version': '2026-07'
    },
    body: JSON.stringify({ query, variables })
  })
  if (response.status === 401 && authRetry && credentials.authType === 'oauth') {
    await refreshMondayCredentials(credentials)
    return mondayGraphQL(query, variables, false, rateRetry)
  }
  const body = await response.json().catch(() => null) as any
  const retrySeconds = Number(response.headers.get('retry-after') || body?.errors?.[0]?.extensions?.retry_in_seconds || 0)
  if ((response.status === 429 || retrySeconds > 0) && rateRetry > 0 && retrySeconds > 0 && retrySeconds <= 30) {
    await new Promise((resolve) => setTimeout(resolve, retrySeconds * 1000))
    return mondayGraphQL(query, variables, authRetry, rateRetry - 1)
  }
  if (!response.ok) {
    throw new Error(body?.error_message || body?.errors?.[0]?.message || `Monday API returned ${response.status}${retrySeconds ? `; retry after ${retrySeconds}s` : ''}.`)
  }
  if (body?.errors?.length) throw new Error(body.errors.map((entry: any) => entry.message).join('; '))
  return body
}

async function getMondayConnectionStatus(): Promise<MondayConnectionStatus> {
  const credentials = readMondayCredentials()
  if (!credentials) return { connected: false }
  try {
    const result = await mondayGraphQL('query ParityConnection { me { id name email } }')
    return { connected: true, authType: credentials.authType, user: result.data.me }
  } catch (error: any) {
    return { connected: false, authType: credentials.authType, error: error?.message || 'Monday.com connection is unavailable.' }
  }
}

function parseFigmaReference(rawUrl: string) {
  const url = new URL(rawUrl)
  const match = url.pathname.match(/\/(?:design|file|proto)\/([^/]+)/i)
  if (!match) throw new Error('Enter a valid Figma design URL.')
  const rawNode = url.searchParams.get('node-id') || ''
  return { fileKey: match[1], nodeId: rawNode ? rawNode.replace(/-/g, ':') : '' }
}

const FIGMA_FRAME_CANDIDATE_TYPES = new Set(['FRAME', 'COMPONENT', 'SECTION'])
const FIGMA_ORGANIZATIONAL_TYPES = new Set(['GROUP', 'SECTION', 'FRAME'])
const FIGMA_MIN_FRAME_SIZE = 200
const FIGMA_FRAME_MAX_DEPTH = 6

/**
 * Recursively finds page-sized frames wherever a designer nested them — inside a
 * Section, a Group, or another Frame used purely for organization. A depth-limited
 * top-level-only scan misses these, and there's no way to ask a viewer-only file's
 * owner to flatten it for QA convenience.
 */
function collectFigmaFrames(document: any, frames: any[]): void {
  for (const page of document?.children || []) {
    walkFigmaContainer(page, page.name || '', [], 0, frames, new Set<string>())
  }
}

function walkFigmaContainer(container: any, pageName: string, breadcrumb: string[], depth: number, frames: any[], seen: Set<string>): void {
  for (const child of container?.children || []) {
    if (seen.has(child.id)) continue
    const box = child.absoluteBoundingBox || {}
    const isCandidate = FIGMA_FRAME_CANDIDATE_TYPES.has(child.type) && box.width >= FIGMA_MIN_FRAME_SIZE && box.height >= FIGMA_MIN_FRAME_SIZE
    if (isCandidate) {
      seen.add(child.id)
      frames.push({ id: child.id, name: child.name || 'Untitled frame', type: child.type, pageName, path: breadcrumb.join(' / '), width: Math.round(box.width), height: Math.round(box.height) })
    }
    if (depth < FIGMA_FRAME_MAX_DEPTH && FIGMA_ORGANIZATIONAL_TYPES.has(child.type)) {
      walkFigmaContainer(child, pageName, isCandidate ? [...breadcrumb, child.name || 'Frame'] : breadcrumb, depth + 1, frames, seen)
    }
  }
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
  const fontActuallyLoaded = (style) => {
    try {
      const family = (style.fontFamily.split(',')[0] || '').trim().replace(/^["']|["']$/g, '');
      if (!family || !document.fonts || !document.fonts.check) return true;
      return document.fonts.check(style.fontWeight + ' ' + style.fontSize + ' "' + family + '"');
    } catch { return true; }
  };
  const nodes = Array.from(document.querySelectorAll(selectors)).map((element) => {
    const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
    const positioned = style.position === 'fixed' || style.position === 'sticky';
    const pageX = positioned ? rect.left : rect.left + scrollX;
    const pageY = positioned ? rect.top : rect.top + scrollY;
    return { tag: element.tagName.toLowerCase(), role: element.getAttribute('role') || '', text: elementText(element).slice(0, 500), src: element.tagName === 'IMG' ? element.currentSrc || element.src : '', context: contextFor(element), path: pathFor(element), rect: { x: pageX, y: pageY, width: rect.width, height: rect.height }, styles: { fontSize: style.fontSize, fontFamily: style.fontFamily, fontWeight: style.fontWeight, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, color: style.color, backgroundColor: style.backgroundColor, textAlign: style.textAlign, textTransform: style.textTransform, position: style.position, fontLoaded: String(fontActuallyLoaded(style)) } };
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
    // A visible scrollbar shrinks the content box by its own width, which shows
    // up as a spurious few-pixel horizontal defect on every element in the page.
    try { await debug.sendCommand('Emulation.setScrollbarsHidden', { hidden: true }) } catch {}
    await debug.sendCommand('Runtime.evaluate', { expression: `(() => { const freeze = document.createElement('style'); freeze.id = '__qaAutomateFreeze'; freeze.textContent = '*, *::before, *::after { animation-play-state: paused !important; transition: none !important; caret-color: transparent !important; }'; document.head?.appendChild(freeze); const animations = document.getAnimations().map((animation) => ({ animation, playState: animation.playState })); for (const item of animations) item.animation.pause(); const positioned = []; for (const element of document.body?.querySelectorAll('*') || []) { const position = getComputedStyle(element).position; if (position === 'fixed' || position === 'sticky') positioned.push({ element, visibility: element.style.visibility }); } window.__qaAutomateAtomicState = { x: scrollX, y: scrollY, animations, positioned, scrollBehavior: document.documentElement.style.scrollBehavior }; document.documentElement.style.setProperty('scroll-behavior','auto','important'); scrollTo(0,0); return document.readyState; })()`, awaitPromise: true })
    // Wait for the page to actually be ready to photograph — fonts and in-flight
    // images — rather than trusting a flat delay to have been long enough.
    await debug.sendCommand('Runtime.evaluate', {
      expression: `(async () => {
        try { await Promise.race([(document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve(), new Promise((resolve) => setTimeout(resolve, 3000))]); } catch {}
        const images = Array.from(document.images || []).slice(0, 400).filter((img) => !img.complete);
        await Promise.all(images.map((img) => new Promise((resolve) => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
          setTimeout(resolve, 4000);
        })));
        return true;
      })()`,
      awaitPromise: true
    })
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
      await debug.sendCommand('Runtime.evaluate', { expression: `(() => { document.getElementById('__qaAutomateFreeze')?.remove(); const state = window.__qaAutomateAtomicState; if (state) { for (const item of state.positioned || []) item.element.style.visibility = item.visibility; document.documentElement.style.scrollBehavior = state.scrollBehavior; scrollTo(state.x, state.y); for (const item of state.animations || []) { if (item.playState === 'running') item.animation.play(); } } delete window.__qaAutomateAtomicState; })()` })
    } catch {}
    try { await debug.sendCommand('Emulation.setScrollbarsHidden', { hidden: false }) } catch {}
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
      let authenticated = false

      const checkAuthStatus = async (url: string) => {
        if (url.includes('figma.com/file') || url.includes('figma.com/design') || url.includes('figma.com/files') || url.includes('figma.com/board')) {
          authenticated = true
          markFigmaSession(true)
          mainWindow?.webContents.send('figma:auth-changed', await getFigmaConnectionStatus(false))
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
        if (authenticated) mainWindow?.webContents.send('figma:auth-changed', await getFigmaConnectionStatus(false))
        resolve()
      })
    })
  })

  ipcMain.handle('figma:token-status', () => getFigmaConnectionStatus())

  ipcMain.handle('figma:set-token', async (_event, token: string) => {
    try {
      const trimmed = (token || '').trim()
      if (!trimmed) {
        writeFigmaToken('')
        const status = await getFigmaConnectionStatus(false)
        mainWindow?.webContents.send('figma:auth-changed', status)
        return { success: true, configured: false }
      }
      const response = await fetch('https://api.figma.com/v1/me', { headers: { 'X-Figma-Token': trimmed } })
      if (!response.ok) throw new Error(`Figma rejected this credential (${response.status}). Check its expiry and current_user:read scope.`)
      writeFigmaToken(trimmed)
      const status = await getFigmaConnectionStatus()
      mainWindow?.webContents.send('figma:auth-changed', status)
      return { success: true, configured: true }
    } catch (error: any) {
      return { success: false, configured: false, error: error?.message || 'Unable to validate the Figma token.' }
    }
  })

  ipcMain.handle('figma:list-frames', async (_event, rawUrl: string) => {
    try {
      const { fileKey, nodeId } = parseFigmaReference(rawUrl)
      // Full depth from the document root: page(1) + up to 6 organizational levels
      // (Section/Group/Frame wrappers) below it, plus headroom. A viewer-only token
      // can't ask designers to keep page frames at the top level, so this has to find
      // them wherever they're nested.
      const file = await figmaRequest(`/files/${encodeURIComponent(fileKey)}?depth=10`)
      const frames: any[] = []
      collectFigmaFrames(file.document, frames)
      const styleNames: Record<string, string> = {}
      for (const [id, style] of Object.entries<any>(file.styles || {})) styleNames[id] = style?.name || ''
      return { success: true, fileName: file.name || 'Figma design', lastModified: file.lastModified || '', requestedNodeId: nodeId, frames, styleNames }
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

  ipcMain.handle('automate:triage-get', (_event, projectId: string) => getFindingTriage(projectId))

  ipcMain.handle('automate:triage-set', (_event, projectId: string, findingId: string, state: FindingTriageState | null) => {
    setFindingTriage(projectId, findingId, state)
    return { success: true }
  })

  ipcMain.handle('automate:run-save', (_event, projectId: string, run: AutomateRunSummary) => {
    saveAutomateRun(projectId, run)
    return { success: true }
  })

  ipcMain.handle('automate:run-list', (_event, projectId: string, frameId: string) => getAutomateRuns(projectId, frameId))

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
  ipcMain.handle('monday:status', () => getMondayConnectionStatus())

  ipcMain.handle('monday:set-personal-token', async (_event, token: string, config?: MondayPublicConfig) => {
    try {
      const trimmed = token.trim()
      if (!trimmed) throw new Error('Enter a Monday personal API token.')
      writeMondayCredentials({ accessToken: trimmed, authType: 'personal', oauthConfig: config })
      const status = await getMondayConnectionStatus()
      if (!status.connected) {
        writeMondayCredentials(null)
        throw new Error(status.error || 'Monday rejected this token.')
      }
      return { success: true, status }
    } catch (error: any) {
      return { success: false, error: error?.message || 'Unable to connect Monday.com.' }
    }
  })

  ipcMain.handle('monday:graphql', async (_event, query: string, variables?: Record<string, unknown>) => {
    return mondayGraphQL(query, variables)
  })

  ipcMain.handle('monday:disconnect', async (_event, config?: MondayPublicConfig) => {
    const credentials = readMondayCredentials()
    try {
      if (credentials?.authType === 'oauth' && credentials.refreshToken && (config || credentials.oauthConfig)) {
        await mondayOauthProxy(config || credentials.oauthConfig!, { action: 'revoke', token: credentials.refreshToken })
      }
    } catch (error) {
      console.warn('[Monday Auth] Remote token revocation failed; clearing local credentials.', error)
    }
    writeMondayCredentials(null)
    return { success: true }
  })

  ipcMain.handle('monday:login', async (_event, config: MondayPublicConfig): Promise<{ success: boolean; status?: MondayConnectionStatus; error?: string }> => {
    let oauthConfig: { client_id: string; redirect_uri: string }
    try {
      oauthConfig = await mondayOauthProxy(config, { action: 'config' })
      if (!oauthConfig.client_id) throw new Error('Monday OAuth client ID is not configured on the server.')
      if (oauthConfig.redirect_uri && oauthConfig.redirect_uri !== MONDAY_REDIRECT_URI) {
        throw new Error(`Monday redirect URI must be ${MONDAY_REDIRECT_URI}.`)
      }
    } catch (error: any) {
      return { success: false, error: error?.message || 'Monday OAuth is not configured.' }
    }

    // Close any previous OAuth callback server if still listening
    if (activeOAuthServer) {
      try { activeOAuthServer.close() } catch { }
      activeOAuthServer = null
    }

    const codeVerifier = generateCodeVerifier()
    const codeChallenge = generateCodeChallenge(codeVerifier)
    const expectedState = randomBytes(24).toString('base64url')

    return new Promise((resolve) => {
      let resolved = false
      let exchangeStarted = false

      // 1. Spin up a one-shot HTTP server to catch the OAuth redirect
      const server = createServer(async (req, res) => {
        if (resolved) { res.end(); return }

        const url = new URL(req.url || '/', `http://localhost:${MONDAY_REDIRECT_PORT}`)
        if (!url.pathname.startsWith('/oauth/callback')) { res.end(); return }

        const code = url.searchParams.get('code')
        const error = url.searchParams.get('error')
        const state = url.searchParams.get('state')
        const status = url.searchParams.get('status')

        if (error || !code || state !== expectedState || (status && status !== 'approved')) {
          resolved = true
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#18181b;color:#a1a1aa"><h2 style="color:#ef4444">Login Cancelled</h2><p>You can close this tab and return to the app.</p></body></html>')
          activeOAuthServer = null
          try { server.close() } catch { }
          resolve({ success: false, error: error || (state !== expectedState ? 'OAuth state verification failed' : 'No authorization code received') })
          return
        }

        // Authorization codes are single-use. Browser retries or duplicate
        // callback navigation must never start a second token exchange.
        if (exchangeStarted) {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#18181b;color:#a1a1aa"><h2>Finishing connection&hellip;</h2><p>You can close this tab and return to Parity.</p></body></html>')
          return
        }
        exchangeStarted = true

        // 2. Exchange the authorization code for an access token
        try {
          const tokenData = await mondayOauthProxy(config, {
            action: 'exchange',
            code,
            redirect_uri: MONDAY_REDIRECT_URI,
            code_verifier: codeVerifier
          })

          if (tokenData.access_token) {
            parityAccountSession = null
            writeMondayCredentials({
              accessToken: tokenData.access_token,
              refreshToken: tokenData.refresh_token,
              expiresAt: decodeJwtExpiry(tokenData.access_token, tokenData.expires_in),
              authType: 'oauth',
              oauthFlow: tokenData.oauth_flow === 'legacy' ? 'legacy' : 'oauth2.1',
              oauthConfig: config
            })
            resolved = true
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end('<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#18181b;color:#f4f4f5"><h2 style="color:#10b981;font-size:24px">✓ Connected to Monday.com</h2><p style="color:#a1a1aa">Authentication successful! You can close this browser tab and return to the app.</p></body></html>')
            activeOAuthServer = null
            try { server.close() } catch { }
            resolve({ success: true, status: await getMondayConnectionStatus() })
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
      authUrl.searchParams.set('client_id', oauthConfig.client_id)
      authUrl.searchParams.set('redirect_uri', MONDAY_REDIRECT_URI)
      authUrl.searchParams.set('response_type', 'code')
      authUrl.searchParams.set('code_challenge', codeChallenge)
      authUrl.searchParams.set('code_challenge_method', 'S256')
      authUrl.searchParams.set('state', expectedState)

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

  // Monday-authenticated private account data. The renderer never receives a
  // Monday access token or Supabase service credential.
  ipcMain.handle('account:bootstrap', () => bootstrapParityAccount())
  ipcMain.handle('account:save-state', async (_event, data: Partial<ParityAccountState>) => {
    try {
      const result = await parityAccountRequest('save_state', { data })
      return { success: true, updatedAt: result.updatedAt }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unable to save account settings.' }
    }
  })
  ipcMain.handle('account:save-note', async (_event, note: NoteDocument) => {
    try {
      const result = await parityAccountRequest('save_note', { note })
      return { success: true, updatedAt: result.updatedAt }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unable to save note.' }
    }
  })
  ipcMain.handle('account:delete-note', async (_event, noteId: string) => {
    try {
      await parityAccountRequest('delete_note', { noteId })
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unable to delete note.' }
    }
  })
  ipcMain.handle('notes:save-attachment', async (_event, input: { dataUrl: string; name: string }) => {
    try {
      if (!parityAccountSession) await parityAccountRequest('bootstrap')
      if (!parityAccountSession?.user.ownerKey) throw new Error('Connect Monday.com before attaching files.')
      return { success: true, attachment: await saveLocalNoteAttachment(parityAccountSession.user.ownerKey, input) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unable to save attachment.' }
    }
  })
  ipcMain.handle('notes:delete-attachments', async (_event, attachmentIds: string[]) => {
    try {
      if (!parityAccountSession) await parityAccountRequest('bootstrap')
      if (!parityAccountSession?.user.ownerKey) throw new Error('Connect Monday.com before deleting attachments.')
      deleteLocalNoteAttachments(parityAccountSession.user.ownerKey, attachmentIds)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unable to delete attachments.' }
    }
  })
  ipcMain.handle('notes:open-attachment', async (_event, uri: string) => {
    try {
      await openLocalNoteAttachment(uri)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unable to open attachment.' }
    }
  })

  // Projects remain available offline and synchronize opportunistically when
  // a Monday-authenticated cloud account is available.
  ipcMain.handle('projects:list', () => getProjects())
  ipcMain.handle('projects:save', async (_event, project: Project) => {
    const next = { ...project, updatedAt: Date.now() }
    saveProject(next)
    try { await parityAccountRequest('save_project', { project: cloudProject(next) }) }
    catch (error) { console.warn('[Parity Account] Project queued for the next sync:', error) }
  })
  ipcMain.handle('projects:delete', async (_event, id: string) => {
    deleteProject(id)
    const ownerKey = getProjectOwner()
    if (!ownerKey) return
    writePendingProjectDeletes(ownerKey, [...readPendingProjectDeletes(ownerKey), id])
    try {
      await parityAccountRequest('delete_project', { projectId: id })
      writePendingProjectDeletes(ownerKey, readPendingProjectDeletes(ownerKey).filter((projectId) => projectId !== id))
    } catch (error) {
      console.warn('[Parity Account] Project deletion queued for the next sync:', error)
    }
  })

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
  protocol.handle('parity-note', async (request) => {
    const attachment = loadLocalNoteAttachment(request.url)
    if (!attachment) return new Response('Attachment not found on this device.', { status: 404 })
    const body = attachment.bytes.buffer.slice(
      attachment.bytes.byteOffset,
      attachment.bytes.byteOffset + attachment.bytes.byteLength,
    ) as ArrayBuffer
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': attachment.mimeType,
        'Cache-Control': 'private, max-age=31536000, immutable',
        'Content-Security-Policy': "default-src 'none'"
      }
    })
  })
  registerIpcHandlers()
  createWindow()
  initializeAppUpdater(() => mainWindow)
})

app.on('window-all-closed', () => {
  app.quit()
})

