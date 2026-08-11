export interface CaptureResult {
  success: boolean
  html?: string
  error?: string
  is404?: boolean
  isSessionExpired?: boolean
}

export interface Project {
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
  updatedAt?: number
}

export interface ProjectFolder {
  id: string
  name: string
  createdAt: number
}

export interface ParityAccountUser {
  ownerKey: string
  mondayUserId: string
  name: string
  email?: string
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
  toggleRulers: string
  toggleBoundaries: string
  resetZoom: string
  deselect: string
  panMode: string
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

export interface ElectronAPI {
  login: (adminUrl: string) => Promise<void>
  mondayLogin: (config: MondayPublicConfig) => Promise<{ success: boolean; status?: MondayConnectionStatus; error?: string }>
  mondayStatus: () => Promise<MondayConnectionStatus>
  mondaySetPersonalToken: (token: string, config?: MondayPublicConfig) => Promise<{ success: boolean; status?: MondayConnectionStatus; error?: string }>
  mondayDisconnect: (config?: MondayPublicConfig) => Promise<{ success: boolean; error?: string }>
  mondayGraphQL: (query: string, variables?: Record<string, unknown>) => Promise<any>
  accountBootstrap: () => Promise<ParityAccountBootstrap>
  accountSaveState: (data: Partial<ParityAccountState>) => Promise<{ success: boolean; updatedAt?: string; error?: string }>
  accountSaveNote: (note: NoteDocument) => Promise<{ success: boolean; updatedAt?: string; error?: string }>
  accountDeleteNote: (noteId: string) => Promise<{ success: boolean; error?: string }>
  saveNoteAttachment: (input: { dataUrl: string; name: string }) => Promise<{ success: boolean; attachment?: NoteAttachment; error?: string }>
  deleteNoteAttachments: (attachmentIds: string[]) => Promise<{ success: boolean; error?: string }>
  openNoteAttachment: (uri: string) => Promise<{ success: boolean; error?: string }>
  capture: (url: string) => Promise<CaptureResult>
  getProjects: () => Promise<Project[]>
  saveProject: (project: Project) => Promise<void>
  deleteProject: (id: string) => Promise<void>
  clearCache: () => Promise<{ success: boolean }>
  openExternal: (url: string) => Promise<void>
  openDetachedWindow: (url: string, title?: string) => Promise<void>
  figmaLoginWindow: (url?: string) => Promise<void>
  figmaTokenStatus: () => Promise<FigmaConnectionStatus>
  setFigmaToken: (token: string) => Promise<{ success: boolean; configured: boolean; error?: string }>
  onFigmaAuthChanged: (callback: (status: FigmaConnectionStatus) => void) => () => void
  listFigmaFrames: (url: string) => Promise<{ success: boolean; fileName?: string; lastModified?: string; requestedNodeId?: string; frames?: Array<{ id: string; name: string; type: string; pageName: string; width: number; height: number }>; error?: string }>
  getFigmaFrame: (url: string, nodeId?: string) => Promise<{ success: boolean; node?: any; imageDataUrl?: string; error?: string }>
  captureAutomatePage: (webContentsId: number, viewportWidth: number, viewportHeight: number) => Promise<{ success: boolean; dataUrl?: string; documentWidth?: number; documentHeight?: number; domNodes?: any[]; tiles?: number; mode?: string; error?: string; fallback?: boolean }>
  compareVisuals: (jobId: string, designDataUrl: string, liveDataUrl: string, anchors?: Array<{ designY: number; liveY: number; confidence?: number }>, mode?: string) => Promise<{ success: boolean; engine?: string; similarity?: number; changedPercent?: number; heatmapDataUrl?: string; regions?: Array<{ x: number; y: number; width: number; height: number; difference: number }>; anchors?: Array<{ designY: number; liveY: number; confidence: number }>; error?: string; fallback?: boolean }>
  cancelVisualComparison: (jobId: string) => Promise<{ success: boolean }>
  toggleMaximizeWindow: () => Promise<void>
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
}

