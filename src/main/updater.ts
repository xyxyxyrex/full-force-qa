import { app, type BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'
import type { AppUpdateStatus } from '../shared/types'

const { autoUpdater } = electronUpdater

let getMainWindow: (() => BrowserWindow | null) | null = null
let initialized = false
let updateStatus: AppUpdateStatus = { state: 'idle', currentVersion: app.getVersion() }

function cleanError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || 'Update failed.')
  return raw.replace(/https?:\/\/[^\s]+/g, '[update server]').slice(0, 300)
}

function publish(status: AppUpdateStatus): AppUpdateStatus {
  updateStatus = { ...status, currentVersion: app.getVersion() }
  const window = getMainWindow?.()
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send('app:update-status', updateStatus)
  }
  return updateStatus
}

export function getAppUpdateStatus(): AppUpdateStatus {
  return updateStatus
}

export async function checkForAppUpdates(): Promise<AppUpdateStatus> {
  if (!app.isPackaged) {
    return publish({
      state: 'not-available',
      currentVersion: app.getVersion(),
      message: 'Update checks are available in installed builds.',
    })
  }
  try {
    publish({ state: 'checking', currentVersion: app.getVersion() })
    await autoUpdater.checkForUpdates()
  } catch (error) {
    publish({ state: 'error', currentVersion: app.getVersion(), message: cleanError(error) })
  }
  return updateStatus
}

export async function downloadAppUpdate(): Promise<AppUpdateStatus> {
  if (!app.isPackaged) return checkForAppUpdates()
  try {
    if (updateStatus.state !== 'available') await autoUpdater.checkForUpdates()
    if (updateStatus.state === 'available') await autoUpdater.downloadUpdate()
  } catch (error) {
    publish({ state: 'error', currentVersion: app.getVersion(), message: cleanError(error) })
  }
  return updateStatus
}

export function installAppUpdate(): { success: boolean; error?: string } {
  if (updateStatus.state !== 'downloaded') {
    return { success: false, error: 'The update has not finished downloading.' }
  }
  setImmediate(() => autoUpdater.quitAndInstall(false, true))
  return { success: true }
}

export function initializeAppUpdater(windowProvider: () => BrowserWindow | null): void {
  getMainWindow = windowProvider
  if (initialized) return
  initialized = true

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false

  autoUpdater.on('checking-for-update', () => {
    publish({ state: 'checking', currentVersion: app.getVersion() })
  })
  autoUpdater.on('update-available', (info) => {
    publish({ state: 'available', currentVersion: app.getVersion(), version: info.version })
  })
  autoUpdater.on('update-not-available', (info) => {
    publish({ state: 'not-available', currentVersion: app.getVersion(), version: info.version })
  })
  autoUpdater.on('download-progress', (progress) => {
    publish({
      state: 'downloading',
      currentVersion: app.getVersion(),
      version: updateStatus.version,
      percent: Math.max(0, Math.min(100, progress.percent)),
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    publish({ state: 'downloaded', currentVersion: app.getVersion(), version: info.version })
  })
  autoUpdater.on('error', (error) => {
    publish({ state: 'error', currentVersion: app.getVersion(), message: cleanError(error) })
  })

  if (!app.isPackaged) return
  const initialCheck = setTimeout(() => void checkForAppUpdates(), 8_000)
  initialCheck.unref()
  const periodicCheck = setInterval(() => void checkForAppUpdates(), 6 * 60 * 60 * 1000)
  periodicCheck.unref()
}
