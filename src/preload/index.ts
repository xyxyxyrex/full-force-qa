import { contextBridge, ipcRenderer } from 'electron'
import type { AutomateRunSummary, CaptureResult, FindingTriageMap, FindingTriageState, Project } from '../shared/types'

contextBridge.exposeInMainWorld('electronAPI', {
  login(adminUrl: string): Promise<void> {
    return ipcRenderer.invoke('auth:login', adminUrl)
  },
  mondayLogin(): Promise<{ success: boolean; token?: string; error?: string }> {
    return ipcRenderer.invoke('monday:login')
  },
  capture(url: string): Promise<CaptureResult> {
    return ipcRenderer.invoke('capture:start', url)
  },
  getProjects(): Promise<Project[]> {
    return ipcRenderer.invoke('projects:list')
  },
  saveProject(project: Project): Promise<void> {
    return ipcRenderer.invoke('projects:save', project)
  },
  deleteProject(id: string): Promise<void> {
    return ipcRenderer.invoke('projects:delete', id)
  },
  clearCache(): Promise<{ success: boolean }> {
    return ipcRenderer.invoke('app:clear-cache')
  },
  openExternal(url: string): Promise<void> {
    return ipcRenderer.invoke('app:openExternal', url)
  },
  openDetachedWindow(url: string, title?: string): Promise<void> {
    return ipcRenderer.invoke('app:openDetachedWindow', url, title)
  },
  figmaLoginWindow(url?: string): Promise<void> {
    return ipcRenderer.invoke('app:figmaLoginWindow', url)
  },
  figmaTokenStatus(): Promise<{ configured: boolean }> {
    return ipcRenderer.invoke('figma:token-status')
  },
  setFigmaToken(token: string): Promise<{ success: boolean; configured: boolean; error?: string }> {
    return ipcRenderer.invoke('figma:set-token', token)
  },
  listFigmaFrames(url: string): Promise<any> {
    return ipcRenderer.invoke('figma:list-frames', url)
  },
  getFigmaFrame(url: string, nodeId?: string): Promise<any> {
    return ipcRenderer.invoke('figma:get-frame', url, nodeId)
  },
  captureAutomatePage(webContentsId: number, viewportWidth: number, viewportHeight: number): Promise<any> {
    return ipcRenderer.invoke('automate:capture-page', webContentsId, viewportWidth, viewportHeight)
  },
  compareVisuals(jobId: string, designDataUrl: string, liveDataUrl: string, anchors?: any, mode?: string): Promise<any> {
    return ipcRenderer.invoke('automate:visual-compare', jobId, designDataUrl, liveDataUrl, anchors, mode)
  },
  cancelVisualComparison(jobId: string): Promise<{ success: boolean }> {
    return ipcRenderer.invoke('automate:visual-cancel', jobId)
  },
  getFindingTriage(projectId: string): Promise<FindingTriageMap> {
    return ipcRenderer.invoke('automate:triage-get', projectId)
  },
  setFindingTriage(projectId: string, findingId: string, state: FindingTriageState | null): Promise<{ success: boolean }> {
    return ipcRenderer.invoke('automate:triage-set', projectId, findingId, state)
  },
  saveAutomateRun(projectId: string, run: AutomateRunSummary): Promise<{ success: boolean }> {
    return ipcRenderer.invoke('automate:run-save', projectId, run)
  },
  getAutomateRuns(projectId: string, frameId: string): Promise<AutomateRunSummary[]> {
    return ipcRenderer.invoke('automate:run-list', projectId, frameId)
  },
  toggleMaximizeWindow(): Promise<void> {
    return ipcRenderer.invoke('app:toggleMaximizeWindow')
  },
  selectSnapshotDirectory(): Promise<{ success: boolean; path?: string }> {
    return ipcRenderer.invoke('settings:select-directory')
  },
  createSnapshot(params: any): Promise<any> {
    return ipcRenderer.invoke('snapshot:create', params)
  },
  getSnapshots(projectId: string): Promise<any> {
    return ipcRenderer.invoke('snapshot:list', projectId)
  },
  deleteSnapshot(snapshotId: string): Promise<any> {
    return ipcRenderer.invoke('snapshot:delete', snapshotId)
  },
  runGrammarSpellAudit(items: Array<{ id: string; tag: string; text: string; index: number }>): Promise<any> {
    return ipcRenderer.invoke('app:runGrammarSpellAudit', items)
  },
  onGlobalEscape(callback: () => void) {
    const handler = () => callback()
    ipcRenderer.on('global-escape-pressed', handler)
    return () => {
      ipcRenderer.removeListener('global-escape-pressed', handler)
    }
  }
})
