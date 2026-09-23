import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron'
import { createHash, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, copyFileSync } from 'fs'
import { dirname, join } from 'path'
import { spawn } from 'child_process'
import type { Browser, BrowserContext, BrowserType } from 'playwright'
import sharp from 'sharp'
import { getProjectOwner, getProjects } from './store'
import type { BrowserComparison, BrowserComparisonCapture, BrowserComparisonImage, BrowserComparisonProgress, ComparisonAnnotation, ComparisonEngine } from '../shared/crossBrowser'

let engines: Record<ComparisonEngine, BrowserType<Browser>>
const sessions = new Map<number, { owner: string; projectId: string; engine: ComparisonEngine; browser: Browser; context: BrowserContext }>()
const jobs = new Map<number, { owner: string; cancel: () => void }>()
const installs = new Map<ComparisonEngine, Promise<void>>()

function engine(value: string): ComparisonEngine {
  if (value !== 'firefox' && value !== 'webkit') throw new Error('Unsupported browser engine.')
  return value
}
function owner(): string { return getProjectOwner() || 'local' }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 24) }
function projectDir(projectId: string, account = owner()): string {
  if (!getProjects().some(project => project.id === projectId)) throw new Error('Project is unavailable to this account.')
  return join(app.getPath('userData'), 'browser-comparisons', hash(account), hash(projectId))
}
function sessionFile(projectId: string, selected: ComparisonEngine): string {
  return join(projectDir(projectId), `session-${selected}.bin`)
}
function indexFile(projectId: string): string { return join(projectDir(projectId), 'index.json') }
function ensureDir(file: string) { mkdirSync(dirname(file), { recursive: true }) }
function atomicWrite(file: string, value: string | Buffer) {
  ensureDir(file)
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, value)
  renameSync(temporary, file)
}
function records(projectId: string): BrowserComparison[] {
  const file = indexFile(projectId)
  if (!existsSync(file)) return []
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error('Saved browser comparisons are invalid.')
  return parsed
}
function record(projectId: string, id: string): BrowserComparison {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid comparison ID.')
  const found = records(projectId).find(item => item.id === id)
  if (!found) throw new Error('Comparison was not found in this project.')
  return found
}
function image(projectId: string, id: string, suffix: 'engine' | 'chromium'): string {
  return join(projectDir(projectId), `${id}-${suffix}.png`)
}
function readImage(projectId: string, id: string): BrowserComparisonImage {
  const found = record(projectId, id)
  return {
    record: found,
    image: `data:image/png;base64,${readFileSync(image(projectId, id, 'engine')).toString('base64')}`,
    chromiumImage: `data:image/png;base64,${readFileSync(image(projectId, id, 'chromium')).toString('base64')}`
  }
}
function validUrl(raw: string): string {
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS pages can be compared.')
  return url.href
}
function runtimePath(): string { return join(app.getPath('userData'), 'browser-runtimes') }
function runtimeReady(selected: ComparisonEngine): boolean { return existsSync(engines[selected].executablePath()) }
function emit(senderId: number, selected: ComparisonEngine, phase: BrowserComparisonProgress['phase'], message: string) {
  const window = BrowserWindow.getAllWindows().find(item => item.webContents.id === senderId)
  if (window && !window.isDestroyed()) window.webContents.send('comparison:progress', { engine: selected, phase, message } satisfies BrowserComparisonProgress)
}
function assertOwner(expected: string) {
  if (owner() !== expected) throw new Error('The active account changed during comparison. Try again.')
}
function decodeDataUrl(value: string): Buffer {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(value)
  if (!match || match[1].length > 70_000_000) throw new Error('A valid Chromium PNG capture is required.')
  return Buffer.from(match[1], 'base64')
}
async function closeSession(senderId: number, save: boolean) {
  const current = sessions.get(senderId)
  if (!current) return
  sessions.delete(senderId)
  try {
    if (save && current.owner === owner()) {
      const state = await current.context.storageState({ indexedDB: true })
      const sessionStorage: Record<string, Record<string, string>> = {}
      for (const page of current.context.pages()) {
        try {
          const url = new URL(page.url())
          if (url.protocol === 'http:' || url.protocol === 'https:') {
            sessionStorage[url.origin] = await page.evaluate(() => Object.fromEntries(Object.entries(window.sessionStorage)))
          }
        } catch { /* Closed or cross-origin pages may no longer be readable. */ }
      }
      assertOwner(current.owner)
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure browser session storage is unavailable.')
      atomicWrite(sessionFile(current.projectId, current.engine), safeStorage.encryptString(JSON.stringify({ version: 1, storageState: state, sessionStorage })))
    }
  } finally { await current.browser.close().catch(() => {}) }
}
export async function closeComparisonWork() {
  for (const [id, job] of jobs) { job.cancel(); jobs.delete(id) }
  await Promise.all([...sessions.keys()].map(id => closeSession(id, false)))
}

export function registerComparisonHandlers(): void {
  process.env.PLAYWRIGHT_BROWSERS_PATH = runtimePath()
  const playwright = require('playwright') as typeof import('playwright')
  engines = { firefox: playwright.firefox, webkit: playwright.webkit }
  ipcMain.handle('comparison:status', () => ({ firefox: runtimeReady('firefox'), webkit: runtimeReady('webkit') }))
  ipcMain.handle('comparison:install', async (event, value: string) => {
    const selected = engine(value)
    if (runtimeReady(selected)) return
    if (installs.has(selected)) return installs.get(selected)
    const sourceOwner = owner()
    const task = new Promise<void>((resolve, reject) => {
      emit(event.sender.id, selected, 'installing', `Downloading ${selected} browser…`)
      const cli = join(dirname(require.resolve('playwright/package.json')), 'cli.js')
      const child = spawn(process.execPath, [cli, 'install', selected], {
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PLAYWRIGHT_BROWSERS_PATH: runtimePath() },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let errorText = ''
      child.stderr?.on('data', chunk => { errorText = (errorText + String(chunk)).slice(-1200) })
      child.stdout?.on('data', chunk => emit(event.sender.id, selected, 'installing', String(chunk).trim().slice(-150)))
      child.on('error', reject)
      child.on('exit', code => code === 0 && runtimeReady(selected) ? resolve() : reject(new Error(`Browser installation failed: ${errorText || `exit ${code}`}`)))
    }).finally(() => { installs.delete(selected); assertOwner(sourceOwner) })
    installs.set(selected, task)
    return task
  })
  ipcMain.handle('comparison:open-login', async (event, value: string, projectId: string, rawUrl: string) => {
    const selected = engine(value), sourceOwner = owner(), url = validUrl(rawUrl)
    projectDir(projectId)
    if (!runtimeReady(selected)) throw new Error(`Install ${selected} before signing in.`)
    await closeSession(event.sender.id, false)
    const browser = await engines[selected].launch({ headless: false })
    try {
      assertOwner(sourceOwner)
      const context = await browser.newContext()
      const page = await context.newPage()
      sessions.set(event.sender.id, { owner: sourceOwner, projectId, engine: selected, browser, context })
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
      emit(event.sender.id, selected, 'ready', 'Sign in in the opened browser, then select Save login in Parity.')
    } catch (error) { sessions.delete(event.sender.id); await browser.close().catch(() => {}); throw error }
  })
  ipcMain.handle('comparison:finish-login', async (event, value: string, projectId: string) => {
    const current = sessions.get(event.sender.id)
    if (!current || current.engine !== engine(value) || current.projectId !== projectId || current.owner !== owner()) throw new Error('No matching browser login is open.')
    await closeSession(event.sender.id, true)
  })
  ipcMain.handle('comparison:clear-session', async (event, value: string, projectId: string) => {
    const selected = engine(value)
    projectDir(projectId)
    const current = sessions.get(event.sender.id)
    if (current?.engine === selected && current.projectId === projectId) await closeSession(event.sender.id, false)
    const file = sessionFile(projectId, selected)
    if (existsSync(file)) unlinkSync(file)
  })
  ipcMain.handle('comparison:capture', async (event, input: BrowserComparisonCapture): Promise<BrowserComparisonImage> => {
    const selected = engine(input.engine), sourceOwner = owner()
    const url = validUrl(input.url)
    projectDir(input.projectId)
    if (!runtimeReady(selected)) throw new Error(`Install ${selected} before capturing.`)
    const width = Math.round(input.width), height = Math.round(input.height)
    if (width < 100 || height < 100 || width > 6000 || height > 6000 || width * height > 16_000_000) throw new Error('The comparison viewport exceeds the supported size.')
    const chromium = decodeDataUrl(input.chromiumImage)
    const chromiumMeta = await sharp(chromium).metadata()
    if (chromiumMeta.width !== width || !chromiumMeta.height || chromiumMeta.height < height) throw new Error('Chromium full-page capture dimensions changed. Capture again at the selected viewport.')
    if (chromiumMeta.height > 24000 || width * chromiumMeta.height > 45_000_000) throw new Error('The Chromium page exceeds the supported full-page capture size.')
    if (jobs.size) throw new Error('Another browser comparison is still running.')
    emit(event.sender.id, selected, 'launching', `Opening ${selected}…`)
    let cancelled = false
    let browser: Browser | null = null
    jobs.set(event.sender.id, { owner: sourceOwner, cancel: () => { cancelled = true; void browser?.close().catch(() => {}) } })
    try {
      browser = await engines[selected].launch({ headless: true })
      if (cancelled) throw new Error('Comparison was cancelled.')
      let storageState: any
      let sessionStorage: Record<string, Record<string, string>> = {}
      const encrypted = sessionFile(input.projectId, selected)
      if (existsSync(encrypted)) {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure browser session storage is unavailable.')
        const saved = JSON.parse(safeStorage.decryptString(readFileSync(encrypted)))
        storageState = saved.storageState || saved
        sessionStorage = saved.sessionStorage || {}
      }
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, storageState })
      if (Object.keys(sessionStorage).length) {
        await context.addInitScript(values => {
          const entries = values[window.location.origin]
          if (entries) for (const [key, value] of Object.entries(entries)) window.sessionStorage.setItem(key, value)
        }, sessionStorage)
      }
      const page = await context.newPage()
      emit(event.sender.id, selected, 'loading', `Loading ${url}…`)
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await Promise.race([page.evaluate(() => document.fonts.ready).catch(() => {}), new Promise(resolve => setTimeout(resolve, 5000))])
      // Load ordinary lazy content before taking the full-page screenshot.
      let pageHeight = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0, innerHeight))
      let previousHeight = 0
      // A first scroll can reveal lazy sections and extend the document.
      // Warm the newly added area once more without following infinite feeds.
      for (let pass = 0; pass < 2; pass++) {
        if (pageHeight > 24000 || width * pageHeight > 45_000_000) throw new Error('The page exceeds the supported full-page capture size.')
        for (let y = Math.max(0, previousHeight - height); y < pageHeight; y += Math.max(1, height - 120)) {
          if (cancelled) throw new Error('Comparison was cancelled.')
          await page.evaluate(position => window.scrollTo(0, position), y)
          await page.waitForTimeout(70)
        }
        previousHeight = pageHeight
        pageHeight = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0, innerHeight))
        if (pageHeight <= previousHeight + 1) break
      }
      if (pageHeight > 24000 || width * pageHeight > 45_000_000) throw new Error('The page exceeds the supported full-page capture size.')
      const engineDocumentWidth = await page.evaluate(() => Math.max(innerWidth, document.documentElement.scrollWidth, document.body?.scrollWidth || 0))
      await page.evaluate(scrollY => window.scrollTo(0, scrollY), Math.max(0, Math.round(input.scrollY || 0)))
      await page.waitForTimeout(150)
      const actualScrollY = await page.evaluate(() => window.scrollY)
      await page.evaluate(() => window.scrollTo(0, 0))
      // Sticky navigation often reappears on a debounced upward-scroll event.
      // Let that event and the following paint settle before freezing the page.
      await page.waitForTimeout(350)
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      const pinnedHeaderHeight = await page.evaluate(() => {
        let bottom = 0
        const limit = Math.min(240, innerHeight * 0.35)
        for (const element of document.body.querySelectorAll('*')) {
          const rect = element.getBoundingClientRect()
          if (rect.top < -4 || rect.top > 4 || rect.bottom < 20 || rect.height > limit || rect.width < innerWidth * 0.6) continue
          const style = getComputedStyle(element)
          if ((style.position === 'fixed' || style.position === 'sticky') && style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) > 0) {
            bottom = Math.max(bottom, rect.bottom)
          }
        }
        return Math.max(0, Math.min(240, Math.round(bottom)))
      })
      emit(event.sender.id, selected, 'capturing', `Capturing the full ${selected} page…`)
      // fullPage alone widens to scrollWidth on overflowing sites. Keep the
      // native viewport column at the same width as the Chromium preview.
      const png = await page.screenshot({ type: 'png', fullPage: true, clip: { x: 0, y: 0, width, height: pageHeight }, animations: 'disabled', caret: 'hide' })
      const engineMeta = await sharp(png).metadata()
      if (engineMeta.width !== width || !engineMeta.height || engineMeta.height < height) throw new Error(`${selected} returned an incomplete full-page image.`)
      if (engineMeta.height > 24000 || width * engineMeta.height > 45_000_000) throw new Error(`${selected} full-page image exceeds the supported size.`)
      if (cancelled) throw new Error('Comparison was cancelled.')
      assertOwner(sourceOwner)
      const id = randomUUID()
      const warnings: string[] = []
      if (input.chromiumDocumentWidth && input.chromiumDocumentWidth > width) warnings.push(`Chromium page extends to ${input.chromiumDocumentWidth}px; this comparison captures the visible ${width}px-wide column.`)
      if (engineDocumentWidth > width) warnings.push(`${selected} page extends to ${engineDocumentWidth}px; its visible ${width}px-wide column was captured.`)
      if (response && response.status() >= 400) warnings.push(`Page returned HTTP ${response.status()}.`)
      if (actualScrollY !== Math.max(0, Math.round(input.scrollY || 0))) warnings.push('The browser could not reach the Chromium scroll position.')
      if (Math.abs(engineMeta.height - chromiumMeta.height) > 2) warnings.push(`Page heights differ: Chromium ${chromiumMeta.height}px, ${selected} ${engineMeta.height}px.`)
      if (page.url() !== url) warnings.push(`Browser redirected to ${page.url()}.`)
      const record: BrowserComparison = {
        id, projectId: input.projectId, engine: selected, browserVersion: browser.version(), url,
        finalUrl: page.url(), capturedAt: new Date().toISOString(), width, height,
        fullPage: true, imageHeight: engineMeta.height, chromiumImageHeight: chromiumMeta.height,
        pinnedHeaderHeight: pinnedHeaderHeight || undefined,
        scrollY: Math.max(0, Math.round(input.scrollY || 0)), actualScrollY,
        chromiumEdited: !!input.chromiumEdited,
        chromiumDocumentWidth: input.chromiumDocumentWidth,
        engineDocumentWidth,
        warning: warnings.join(' ') || undefined,
        annotations: []
      }
      atomicWrite(image(input.projectId, id, 'engine'), png)
      atomicWrite(image(input.projectId, id, 'chromium'), chromium)
      atomicWrite(indexFile(input.projectId), JSON.stringify([record, ...records(input.projectId)]))
      emit(event.sender.id, selected, 'ready', `${selected} capture saved.`)
      return readImage(input.projectId, id)
    } catch (error) {
      if (cancelled) throw new Error('Comparison was cancelled.')
      throw error
    } finally { jobs.delete(event.sender.id); await browser?.close().catch(() => {}) }
  })
  ipcMain.handle('comparison:cancel', async event => { jobs.get(event.sender.id)?.cancel() })
  ipcMain.handle('comparison:list', (_event, projectId: string) => records(projectId))
  ipcMain.handle('comparison:load', (_event, projectId: string, id: string) => readImage(projectId, id))
  ipcMain.handle('comparison:save-annotations', (_event, projectId: string, id: string, annotations: ComparisonAnnotation[]) => {
    if (!Array.isArray(annotations) || annotations.length > 500 || annotations.some(a => !a || !/^[0-9a-f-]{36}$/.test(a.id) || ![a.x, a.y, a.width, a.height].every(n => Number.isFinite(n) && n >= 0 && n <= 1) || typeof a.note !== 'string' || a.note.length > 2000)) throw new Error('Invalid comparison annotations.')
    const existing = record(projectId, id)
    const updated = { ...existing, annotations }
    atomicWrite(indexFile(projectId), JSON.stringify(records(projectId).map(item => item.id === id ? updated : item)))
    return updated
  })
  ipcMain.handle('comparison:delete', (_event, projectId: string, id: string) => {
    record(projectId, id)
    atomicWrite(indexFile(projectId), JSON.stringify(records(projectId).filter(item => item.id !== id)))
    for (const suffix of ['engine', 'chromium'] as const) {
      const file = image(projectId, id, suffix)
      if (existsSync(file)) unlinkSync(file)
    }
  })
  ipcMain.handle('comparison:export', async (event, projectId: string, id: string) => {
    const found = record(projectId, id)
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = { title: 'Export browser comparison', properties: ['openDirectory', 'createDirectory'] }
    const chosen = await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options))
    if (chosen.canceled || !chosen.filePaths[0]) return null
    const folder = join(chosen.filePaths[0], `parity-comparison-${found.engine}-${found.capturedAt.replace(/[:.]/g, '-')}-${id.slice(0, 8)}`)
    mkdirSync(folder, { recursive: false })
    copyFileSync(image(projectId, id, 'engine'), join(folder, `${found.engine}.png`))
    copyFileSync(image(projectId, id, 'chromium'), join(folder, 'chromium.png'))
    const imageHeight = found.imageHeight || found.height
    const svg = `<svg width="${found.width}" height="${imageHeight}" xmlns="http://www.w3.org/2000/svg">${found.annotations.map((a, i) => `<rect x="${a.x * found.width}" y="${a.y * imageHeight}" width="${a.width * found.width}" height="${a.height * imageHeight}" fill="none" stroke="#ff4b78" stroke-width="3"/><text x="${a.x * found.width + 4}" y="${a.y * imageHeight + 18}" fill="#ff4b78" font-size="16" font-family="sans-serif">${i + 1}</text>`).join('')}</svg>`
    await sharp(image(projectId, id, 'engine')).composite([{ input: Buffer.from(svg) }]).png().toFile(join(folder, `${found.engine}-annotated.png`))
    writeFileSync(join(folder, 'comparison.json'), JSON.stringify(found, null, 2))
    return folder
  })
  app.on('before-quit', () => { void closeComparisonWork() })
}
