import { contextBridge, ipcRenderer } from 'electron'
import type { AppUpdateStatus, CaptureResult, FigmaConnectionStatus, MondayPublicConfig, NoteDocument, ParityAccountState, Project } from '../shared/types'

contextBridge.exposeInMainWorld('electronAPI', {
  login(adminUrl: string): Promise<void> {
    return ipcRenderer.invoke('auth:login', adminUrl)
  },
  mondayLogin(config: MondayPublicConfig) {
    return ipcRenderer.invoke('monday:login', config)
  },
  mondayStatus() {
    return ipcRenderer.invoke('monday:status')
  },
  mondaySetPersonalToken(token: string, config?: MondayPublicConfig) {
    return ipcRenderer.invoke('monday:set-personal-token', token, config)
  },
  mondayDisconnect(config?: MondayPublicConfig) {
    return ipcRenderer.invoke('monday:disconnect', config)
  },
  mondayGraphQL(query: string, variables?: Record<string, unknown>) {
    return ipcRenderer.invoke('monday:graphql', query, variables)
  },
  accountBootstrap() {
    return ipcRenderer.invoke('account:bootstrap')
  },
  accountSaveState(data: Partial<ParityAccountState>) {
    return ipcRenderer.invoke('account:save-state', data)
  },
  accountSaveNote(note: NoteDocument) {
    return ipcRenderer.invoke('account:save-note', note)
  },
  accountDeleteNote(noteId: string) {
    return ipcRenderer.invoke('account:delete-note', noteId)
  },
  saveNoteAttachment(input: { dataUrl: string; name: string }) {
    return ipcRenderer.invoke('notes:save-attachment', input)
  },
  deleteNoteAttachments(attachmentIds: string[]) {
    return ipcRenderer.invoke('notes:delete-attachments', attachmentIds)
  },
  openNoteAttachment(uri: string) {
    return ipcRenderer.invoke('notes:open-attachment', uri)
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
  figmaTokenStatus(validateApi?: boolean): Promise<FigmaConnectionStatus> {
    return ipcRenderer.invoke('figma:token-status', validateApi)
  },
  setFigmaToken(token: string): Promise<{ success: boolean; configured: boolean; error?: string }> {
    return ipcRenderer.invoke('figma:set-token', token)
  },
  onFigmaAuthChanged(callback: (status: FigmaConnectionStatus) => void) {
    const handler = (_event: Electron.IpcRendererEvent, status: FigmaConnectionStatus) => callback(status)
    ipcRenderer.on('figma:auth-changed', handler)
    return () => ipcRenderer.removeListener('figma:auth-changed', handler)
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
  runGrammarSpellAudit(items: Array<{ id: string; tag: string; text: string; index: number; path?: string }>): Promise<any> {
    return ipcRenderer.invoke('app:runGrammarSpellAudit', items)
  },
  getUpdateStatus(): Promise<AppUpdateStatus> {
    return ipcRenderer.invoke('app:update-status')
  },
  checkForUpdates(): Promise<AppUpdateStatus> {
    return ipcRenderer.invoke('app:update-check')
  },
  downloadUpdate(): Promise<AppUpdateStatus> {
    return ipcRenderer.invoke('app:update-download')
  },
  installUpdate(): Promise<{ success: boolean; error?: string }> {
    return ipcRenderer.invoke('app:update-install')
  },
  onUpdateStatus(callback: (status: AppUpdateStatus) => void) {
    const handler = (_event: Electron.IpcRendererEvent, status: AppUpdateStatus) => callback(status)
    ipcRenderer.on('app:update-status', handler)
    return () => ipcRenderer.removeListener('app:update-status', handler)
  },
  onGlobalEscape(callback: () => void) {
    const handler = () => callback()
    ipcRenderer.on('global-escape-pressed', handler)
    return () => {
      ipcRenderer.removeListener('global-escape-pressed', handler)
    }
  }
})
