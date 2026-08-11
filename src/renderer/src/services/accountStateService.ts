import type { AppSettings, ParityAccountState, ProjectFolder } from '../../../shared/types'
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../theme/themeSystem'
import { loadMondayPreferences } from '../utils/mondayApi'

let pendingPatch: Partial<ParityAccountState> = {}
let saveTimer: number | null = null
let syncReady = false

function scheduleSave(): void {
  if (!syncReady || saveTimer !== null || !Object.keys(pendingPatch).length) return
  saveTimer = window.setTimeout(async () => {
    const payload = pendingPatch
    pendingPatch = {}
    saveTimer = null
    const result = await window.electronAPI.accountSaveState(payload)
    if (!result.success) {
      pendingPatch = { ...payload, ...pendingPatch }
      window.dispatchEvent(new CustomEvent('parity:account-sync-error', { detail: result.error }))
    }
  }, 650)
}

export function setAccountStateSyncReady(ready: boolean, discardPending = false): void {
  syncReady = ready
  if (discardPending) pendingPatch = {}
  if (!ready && saveTimer !== null) {
    window.clearTimeout(saveTimer)
    saveTimer = null
  }
  scheduleSave()
}

function readArray<T>(key: string): T[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function collectLocalAccountState(settings: AppSettings = loadSettings()): ParityAccountState {
  const { snapshotDirectory: _deviceDirectory, ...portableSettings } = settings
  return {
    settings: portableSettings,
    folders: readArray<ProjectFolder>('qa_project_folders'),
    pinnedProjectIds: readArray<string>('pinned_project_ids'),
    activeTicketIds: readArray<string>('active_monday_ticket_ids'),
    mondayPreferences: loadMondayPreferences() || undefined,
    noteFolders: readArray('parity_note_folders'),
  }
}

export function resetLocalAccountState(): ParityAccountState {
  const deviceDirectory = loadSettings().snapshotDirectory
  const state: ParityAccountState = {
    settings: { ...DEFAULT_SETTINGS, snapshotDirectory: deviceDirectory },
    folders: [],
    pinnedProjectIds: [],
    activeTicketIds: [],
    noteFolders: [],
  }
  for (const key of ['qa_project_folders', 'pinned_project_ids', 'active_monday_ticket_ids', 'parity_note_folders', 'parity_monday_sync_preferences']) {
    localStorage.removeItem(key)
  }
  saveSettings({ ...DEFAULT_SETTINGS, snapshotDirectory: deviceDirectory })
  window.dispatchEvent(new CustomEvent('qa_folders_updated', { detail: [] }))
  window.dispatchEvent(new CustomEvent('qa_active_ticket_ids_updated', { detail: [] }))
  return state
}

export function applyCloudAccountState(state: ParityAccountState): AppSettings {
  if (Array.isArray(state.folders)) localStorage.setItem('qa_project_folders', JSON.stringify(state.folders))
  if (Array.isArray(state.pinnedProjectIds)) localStorage.setItem('pinned_project_ids', JSON.stringify(state.pinnedProjectIds))
  if (Array.isArray(state.activeTicketIds)) localStorage.setItem('active_monday_ticket_ids', JSON.stringify(state.activeTicketIds))
  if (state.mondayPreferences) localStorage.setItem('parity_monday_sync_preferences', JSON.stringify(state.mondayPreferences))
  if (Array.isArray(state.noteFolders)) localStorage.setItem('parity_note_folders', JSON.stringify(state.noteFolders))

  const settings = state.settings
    ? { ...loadSettings(), ...state.settings, snapshotDirectory: loadSettings().snapshotDirectory, hotkeys: { ...loadSettings().hotkeys, ...(state.settings.hotkeys || {}) } }
    : loadSettings()
  saveSettings(settings)
  if (Array.isArray(state.folders)) window.dispatchEvent(new CustomEvent('qa_folders_updated', { detail: state.folders }))
  if (Array.isArray(state.activeTicketIds)) window.dispatchEvent(new CustomEvent('qa_active_ticket_ids_updated', { detail: state.activeTicketIds }))
  window.dispatchEvent(new Event('parity:account-state-applied'))
  return settings
}

export function queueAccountStateSave(patch: Partial<ParityAccountState>): void {
  pendingPatch = { ...pendingPatch, ...patch }
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  saveTimer = null
  scheduleSave()
}
