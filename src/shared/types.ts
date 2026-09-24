import type { PixelComparisonResponse, ResultState } from './automation'
import type { InspectorApi } from './inspector'
import type {
  AuditCaptureContext,
  AuditExportProgress,
  AuditExportResult,
  AuditExportScanRequest,
  AuditExportScanResult
} from './auditExport'
export interface CaptureResult {
  success: boolean
  html?: string
  auditContext?: AuditCaptureContext
  error?: string
  is404?: boolean
  isSessionExpired?: boolean
}

export interface ProjectAnnotation {
  id: string
  badgeNumber: number
  title: string
  notes: string
  color: string
  type?: 'box' | 'arrow' | 'rect' | 'circle' | 'pen' | 'text' | 'blur'
  elementPath?: string
  sourceFindingId?: string
  arrowPct?: { startX: number; startY: number; endX: number; endY: number }
  pointsPct?: Array<{ x: number; y: number }>
  coordinateSpace?: 'page'
  xPx?: number
  yPagePx?: number
  topPagePx?: number
  widthPx?: number
  heightPx?: number
  viewportWidth?: number
  viewportHeight?: number
  viewportKey?: string
  deviceFrameId?: string
  deviceName?: string
  deviceType?: 'desktop' | 'tablet' | 'mobile' | 'custom'
  /** The first annotation in a linked sequence. Present only for sequenced annotations. */
  sequenceParentId?: string
  /** Zero-based position within the parent annotation's sequence. */
  sequenceOrder?: number
  rectPct: { x: number; y: number; width: number; height: number }
}

export interface ProjectAnnotationSequence {
  parentAnnotationId: string
  annotationIds: string[]
}

export interface ProjectAutomateState {
  triage: FindingTriageMap
  runsByFrame: Record<string, AutomateRunSummary[]>
}

export interface ProjectWorkspaceData {
  annotations: ProjectAnnotation[]
  automate: ProjectAutomateState
}

export interface Project {
  /** Local IPC ownership guard; excluded from cloud documents. */
  localOwnerKey?: string | null
  id: string
  name: string
  adminUrl: string
  stagingUrl: string
  figmaUrl?: string
  googleSheetUrl?: string
  createdAt: number
  lastOpenedAt: number
  thumbnailUrl?: string
  inTrash?: boolean
  deletedAt?: number
  folderId?: string
  mondayTicketId?: string
  ticketRef?: TicketSourceRef
  workspaceData?: ProjectWorkspaceData
  updatedAt?: number
}

export interface ProjectFolder {
  id: string
  name: string
  parentId?: string
  createdAt: number
}

export interface ParityAccountUser {
  ownerKey: string
  authUserId?: string
  mondayUserId?: string
  name: string
  email?: string
}

export interface AccountStatus {
  signedIn: boolean
  needsSetup: boolean
  email?: string
  user?: ParityAccountUser
  error?: string
}

export type FeedbackKind = 'bug' | 'feature' | 'general'
export type FeedbackArea = 'dashboard' | 'edit' | 'live' | 'audit' | 'automate' | 'notes' | 'settings' | 'other'
export interface FeedbackSubmission {
  kind: FeedbackKind
  title: string
  details: string
  area: FeedbackArea
}
export interface FeedbackReceipt { id: string }

export type TicketProvider = 'monday' | 'opsmosis' | 'manual'
export type TicketQaStatus = 'To review' | 'In review' | 'Needs fixes' | 'Verified'
export interface TicketSourceRef {
  provider: TicketProvider
  connectionId: string
  externalId: string
  url?: string
  aliases?: string[]
}
export interface TicketProgress { active: boolean; qaStatus: TicketQaStatus }
export interface TicketResources {
  stagingUrl: string
  adminUrl: string
  figmaUrl?: string
  googleSheetUrl?: string
  otherLinks: Array<{ url: string; label: string }>
}
export interface Ticket {
  id: string
  source: TicketSourceRef
  title: string
  description: string
  sourceStatus: string
  sourceGroup: string
  assignees: Array<{ id: string; name: string }>
  resources: TicketResources
  progress: TicketProgress
  archived: boolean
  createdAt: number
  updatedAt: number
  sourceUpdatedAt?: string
}
export interface TicketRecord {
  ticket: Ticket
  revision: number
  pending: boolean
  conflict?: { ticket: Ticket; revision: number }
}
export interface TicketStoreSnapshot {
  ownerKey: string
  records: TicketRecord[]
  lastRefreshAt?: number
  refreshError?: string
  syncError?: string
}

export interface ParityAccountState {
  settings?: Partial<AppSettings>
  folders?: ProjectFolder[]
  pinnedProjectIds?: string[]
  activeTicketIds?: string[]
  mondayPreferences?: {
    boardIds: string[]
    assignmentMode: 'me' | 'all' | 'users'
    userIds: string[]
  }
  noteFolders?: NoteFolder[]
  updatedAt?: string
}

export interface NoteFolder {
  id: string
  name: string
  parentId?: string
  createdAt: number
}

export interface NoteAttachment {
  id: string
  name: string
  mimeType: string
  sizeBytes: number
  uri: string
  kind: 'image' | 'file'
}

export interface NoteDocument {
  id: string
  title: string
  contentHtml: string
  plainText: string
  folderId?: string
  tags: string[]
  pinned: boolean
  archived: boolean
  attachments: NoteAttachment[]
  createdAt: number
  updatedAt: number
  cloudUpdatedAt?: string
}

export interface ParityAccountBootstrap {
  connected: boolean
  user?: ParityAccountUser
  state?: ParityAccountState | null
  projects?: Project[]
  notes?: NoteDocument[]
  error?: string
}

export interface SnapshotItem {
  id: string
  projectId: string
  title: string
  type: 'image' | 'html'
  timestamp: number
  fileSizeBytes: number
  fileSizeFormatted: string
  dataUrl?: string
  url: string
  viewportWidth?: number
  viewportHeight?: number
}

export interface PageSection {
  name: string
  designY: number
  designHeight: number
  liveY: number
  liveHeight: number
  similarity: number
}

/**
 * A lightweight record of one Automate comparison — no images, no findings detail,
 * just enough to plot a page's conformance over time per breakpoint. Keyed by
 * frame id, not by design-file structure, so it survives a Figma restructure the
 * same way finding triage does.
 */
export interface AutomateRunSummary {
  id: string
  frameId: string
  frameName: string
  breakpoint: string
  captureWidth: number
  at: number
  severityCounts: { high: number; medium: number; low: number; pass: number }
  /** Legacy history only; new runs never calculate or display a score. */
  conformanceScore?: number
  resultCounts?: Record<ResultState, number>
  findingsCount: number
}

/**
 * Triage state for an Automate finding, keyed by the finding's stable id (not its
 * array index, and not a Figma node id) so it survives re-runs and file restructures.
 */
export type FindingTriageState = 'accepted' | 'false-positive' | 'ignored'
export interface FindingTriageEntry { state: FindingTriageState; at: number }
export type FindingTriageMap = Record<string, FindingTriageEntry>

export type AppTheme =
  | 'parity'
  | 'dark'
  | 'light'
  | 'catppuccin-mocha'
  | 'nord'
  | 'cyberpunk-gold'
  | 'tokyo-night'
  | 'dracula'
  | 'synthwave-84'
  | 'github-dark'
  | 'rose-pine'
  | 'monokai-pro'
  | 'gruvbox-dark'
  | 'solarized-dark'
  | 'emerald-abyss'
  | 'one-dark-pro'
  | 'sunset-crimson'
  | 'oled-black'
  | 'nord-deep'
  | 'catppuccin-latte'
  | 'rose-gold'
  | 'cyberpunk-neon'
  | 'midnight-amethyst'
  | 'emerald-forest'
  | 'cobalt-blue'
  | 'solarized-light'
  | 'sepia-paper'
  | 'ayu-dark'
  | 'palenight'
  | 'synthwave-neon'
  | 'horizon-dark'
  | 'dracula-vampire'
  | 'github-light'
  | 'monochrome-dark'
  | 'monochrome-light'
  | 'ocean-breeze'
  | 'amber-terminal'

export interface AppHotkeys {
  quickSave: string
  undo: string
  redo: string
  deselect: string
  panMode: string
  zoomIn: string
  zoomOut: string
  resetZoom: string
  toggleRulers: string
  toggleGuides: string
  toggleBoundaries: string
  cycleFontInspector: string
  toggleLeftPanel: string
  toggleBottomPanel: string
  toggleRightPanel: string
  viewportDesktop: string
  viewportTablet: string
  viewportMobile: string
  toggleCanvasMode: string
  workspaceEdit: string
  workspaceLive: string
  workspaceAudit: string
  workspaceAutomate: string
  toggleInteractionMode: string
  activateEyedropper: string
  toggleAnnotate: string
  annotationSelect: string
  annotationBox: string
  annotationArrow: string
  annotationRectangle: string
  annotationCircle: string
  annotationPen: string
  annotationText: string
  annotationBlur: string
  toggleRecording: string
  generateItems: string
}

export interface AppSettings {
  theme: AppTheme
  snapshotDirectory: string
  autoPurgeTrashDays: number
  captureDpiScale: number
  captureTimeoutMs: number
  defaultViewport: string
  mondaySyncIntervalMinutes: number
  hotkeys: AppHotkeys
}

export type AppUpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'not-available'
  | 'error'

export interface AppUpdateStatus {
  state: AppUpdateState
  currentVersion: string
  version?: string
  percent?: number
  message?: string
}

export interface MondayPublicConfig {
  supabaseUrl: string
  supabaseAnonKey: string
}

export interface MondayConnectionStatus {
  connected: boolean
  authType?: 'oauth' | 'personal'
  user?: { id: string; name: string; email?: string; accountId?: string }
  error?: string
}

export interface FigmaConnectionStatus {
  connected: boolean
  apiConfigured: boolean
  browserSession: boolean
  user?: { id?: string; handle?: string; email?: string; imgUrl?: string }
  error?: string
}

export interface ResourceFileSizeResult {
  url: string
  sizeBytes: number | null
  contentType?: string
}

export interface ElectronAPI extends InspectorApi {
  comparisonStatus: () => Promise<Record<import('./crossBrowser').ComparisonEngine, boolean>>
  comparisonInstall: (engine: import('./crossBrowser').ComparisonEngine) => Promise<void>
  comparisonOpenLogin: (engine: import('./crossBrowser').ComparisonEngine, projectId: string, url: string) => Promise<void>
  comparisonFinishLogin: (engine: import('./crossBrowser').ComparisonEngine, projectId: string) => Promise<void>
  comparisonClearSession: (engine: import('./crossBrowser').ComparisonEngine, projectId: string) => Promise<void>
  comparisonCapture: (input: import('./crossBrowser').BrowserComparisonCapture) => Promise<import('./crossBrowser').BrowserComparisonImage>
  comparisonCancel: () => Promise<void>
  comparisonList: (projectId: string) => Promise<import('./crossBrowser').BrowserComparison[]>
  comparisonLoad: (projectId: string, id: string) => Promise<import('./crossBrowser').BrowserComparisonImage>
  comparisonSaveAnnotations: (projectId: string, id: string, annotations: import('./crossBrowser').ComparisonAnnotation[]) => Promise<import('./crossBrowser').BrowserComparison>
  comparisonDelete: (projectId: string, id: string) => Promise<void>
  comparisonExport: (projectId: string, id: string) => Promise<string | null>
  onComparisonProgress: (callback: (progress: import('./crossBrowser').BrowserComparisonProgress) => void) => () => void
  accountStatus: () => Promise<AccountStatus>
  accountLoginGoogle: () => Promise<AccountStatus>
  accountInitialize: (mode: 'new' | 'monday') => Promise<AccountStatus>
  accountSignOut: () => Promise<void>
  onAccountChanged: (callback: () => void) => () => void
  submitFeedback: (feedback: FeedbackSubmission) => Promise<FeedbackReceipt>
  ticketsList: () => Promise<TicketStoreSnapshot>
  ticketsSave: (ticket: Ticket, ownerKey: string) => Promise<TicketStoreSnapshot>
  ticketsSync: () => Promise<TicketStoreSnapshot>
  ticketsImportMonday: (tickets: Ticket[], connectionId: string, ownerKey: string) => Promise<TicketStoreSnapshot>
  ticketsRefreshFailed: (message: string, ownerKey: string) => Promise<void>
  ticketsResolve: (id: string, choice: 'local' | 'remote', ownerKey: string) => Promise<TicketStoreSnapshot>
  login: (adminUrl: string) => Promise<void>
  mondayLogin: (config: MondayPublicConfig) => Promise<{ success: boolean; status?: MondayConnectionStatus; error?: string }>
  mondayStatus: () => Promise<MondayConnectionStatus>
  mondaySetPersonalToken: (token: string, config?: MondayPublicConfig) => Promise<{ success: boolean; status?: MondayConnectionStatus; error?: string }>
  mondayDisconnect: (config?: MondayPublicConfig) => Promise<{ success: boolean; error?: string }>
  mondayGraphQL: (query: string, variables?: Record<string, unknown>) => Promise<any>
  accountBootstrap: () => Promise<ParityAccountBootstrap>
  accountSaveState: (data: Partial<ParityAccountState>, ownerKey: string) => Promise<{ success: boolean; updatedAt?: string; error?: string }>
  accountSaveNote: (note: NoteDocument, ownerKey: string) => Promise<{ success: boolean; updatedAt?: string; error?: string }>
  accountDeleteNote: (noteId: string, ownerKey: string) => Promise<{ success: boolean; error?: string }>
  saveNoteAttachment: (input: { dataUrl: string; name: string }, ownerKey: string) => Promise<{ success: boolean; attachment?: NoteAttachment; error?: string }>
  deleteNoteAttachments: (attachmentIds: string[], ownerKey: string) => Promise<{ success: boolean; error?: string }>
  openNoteAttachment: (uri: string) => Promise<{ success: boolean; error?: string }>
  capture: (url: string) => Promise<CaptureResult>
  getProjects: () => Promise<Project[]>
  saveProject: (project: Project, ownerKey?: string | null) => Promise<void>
  deleteProject: (id: string, ownerKey?: string | null) => Promise<void>
  loadWorkspaceHtml: (tabId: string) => Promise<string | null>
  saveWorkspaceHtml: (tabId: string, html: string) => Promise<void>
  deleteWorkspaceHtml: (tabId: string) => Promise<void>
  loadWorkspaceAuditContext: (tabId: string) => Promise<AuditCaptureContext | null>
  saveWorkspaceAuditContext: (tabId: string, context: AuditCaptureContext) => Promise<void>
  scanAuditExport: (request: AuditExportScanRequest) => Promise<AuditExportScanResult>
  startAuditExport: (planId: string) => Promise<AuditExportResult>
  cancelAuditExport: (jobId: string) => Promise<{ success: boolean }>
  openAuditExportFolder: (folderPath: string) => Promise<{ success: boolean; error?: string }>
  onAuditExportProgress: (callback: (progress: AuditExportProgress) => void) => () => void
  previewAuditMedia: (request: import('./auditExport').AuditMediaRequest) => Promise<import('./auditExport').AuditMediaPreviewResult>
  saveAuditMedia: (request: import('./auditExport').AuditMediaRequest) => Promise<import('./auditExport').AuditMediaSaveResult>
  revealAuditMediaFile: (filePath: string) => Promise<{ success: boolean; error?: string }>
  clearCache: () => Promise<{ success: boolean }>
  getResourceFileSizes: (urls: string[], refererUrl?: string) => Promise<ResourceFileSizeResult[]>
  openExternal: (url: string) => Promise<void>
  openDetachedWindow: (url: string, title?: string) => Promise<void>
  figmaLoginWindow: (url?: string) => Promise<void>
  figmaTokenStatus: (validateApi?: boolean) => Promise<FigmaConnectionStatus>
  setFigmaToken: (token: string) => Promise<{ success: boolean; configured: boolean; error?: string }>
  onFigmaAuthChanged: (callback: (status: FigmaConnectionStatus) => void) => () => void
  listFigmaFrames: (url: string) => Promise<{ success: boolean; fileName?: string; lastModified?: string; requestedNodeId?: string; frames?: Array<{ id: string; name: string; type: string; pageName: string; path?: string; width: number; height: number }>; styleNames?: Record<string, string>; error?: string }>
  getFigmaFrame: (url: string, nodeId?: string) => Promise<{ success: boolean; node?: any; imageDataUrl?: string; error?: string }>
  captureAutomatePage: (webContentsId: number, viewportWidth: number, viewportHeight: number, allowHorizontalOverflow?: boolean) => Promise<{ success: boolean; dataUrl?: string; documentWidth?: number; documentHeight?: number; domNodes?: any[]; tiles?: number; mode?: string; error?: string; fallback?: boolean }>
  compareVisuals: (jobId: string, designDataUrl: string, liveDataUrl: string) => Promise<PixelComparisonResponse>
  cancelVisualComparison: (jobId: string) => Promise<{ success: boolean }>
  toggleMaximizeWindow: () => Promise<void>
  setTitleBarOverlay: (symbolColor: string) => Promise<void>
  selectSnapshotDirectory: () => Promise<{ success: boolean; path?: string }>
  createSnapshot: (params: {
    projectId: string
    url: string
    type: 'image' | 'html'
    title?: string
    htmlContent?: string
    dataUrl?: string
    viewportWidth?: number
    viewportHeight?: number
  }) => Promise<{ success: boolean; snapshot?: SnapshotItem; error?: string }>
  getSnapshots: (projectId: string) => Promise<SnapshotItem[]>
  deleteSnapshot: (snapshotId: string) => Promise<{ success: boolean }>
  runGrammarSpellAudit: (items: Array<{ id: string; tag: string; text: string; index: number; path?: string }>) => Promise<any>
  getUpdateStatus: () => Promise<AppUpdateStatus>
  checkForUpdates: () => Promise<AppUpdateStatus>
  downloadUpdate: () => Promise<AppUpdateStatus>
  installUpdate: () => Promise<{ success: boolean; error?: string }>
  onUpdateStatus: (callback: (status: AppUpdateStatus) => void) => () => void
  onGlobalEscape: (callback: () => void) => () => void
  onOpenCommandPalette: (callback: () => void) => () => void
}

