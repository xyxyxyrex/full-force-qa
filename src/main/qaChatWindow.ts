import { BrowserWindow, ipcMain, screen, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import type { QaChatWindowAction, QaChatWindowSnapshot } from '../shared/qaChatWindow'

interface Options { getMainWindow: () => BrowserWindow | null; preload: string; rendererFile: string; rendererUrl?: string }

export function registerQaChatWindow(options: Options) {
  let detached: BrowserWindow | null = null
  let snapshot: QaChatWindowSnapshot | null = null
  let bounds: Electron.Rectangle | undefined
  const host = () => { const window = options.getMainWindow(); return window && !window.isDestroyed() ? window : null }
  const fromHost = (event: IpcMainEvent | IpcMainInvokeEvent) => !!host() && event.senderFrame === host()!.webContents.mainFrame
  const fromDetached = (event: IpcMainEvent | IpcMainInvokeEvent) => !!detached && !detached.isDestroyed() && event.senderFrame === detached.webContents.mainFrame
  const notify = () => host()?.webContents.send('qa:window:changed', !!detached)
  const focusHost = () => { const window = host(); if (!window) return; if (window.isMinimized()) window.restore(); window.show(); window.focus() }

  ipcMain.handle('qa:window:status', event => fromHost(event) || fromDetached(event) ? !!detached : false)
  ipcMain.on('qa:window:sync', (event, next: QaChatWindowSnapshot) => {
    if (!fromHost(event) || !next || typeof next.theme !== 'string' || !next.chat || typeof next.chat !== 'object') return
    snapshot = next
    if (detached && !detached.isDestroyed()) detached.webContents.send('qa:window:snapshot', snapshot)
  })
  ipcMain.handle('qa:window:ready', event => fromDetached(event) ? snapshot : null)
  ipcMain.on('qa:window:action', (event, action: QaChatWindowAction) => {
    if (!fromDetached(event) || !action || !['user', 'status', 'error', 'clear', 'event', 'draft', 'open'].includes(action.type)) return
    host()?.webContents.send('qa:window:action', action)
    if (action.type === 'open') focusHost()
  })
  ipcMain.handle('qa:window:dock', event => {
    if (!fromHost(event) && !fromDetached(event)) return false
    detached?.close(); focusHost(); return true
  })
  ipcMain.handle('qa:window:detach', async event => {
    if (!fromHost(event) || !host()) return false
    if (detached && !detached.isDestroyed()) { if (detached.isMinimized()) detached.restore(); detached.show(); detached.focus(); return true }
    const area = screen.getDisplayMatching(bounds || host()!.getBounds()).workArea
    const width = Math.min(bounds?.width || 540, area.width)
    const height = Math.min(bounds?.height || 780, area.height)
    const window = new BrowserWindow({
      width, height, minWidth: 420, minHeight: 420,
      x: Math.max(area.x, Math.min(bounds?.x ?? area.x + area.width - width - 24, area.x + area.width - width)),
      y: Math.max(area.y, Math.min(bounds?.y ?? area.y + 40, area.y + area.height - height)),
      title: 'QA agent — Parity', show: false, resizable: true, minimizable: true, maximizable: true,
      autoHideMenuBar: true, backgroundColor: '#202124', titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#00000000', symbolColor: '#edefee', height: 38 },
      webPreferences: { preload: options.preload, contextIsolation: true, nodeIntegration: false, sandbox: false, webSecurity: true },
    })
    detached = window; window.setMenu(null)
    // This is an app surface, never an arbitrary external browser with privileged IPC.
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.on('will-redirect', event => event.preventDefault())
    window.on('close', () => { bounds = window.getNormalBounds() })
    window.on('closed', () => { if (detached === window) { detached = null; host()?.webContents.setBackgroundThrottling(true); notify() } })
    window.webContents.on('render-process-gone', () => window.destroy())
    host()?.webContents.setBackgroundThrottling(false)
    notify()
    try {
      if (options.rendererUrl) { const url = new URL(options.rendererUrl); url.searchParams.set('qaChat', '1'); await window.loadURL(url.toString()) }
      else await window.loadFile(options.rendererFile, { query: { qaChat: '1' } })
      if (!window.isDestroyed()) { window.show(); window.focus() }
      return true
    } catch (error) { if (!window.isDestroyed()) window.destroy(); throw error }
  })
  return {
    getWindow: () => detached,
    attachMainWindow(window: BrowserWindow) {
      const close = () => { snapshot = null; detached?.destroy() }
      window.on('closed', close); window.webContents.on('render-process-gone', close)
    },
  }
}
