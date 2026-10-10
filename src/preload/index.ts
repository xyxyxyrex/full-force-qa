import type { PixelComparisonResponse } from '../shared/automation'
import { contextBridge, ipcRenderer } from 'electron'
import type { AppUpdateStatus, CaptureResult, FigmaConnectionStatus, MondayPublicConfig, NoteDocument, ParityAccountState, Project } from '../shared/types'
import type { AuditCaptureContext, AuditExportProgress, AuditExportScanRequest, AuditMediaRequest } from '../shared/auditExport'
let accountGeneration = 0
ipcRenderer.on('account:changed', () => { accountGeneration++ })
const ownedInvoke = async (channel: string, ...args: unknown[]) => {
  const generation = accountGeneration
  const result = await ipcRenderer.invoke(channel, ...args)
  if (generation !== accountGeneration) throw new Error('The account changed. Try again.')
  return result
}
let chatScope:{ownerKey:string|null;generation:number}={ownerKey:null,generation:0}
const acceptChatScope=(value:import('../shared/qaChatWindow').QaChatWindowSnapshot|null)=>{if(value&&(value.generation||0)>=chatScope.generation)chatScope={ownerKey:value.ownerKey,generation:value.generation||0};return value}

contextBridge.exposeInMainWorld('electronAPI', {
  qaAgentQuota: (input: import('../shared/types').ElectronAPI['qaAgentQuota'] extends (input: infer I) => unknown ? I : never) => ownedInvoke('qa:agents:quota', input),
  workspaceSearch: (query: unknown) => ownedInvoke('workspace:search',query),
  workspaceSnapshot: (refresh?: boolean) => ownedInvoke('workspace:snapshot',refresh),
  workspaceMutate: (operations:unknown,owner:string) => ownedInvoke('workspace:mutate',operations,owner),
  workspacePropose: (operations: unknown,title: string) => ownedInvoke('workspace:propose',operations,title),
  workspaceApply: (id:string) => ownedInvoke('workspace:apply',id),
  workspaceCancel: (id:string) => ownedInvoke('workspace:cancel',id),
  workspaceRefresh: (id:string) => ownedInvoke('workspace:refresh',id),
  workspaceProposal: (id:string) => ownedInvoke('workspace:proposal',id),
  workspaceOpen: (target:unknown) => ownedInvoke('workspace:open',target),
  workspaceLocation: (location:unknown) => ipcRenderer.send('workspace:location',location),
  recordCaptureActivity: (activity:unknown,owner:string|null) => ownedInvoke('workspace:record-capture',activity,owner),
  onWorkspaceChanged: (callback:(value:any)=>void) => {const handler=(_event:Electron.IpcRendererEvent,value:any)=>callback(value);ipcRenderer.on('workspace:changed',handler);return()=>ipcRenderer.removeListener('workspace:changed',handler)},
  onWorkspaceNavigate: (callback:(value:any)=>void) => {const handler=(_event:Electron.IpcRendererEvent,value:any)=>callback(value);ipcRenderer.on('workspace:navigate',handler);return()=>ipcRenderer.removeListener('workspace:navigate',handler)},
  qaChatSelection: (id:string,selection:unknown) => ownedInvoke('qa:chat:selection',id,selection),
  qaWorkspaceCommand: (input:string) => ownedInvoke('qa:workspace-command',input),
  qaWindowDetach: () => ipcRenderer.invoke('qa:window:detach'),
  qaWindowDock: () => ipcRenderer.invoke('qa:window:dock'),
  qaWindowStatus: () => ipcRenderer.invoke('qa:window:status'),
  qaWindowReady: () => ipcRenderer.invoke('qa:window:ready').then(acceptChatScope),
  qaWindowSync: (snapshot: import('../shared/qaChatWindow').QaChatWindowSnapshot) => ipcRenderer.send('qa:window:sync', snapshot),
  qaWindowAction: (action: import('../shared/qaChatWindow').QaChatWindowAction) => ipcRenderer.send('qa:window:action', {...action,...chatScope}),
  onQaWindowChanged: (callback: (value: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: boolean) => callback(value)
    ipcRenderer.on('qa:window:changed', handler)
    return () => ipcRenderer.removeListener('qa:window:changed', handler)
  },
  onQaWindowSnapshot: (callback: (value: import('../shared/qaChatWindow').QaChatWindowSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: import('../shared/qaChatWindow').QaChatWindowSnapshot) => {acceptChatScope(value);callback(value)}
    ipcRenderer.on('qa:window:snapshot', handler)
    return () => ipcRenderer.removeListener('qa:window:snapshot', handler)
  },
  onQaWindowAction: (callback: (value: import('../shared/qaChatWindow').QaChatWindowAction) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: import('../shared/qaChatWindow').QaChatWindowAction) => callback(value)
    ipcRenderer.on('qa:window:action', handler)
    return () => ipcRenderer.removeListener('qa:window:action', handler)
  },
  siteAuthPending: () => ipcRenderer.invoke('site-auth:pending'),
  siteAuthRespond: (id: string, value: import('../shared/httpAuth').SiteCredentials | null) => ipcRenderer.invoke('site-auth:respond', id, value),
  onSiteAuthRequest: (callback: (request: import('../shared/httpAuth').SiteAuthRequest | null) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, request: import('../shared/httpAuth').SiteAuthRequest | null) => callback(request)
    ipcRenderer.on('site-auth:request', handler)
    return () => ipcRenderer.removeListener('site-auth:request', handler)
  },
  comparisonStatus: () => ipcRenderer.invoke('comparison:status'),
  comparisonInstall: (engine: import('../shared/crossBrowser').ComparisonEngine) => ipcRenderer.invoke('comparison:install', engine),
  comparisonOpenLogin: (engine: import('../shared/crossBrowser').ComparisonEngine, projectId: string, url: string) => ipcRenderer.invoke('comparison:open-login', engine, projectId, url),
  comparisonFinishLogin: (engine: import('../shared/crossBrowser').ComparisonEngine, projectId: string) => ipcRenderer.invoke('comparison:finish-login', engine, projectId),
  comparisonClearSession: (engine: import('../shared/crossBrowser').ComparisonEngine, projectId: string) => ipcRenderer.invoke('comparison:clear-session', engine, projectId),
  comparisonCapture: (input: import('../shared/crossBrowser').BrowserComparisonCapture) => ipcRenderer.invoke('comparison:capture', input),
  comparisonCancel: () => ipcRenderer.invoke('comparison:cancel'),
  comparisonList: (projectId: string) => ipcRenderer.invoke('comparison:list', projectId),
  comparisonLoad: (projectId: string, id: string) => ipcRenderer.invoke('comparison:load', projectId, id),
  comparisonSaveAnnotations: (projectId: string, id: string, annotations: import('../shared/crossBrowser').ComparisonAnnotation[]) => ipcRenderer.invoke('comparison:save-annotations', projectId, id, annotations),
  comparisonDelete: (projectId: string, id: string) => ipcRenderer.invoke('comparison:delete', projectId, id),
  comparisonExport: (projectId: string, id: string) => ipcRenderer.invoke('comparison:export', projectId, id),
  onComparisonProgress(callback: (progress: import('../shared/crossBrowser').BrowserComparisonProgress) => void) {
    const handler = (_event: Electron.IpcRendererEvent, progress: import('../shared/crossBrowser').BrowserComparisonProgress) => callback(progress)
    ipcRenderer.on('comparison:progress', handler)
    return () => ipcRenderer.removeListener('comparison:progress', handler)
  },
  onOpenCommandPalette: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('palette:open', handler)
    return () => { ipcRenderer.removeListener('palette:open', handler) }
  },
  inspectorStart: (input: { webContentsId: number; previewId: string; projectId?: string }) => ipcRenderer.invoke('inspector:start', input),
  inspectorStop: (sessionId: string) => ipcRenderer.invoke('inspector:stop', sessionId),
  inspectorReconnect: (sessionId: string) => ipcRenderer.invoke('inspector:reconnect', sessionId),
  inspectorChildren: (ref: import('../shared/inspector').InspectorNodeRef) => ipcRenderer.invoke('inspector:children', ref),
  inspectorResolveSelector: (sessionId: string, generation: number, selector: string) => ipcRenderer.invoke('inspector:resolve-selector', sessionId, generation, selector),
  inspectorGetNode: (ref: import('../shared/inspector').InspectorNodeRef) => ipcRenderer.invoke('inspector:get-node', ref),
  inspectorStyles: (ref: import('../shared/inspector').InspectorNodeRef) => ipcRenderer.invoke('inspector:styles', ref),
  inspectorHighlight: (ref: import('../shared/inspector').InspectorNodeRef | null, mode?: 'all' | 'content' | 'padding' | 'border' | 'margin') => ipcRenderer.invoke('inspector:highlight', ref, mode),
  inspectorScrollIntoView: (ref: import('../shared/inspector').InspectorNodeRef) => ipcRenderer.invoke('inspector:scroll-into-view', ref),
  inspectorSearch: (sessionId: string, generation: number, query: string, mode: 'text' | 'selector' | 'xpath', fromIndex?: number) => ipcRenderer.invoke('inspector:search', sessionId, generation, query, mode, fromIndex),
  inspectorDiscardSearch: (sessionId: string, searchId: string) => ipcRenderer.invoke('inspector:discard-search', sessionId, searchId),
  inspectorOuterHtml: (ref: import('../shared/inspector').InspectorNodeRef) => ipcRenderer.invoke('inspector:outer-html', ref),
  inspectorSelectorPath: (ref: import('../shared/inspector').InspectorNodeRef) => ipcRenderer.invoke('inspector:selector-path', ref),
  inspectorStyleSheetText: (sessionId: string, styleSheetId: string) => ipcRenderer.invoke('inspector:stylesheet-text', sessionId, styleSheetId),
  inspectorEditDom: (edit: import('../shared/inspector').InspectorDomEdit) => ipcRenderer.invoke('inspector:edit-dom', edit),
  inspectorEditDeclaration: (edit: import('../shared/inspector').InspectorDeclarationEdit) => ipcRenderer.invoke('inspector:edit-declaration', edit),
  inspectorEditSelector: (edit: import('../shared/inspector').InspectorSelectorEdit) => ipcRenderer.invoke('inspector:edit-selector', edit),
  inspectorAddRule: (ref: import('../shared/inspector').InspectorNodeRef, selector: string) => ipcRenderer.invoke('inspector:add-rule', ref, selector),
  inspectorForcePseudo: (ref: import('../shared/inspector').InspectorNodeRef, states: string[]) => ipcRenderer.invoke('inspector:force-pseudo', ref, states),
  inspectorSetLayoutOverlay: (ref: import('../shared/inspector').InspectorNodeRef, kind: 'flex' | 'grid' | 'none') => ipcRenderer.invoke('inspector:layout-overlay', ref, kind),
  inspectorUndo: (sessionId: string) => ipcRenderer.invoke('inspector:undo', sessionId),
  inspectorRedo: (sessionId: string) => ipcRenderer.invoke('inspector:redo', sessionId),
  inspectorHistory: (sessionId: string) => ipcRenderer.invoke('inspector:history', sessionId),
  inspectorPatches: (sessionId: string) => ipcRenderer.invoke('inspector:patches', sessionId),
  onInspectorEvent(callback: (event: import('../shared/inspector').InspectorEvent) => void) {
    const handler = (_event: Electron.IpcRendererEvent, inspectorEvent: import('../shared/inspector').InspectorEvent) => callback(inspectorEvent)
    ipcRenderer.on('inspector:event', handler)
    return () => ipcRenderer.removeListener('inspector:event', handler)
  },
  accountStatus: () => ipcRenderer.invoke('account:status'),
  accountLoginGoogle: () => ipcRenderer.invoke('account:login-google'),
  accountInitialize: (mode: 'new' | 'monday') => ipcRenderer.invoke('account:initialize', mode),
  accountSignOut: () => ipcRenderer.invoke('account:sign-out'),
  submitFeedback: (feedback: import('../shared/types').FeedbackSubmission) => ipcRenderer.invoke('feedback:submit', feedback),
  onAccountChanged(callback: () => void) {
    const handler = () => callback()
    ipcRenderer.on('account:changed', handler)
    return () => ipcRenderer.removeListener('account:changed', handler)
  },
  ticketsList: () => ownedInvoke('tickets:list'),
  ticketsSave: (ticket: import('../shared/types').Ticket, ownerKey: string) => ipcRenderer.invoke('tickets:save', ticket, ownerKey),
  ticketsSync: () => ipcRenderer.invoke('tickets:sync'),
  ticketsImportMonday: (tickets: import('../shared/types').Ticket[], connectionId: string, ownerKey: string) => ipcRenderer.invoke('tickets:import-monday', tickets, connectionId, ownerKey),
  ticketsRefreshFailed: (message: string, ownerKey: string) => ipcRenderer.invoke('tickets:refresh-failed', message, ownerKey),
  ticketsResolve: (id: string, choice: 'local' | 'remote', ownerKey: string) => ipcRenderer.invoke('tickets:resolve', id, choice, ownerKey),
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
    return ownedInvoke('account:bootstrap')
  },
  accountSaveState(data: Partial<ParityAccountState>, ownerKey: string) {
    return ipcRenderer.invoke('account:save-state', data, ownerKey)
  },
  accountSaveNote(note: NoteDocument, ownerKey: string) {
    return ipcRenderer.invoke('account:save-note', note, ownerKey)
  },
  accountDeleteNote(noteId: string, ownerKey: string) {
    return ipcRenderer.invoke('account:delete-note', noteId, ownerKey)
  },
  saveNoteAttachment(input: { dataUrl: string; name: string }, ownerKey: string) {
    return ipcRenderer.invoke('notes:save-attachment', input, ownerKey)
  },
  deleteNoteAttachments(attachmentIds: string[], ownerKey: string) {
    return ipcRenderer.invoke('notes:delete-attachments', attachmentIds, ownerKey)
  },
  openNoteAttachment(uri: string) {
    return ipcRenderer.invoke('notes:open-attachment', uri)
  },
  capture(url: string): Promise<CaptureResult> {
    return ipcRenderer.invoke('capture:start', url)
  },
  getProjects(): Promise<Project[]> {
    return ownedInvoke('projects:list')
  },
  saveProject(project: Project, ownerKey?: string | null): Promise<void> {
    return ipcRenderer.invoke('projects:save', project, ownerKey)
  },
  deleteProject(id: string, ownerKey?: string | null): Promise<void> {
    return ipcRenderer.invoke('projects:delete', id, ownerKey)
  },
  qaReportContext: (context: import('../shared/qaAgent').ReportedContext | null) => ipcRenderer.send('qa:report-context', context),
  qaCallTool: (name: string, args?: unknown) => ipcRenderer.invoke('qa:call-tool', name, args),
  qaApprovalDecision: (id: string, decision: import('../shared/qaAgent').ApprovalDecision) => ipcRenderer.invoke('qa:approval-decision', id, decision),
  onQaApprovalRequest: (callback: (request: import('../shared/qaAgent').ApprovalRequest) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, request: import('../shared/qaAgent').ApprovalRequest) => callback(request)
    ipcRenderer.on('qa:approval-request', handler)
    return () => { ipcRenderer.removeListener('qa:approval-request', handler) }
  },
  qaAgentsOverview: () => ipcRenderer.invoke('qa:agents:overview'),
  qaFindingsList: (projectKey?: string) => ownedInvoke('qa:findings:list', projectKey),
  qaFindingsUpdate: (projectKey: string, revision: number, changes: unknown) => ownedInvoke('qa:findings:update', projectKey, revision, changes),
  qaFindingsPicture: (projectKey: string, id: string, index?:number) => ownedInvoke('qa:findings:picture', projectKey, id, index),
  qaFindingsImport: (projectKey: string) => ownedInvoke('qa:findings:import', projectKey),
  qaFindingsCopy: (projectKey: string, ids: string[]) => ownedInvoke('qa:findings:copy', projectKey, ids),
  qaFindingsShare: (projectKey: string, ids: string[]) => ownedInvoke('qa:findings:share', projectKey, ids),
  onQaFindingsChanged: (callback: (event: { projectKey: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { projectKey: string }) => callback(payload)
    ipcRenderer.on('qa:findings:changed', handler)
    return () => ipcRenderer.removeListener('qa:findings:changed', handler)
  },
  qaAgentsSettings: () => ipcRenderer.invoke('qa:agents:settings'),
  qaAgentsSaveSettings: (patch: unknown) => ipcRenderer.invoke('qa:agents:save-settings', patch),
  qaAgentsSetKey: (id: string, key: string) => ipcRenderer.invoke('qa:agents:set-key', id, key),
  qaAgentsClearKey: (id: string) => ipcRenderer.invoke('qa:agents:clear-key', id),
  qaAgentsModels: (id: string) => ipcRenderer.invoke('qa:agents:models', id),
  qaExecutionStatus: () => ownedInvoke('qa:execution:status'),
  qaExecutionRetry: (id: string) => ownedInvoke('qa:execution:retry', id),
  qaExecutionResult: (id: string, offset?: number) => ownedInvoke('qa:execution:result', id, offset),
  qaRunStart: (options?: unknown) => ipcRenderer.invoke('qa:run:start', options),
  qaRunStop: () => ipcRenderer.invoke('qa:run:stop'),
  qaBatchStart: (options: unknown) => ipcRenderer.invoke('qa:batch:start', options),
  qaChatSend: (text: string, options?: unknown) => ownedInvoke('qa:chat:send', text, options),
  qaChatImagesAdd: (input: unknown) => ownedInvoke('qa:chat-images:add', input),
  qaChatImagesPicture: (chatId: string, id: string, full?: boolean) => ownedInvoke('qa:chat-images:picture', chatId, id, full),
  qaChatReset: () => ownedInvoke('qa:chat:reset'),
  qaChatsList: () => ownedInvoke('qa:chats:list'),
  qaChatsOpen: (id: string) => ownedInvoke('qa:chats:open', id),
  qaChatsSave: (chat: unknown) => ownedInvoke('qa:chats:save', chat),
  qaChatsDelete: (id: string) => ownedInvoke('qa:chats:delete', id),
  qaHistoryList: () => ownedInvoke('qa:history:list'),
  qaHistoryDetail: (id: string) => ownedInvoke('qa:history:detail', id),
  qaHistoryPicture: (id: string, ref: unknown) => ownedInvoke('qa:history:picture', id, ref),
  qaHistoryCopy: (id: string, stamp: string) => ownedInvoke('qa:history:copy', id, stamp),
  qaHistoryOpenFolder: (id: string) => ownedInvoke('qa:history:open-folder', id),
  qaHistoryPin: (id: string, pinned: boolean) => ownedInvoke('qa:history:pin', id, pinned),
  qaHistoryDelete: (id: string) => ownedInvoke('qa:history:delete', id),
  designsImage: (projectKey: string, breakpoint: string) => ownedInvoke('designs:image', projectKey, breakpoint),
  qaTarget: () => ownedInvoke('qa:target:get'),
  qaRunActive: () => ownedInvoke('qa:run:active'),
  onQaRunEvent: (callback: (event: import('../shared/qaAgent').QaRunEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: import('../shared/qaAgent').QaRunEvent) => callback(payload)
    ipcRenderer.on('qa:run:event', handler)
    return () => { ipcRenderer.removeListener('qa:run:event', handler) }
  },
  qaCliStatus: () => ipcRenderer.invoke('qa:cli:status'),
  qaCliInstall: () => ipcRenderer.invoke('qa:cli:install'),
  qaBridgeStatus: () => ipcRenderer.invoke('qa:bridge:status'),
  qaBridgeSetEnabled: (enabled: boolean) => ipcRenderer.invoke('qa:bridge:set-enabled', enabled),
  qaBridgeResetKey: () => ipcRenderer.invoke('qa:bridge:reset-key'),
  onQaBridgeStatus: (callback: (status: import('../shared/qaAgent').QaBridgeStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: import('../shared/qaAgent').QaBridgeStatus) => callback(status)
    ipcRenderer.on('qa:bridge:status-changed', handler)
    return () => { ipcRenderer.removeListener('qa:bridge:status-changed', handler) }
  },
  qaTrackerFormatGet: () => ipcRenderer.invoke('qa:tracker-format:get'),
  qaTrackerFormatSave: (text: string) => ipcRenderer.invoke('qa:tracker-format:save', text),
  qaTrackerFormatClear: () => ipcRenderer.invoke('qa:tracker-format:clear'),
  designsList: (projectKey: string) => ownedInvoke('designs:list', projectKey),
  designsPut: (projectKey: string, bytes: Uint8Array, options?: import('../shared/qaAgent').DesignPutOptions) => ownedInvoke('designs:put', projectKey, bytes, options),
  designsUpdate: (projectKey: string, breakpoint: import('../shared/designScale').Breakpoint, options: import('../shared/qaAgent').DesignUpdateOptions) => ownedInvoke('designs:update', projectKey, breakpoint, options),
  designsRemove: (projectKey: string, breakpoint: import('../shared/designScale').Breakpoint) => ownedInvoke('designs:remove', projectKey, breakpoint),
  loadWorkspaceHtml(tabId: string): Promise<string | null> {
    return ipcRenderer.invoke('workspace-html:load', tabId)
  },
  saveWorkspaceHtml(tabId: string, html: string): Promise<void> {
    return ipcRenderer.invoke('workspace-html:save', tabId, html)
  },
  deleteWorkspaceHtml(tabId: string): Promise<void> {
    return ipcRenderer.invoke('workspace-html:delete', tabId)
  },
  loadWorkspaceAuditContext(tabId: string): Promise<AuditCaptureContext | null> {
    return ipcRenderer.invoke('workspace-audit-context:load', tabId)
  },
  saveWorkspaceAuditContext(tabId: string, context: AuditCaptureContext): Promise<void> {
    return ipcRenderer.invoke('workspace-audit-context:save', tabId, context)
  },
  scanAuditExport(request: AuditExportScanRequest) {
    return ipcRenderer.invoke('audit-export:scan', request)
  },
  startAuditExport(planId: string) {
    return ipcRenderer.invoke('audit-export:start', planId)
  },
  cancelAuditExport(jobId: string) {
    return ipcRenderer.invoke('audit-export:cancel', jobId)
  },
  openAuditExportFolder(folderPath: string) {
    return ipcRenderer.invoke('audit-export:open-folder', folderPath)
  },
  onAuditExportProgress(callback: (progress: AuditExportProgress) => void) {
    const handler = (_event: Electron.IpcRendererEvent, progress: AuditExportProgress) => callback(progress)
    ipcRenderer.on('audit-export:progress', handler)
    return () => ipcRenderer.removeListener('audit-export:progress', handler)
  },
  previewAuditMedia(request: AuditMediaRequest) {
    return ipcRenderer.invoke('audit-media:preview', request)
  },
  saveAuditMedia(request: AuditMediaRequest) {
    return ipcRenderer.invoke('audit-media:save', request)
  },
  revealAuditMediaFile(filePath: string) {
    return ipcRenderer.invoke('audit-media:reveal', filePath)
  },
  clearCache(): Promise<{ success: boolean }> {
    return ipcRenderer.invoke('app:clear-cache')
  },
  getResourceFileSizes(urls: string[], refererUrl?: string) {
    return ipcRenderer.invoke('app:get-resource-file-sizes', urls, refererUrl)
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
  captureAutomatePage(webContentsId: number, viewportWidth: number, viewportHeight: number, allowHorizontalOverflow = false): Promise<any> {
    return ipcRenderer.invoke('automate:capture-page', webContentsId, viewportWidth, viewportHeight, allowHorizontalOverflow)
  },
  compareVisuals(jobId: string, designDataUrl: string, liveDataUrl: string): Promise<PixelComparisonResponse> {
    return ipcRenderer.invoke('automate:visual-compare', jobId, designDataUrl, liveDataUrl)
  },
  cancelVisualComparison(jobId: string): Promise<{ success: boolean }> {
    return ipcRenderer.invoke('automate:visual-cancel', jobId)
  },
  toggleMaximizeWindow(): Promise<void> {
    return ipcRenderer.invoke('app:toggleMaximizeWindow')
  },
  setTitleBarOverlay(symbolColor: string): Promise<void> {
    return ipcRenderer.invoke('app:set-title-bar-overlay', symbolColor)
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
